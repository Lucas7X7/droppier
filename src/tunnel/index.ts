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

function spawnAndMatch(): never {
  throw new Error('unused')
}

async function ensureKey(keyPath: string): Promise<string> {
  if (!existsSync(keyPath)) {
    mkdirSync(resolve(keyPath, '..'), { recursive: true })
    const generated = await new Promise<string>((resolvePromise, rejectPromise) => {
      const child = spawn('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'hookline', '-f', keyPath])
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

async function openSshTunnel(options: TunnelOptions): Promise<Tunnel> {
  const keyPath = resolve(options.workdir, '.hookline', 'id_ed25519')
  const publicKey = await ensureKey(keyPath)
  const name = options.name ?? `hookline-${randomBytes(3).toString('hex')}`
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
  let buffer = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      options.onLog?.(`  ${trimmed}`)
      const match = /https:\/\/([A-Za-z0-9-]+)\.localhost\.run/.exec(trimmed)
      if (match) resolveUrl(`https://${match[1]}.localhost.run`)
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
  const url = await urlPromise.finally(() => clearTimeout(timeout))
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
  let buffer = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      options.onLog?.(`  ${trimmed}`)
      const match = /https:\/\/[A-Za-z0-9-]+\.trycloudflare\.com/.exec(trimmed)
      if (match) resolveUrl(match[0])
    }
  })
  child.stderr.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim()) options.onLog?.(`  ${line.trim()}`)
    }
  })
  const timeout = setTimeout(() => child.kill('SIGTERM'), 25_000)
  const url = await urlPromise.finally(() => clearTimeout(timeout))
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
        headers: options.token ? { 'x-hookline-token': options.token } : {},
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
                ? ' — the inbox is locked; pass --token (the token `hookline dev` printed) or set HOOKLINE_TOKEN'
                : status === 404
                  ? ' — no such event; ids can be abbreviated, try `hookline ls`'
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
