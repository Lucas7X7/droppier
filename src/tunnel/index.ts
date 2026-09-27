import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { randomBytes } from 'node:crypto'
import { connectRelay, createLocalProxyHandler, type RelayClient } from './relay-client.ts'

export type TunnelKind = 'none' | 'ssh' | 'cloudflared' | 'relay'

export interface TunnelOptions {
  kind: TunnelKind
  port: number
  name: string | null
  relayUrl: string | null
  relayToken: string | null
  workdir: string
  onLog?: (line: string) => void
}

export interface Tunnel {
  url: string
  kind: TunnelKind
  persistent: boolean
  note: string | null
  close(): void
}

export function tunnelAvailable(kind: TunnelKind): boolean {
  if (kind === 'none' || kind === 'relay') return true
  return which(kind === 'ssh' ? 'ssh' : 'cloudflared') !== null
}

function which(binary: string): string | null {
  const dirs = (process.env.PATH ?? '').split(':')
  for (const dir of dirs) {
    if (!dir) continue
    const path = resolve(dir, binary)
    if (existsSync(path)) return path
  }
  return null
}

async function ensureKey(keyPath: string): Promise<string> {
  if (!existsSync(keyPath)) {
    mkdirSync(resolve(keyPath, '..'), { recursive: true })
    const generated = await new Promise<string>((resolvePromise, rejectPromise) => {
      const child = spawn('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'droppier', '-f', keyPath])
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      child.on('error', rejectPromise)
      child.on('exit', (code) =>
        code === 0
          ? resolvePromise(keyPath)
          : rejectPromise(new Error(`ssh-keygen failed: ${stderr.trim()}`)),
      )
    })
    if (!generated) throw new Error('ssh-keygen produced no key')
  }
  return readFileSync(`${keyPath}.pub`, 'utf8')
}

/**
 * Pull a public URL out of a tunnel log line.
 *
 * localhost.run hands out `*.lhr.life` as well as `*.localhost.run` (the
 * domain it prints changed at some point), so both have to be accepted — the
 * old single-domain regex silently never matched, and `dev` hung forever
 * waiting for a URL that had already been printed.
 */
export function parseTunnelUrl(line: string): string | null {
  // The url has to end the token: a documentation link like
  // https://admin.localhost.run/ is followed by a slash and more text, and
  // those lines are printed *before* the real tunnel line.
  const match =
    /https:\/\/([A-Za-z0-9-]+)\.(?:localhost\.run|lhr\.life|trycloudflare\.com)(?=[\s.,]|$)/.exec(line)
  if (!match) return null
  const host = match[1] ?? ''
  // localhost.run's own admin/docs subdomains are not tunnels.
  if (/^(admin|docs|www)$/i.test(host)) return null
  return match[0].replace(/[.,]+$/, '')
}

/** The part of a spawned tunnel process this guard needs; keeps it testable. */
interface Killable {
  // `any` here, not `never[]`: ChildProcess.once() is overloaded with
  // `(...args: any[]) => void` and is not assignable to a stricter signature.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  once(event: string, listener: (...args: any[]) => void): unknown
  kill(signal?: string | number): unknown
}

/**
 * Watch a tunnel child so `dev` can never hang or die silently.
 *
 * Three things used to go wrong: a URL that was never recognised left the
 * process awaiting forever, a child that exited early was never reported, and
 * (a bug of my own, caught by running it) the watchdog killed a perfectly
 * healthy tunnel 30s after start because nothing told it the URL had arrived.
 * `establish()` disarms the kill; after that an exit is only reported, never
 * fatal, because by then the tunnel is the user's only way in.
 */
export function tunnelGuard(
  child: Killable,
  kind: string,
  onLog?: (line: string) => void,
): { failure: Promise<never>; establish: () => void } {
  let established = false
  let rejectFailure: (error: Error) => void = () => {}
  const failure = new Promise<never>((_, rejectPromise) => {
    rejectFailure = rejectPromise
  })
  // Nothing should ever reject this promise; it exists so the guard's
  // internal bookkeeping cannot crash the process.
  void failure.catch(() => {})

  const report = (reason: string): void => {
    if (established) {
      onLog?.(`  ! tunnel (${kind}) ${reason} — the public url is dead, restart \`droppier dev\``)
      return
    }
    established = true
    child.kill('SIGTERM')
    rejectFailure(new Error(`tunnel (${kind}) ${reason}`))
  }

  child.once('exit', (code: number | null, signal: string | null) => {
    report(`exited before serving (code ${code ?? 'null'}, signal ${signal ?? 'none'})`)
  })
  child.once('error', (error: Error) => report(`failed to start: ${error.message}`))
  const timer = setTimeout(() => report('never reported a public url within 30s'), 30_000)
  timer.unref()

  return {
    failure,
    establish: () => {
      established = true
      clearTimeout(timer)
    },
  }
}

async function openSshTunnel(options: TunnelOptions): Promise<Tunnel> {
  const keyPath = resolve(options.workdir, '.droppier', 'id_ed25519')
  const publicKey = await ensureKey(keyPath)
  const name = options.name ?? `droppier-${randomBytes(3).toString('hex')}`
  const forward = options.name ? `${name}:80:127.0.0.1:${options.port}` : `80:127.0.0.1:${options.port}`
  const args = [
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ExitOnForwardFailure=yes',
    '-i',
    keyPath,
    '-R',
    forward,
    'nokey@localhost.run',
  ]
  let resolveUrl: (url: string) => void = () => {}
  const urlPromise = new Promise<string>((resolvePromise) => {
    resolveUrl = resolvePromise
  })
  const child = spawn('ssh', args)
  const guard = tunnelGuard(child, 'ssh', options.onLog)
  let buffer = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      options.onLog?.(`  ${trimmed}`)
      const url = parseTunnelUrl(trimmed)
      if (url) resolveUrl(url)
    }
  })
  child.stderr.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim()) options.onLog?.(`  ${line.trim()}`)
    }
  })
  const timeout = setTimeout(() => {
    child.kill('SIGTERM')
  }, 20_000)
  const url = await Promise.race([urlPromise, guard.failure]).finally(() => clearTimeout(timeout))
  guard.establish()
  return {
    url,
    kind: 'ssh',
    persistent: Boolean(options.name),
    note: options.name
      ? null
      : `sticky URL: paste this public key at https://localhost.run then rerun with --name <subdomain>\n    ${publicKey.trim().split('\n')[0]}`,
    close: () => child.kill('SIGTERM'),
  }
}

async function openCloudflaredTunnel(options: TunnelOptions): Promise<Tunnel> {
  const child = spawn('cloudflared', [
    'tunnel',
    '--no-autoupdate',
    '--url',
    `http://127.0.0.1:${options.port}`,
  ])
  let resolveUrl: (url: string) => void = () => {}
  const urlPromise = new Promise<string>((resolvePromise) => {
    resolveUrl = resolvePromise
  })
  const guard = tunnelGuard(child, 'cloudflared', options.onLog)
  let buffer = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      options.onLog?.(`  ${trimmed}`)
      const url = parseTunnelUrl(trimmed)
      if (url) resolveUrl(url)
    }
  })
  child.stderr.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim()) options.onLog?.(`  ${line.trim()}`)
    }
  })
  const timeout = setTimeout(() => child.kill('SIGTERM'), 25_000)
  const url = await Promise.race([urlPromise, guard.failure]).finally(() => clearTimeout(timeout))
  guard.establish()
  return {
    url,
    kind: 'cloudflared',
    persistent: false,
    note: 'quick tunnels get a random URL that changes on every restart',
    close: () => child.kill('SIGTERM'),
  }
}

async function openRelayTunnel(options: TunnelOptions): Promise<Tunnel> {
  if (!options.relayUrl) {
    throw new Error('--relay-url is required for --tunnel relay (see relay/README.md)')
  }
  const client: RelayClient = connectRelay({
    relayUrl: options.relayUrl,
    name: options.name,
    token: options.relayToken,
    onLog: options.onLog,
  })
  client.setHandler(createLocalProxyHandler(options.port))
  const url = await client.ready
  return {
    url,
    kind: 'relay',
    persistent: true,
    note: null,
    close: () => client.close(),
  }
}

export async function openTunnel(options: TunnelOptions): Promise<Tunnel | null> {
  switch (options.kind) {
    case 'none':
      return null
    case 'ssh':
      return openSshTunnel(options)
    case 'cloudflared':
      return openCloudflaredTunnel(options)
    case 'relay':
      return openRelayTunnel(options)
    default:
      throw new Error(`unknown tunnel kind: ${options.kind}`)
  }
}

export function requestJson(
  url: string,
  options: { method?: string; token?: string | null },
): Promise<unknown> {
  const target = new URL(url)
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolvePromise, rejectPromise) => {
    const req = send(
      target,
      {
        method: options.method ?? 'GET',
        headers: options.token ? { 'x-droppier-token': options.token } : {},
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed: unknown = text
          try {
            parsed = JSON.parse(text)
          } catch {
            // keep the raw text; the caller reports it
          }
          const status = res.statusCode ?? 0
          if (status >= 400) {
            const detail =
              typeof parsed === 'object' && parsed !== null && 'error' in parsed
                ? String((parsed as { error: unknown }).error)
                : text.slice(0, 200)
            const hint =
              status === 401
                ? ' — the inbox is locked; pass --token (the token `droppier dev` printed) or set DROPIER_TOKEN'
                : status === 404
                  ? ' — no such event; ids can be abbreviated, try `droppier ls`'
                  : ''
            rejectPromise(new Error(`${status} ${target.pathname}${detail ? `: ${detail}` : ''}${hint}`))
            return
          }
          resolvePromise(parsed)
        })
      },
    )
    req.on('error', rejectPromise)
    req.end()
  })
}

/**
 * Does this public url actually reach us?
 *
 * Found the hard way: the ssh process was still connected, but the tunnel had
 * already been dropped on the far end and every request to the "public" url
 * answered 503. Nothing said so. A tool whose only job is to hand you a working
 * url cannot afford to print one that does not work, quietly, for hours.
 *
 * `/_droppier/healthz` is used on purpose: it is served internally and never
 * stored as an event, so probing does not fill the inbox with our own noise.
 */
export function probePublicUrl(url: string, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolvePromise) => {
    let target: URL
    try {
      target = new URL('/_droppier/healthz', url)
    } catch {
      resolvePromise(false)
      return
    }
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolvePromise(ok)
    }
    const req = send(target, { method: 'GET' }, (res) => {
      const status = res.statusCode ?? 0
      res.resume()
      done(status >= 200 && status < 400)
    })
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      done(false)
    })
    req.on('error', () => done(false))
    req.end()
  })
}
