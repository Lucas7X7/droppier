#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadConfig, type HooklineConfig, type TunnelKind } from './config.ts'
import { openStore } from './store.ts'
import { createHooklineServer } from './server.ts'
import { openTunnel, requestJson, tunnelAvailable } from './tunnel/index.ts'
import { signPayload } from './verify.ts'
import { buildCurl } from './curl.ts'
import { formatBytes, timeAgo, formatTime } from './public/util.ts'
import { PROVIDERS, type Provider, type StoredEvent } from './types.ts'

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const paint = (code: string, text: string): string => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text)
const bold = (text: string): string => paint('1', text)
const dim = (text: string): string => paint('2', text)
const cyan = (text: string): string => paint('36', text)
const green = (text: string): string => paint('32', text)
const red = (text: string): string => paint('31', text)
const amber = (text: string): string => paint('33', text)
const purple = (text: string): string => paint('35', text)

const VERDICT_COLOR: Record<string, (text: string) => string> = {
  valid: green,
  invalid: red,
  stale: amber,
  unverified: dim,
}

interface Args {
  command: string
  positional: string[]
  flags: Record<string, string | boolean>
}

function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv
  // `hookline dev --help` must print help, not start a tunnel. Checked before
  // anything is parsed, because `dev` is the command most likely to be probed.
  if (rest.includes('--help') || rest.includes('-h')) {
    return { command: 'help', flags: {}, positional: [] }
  }
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index]!
    if (!token.startsWith('-')) {
      positional.push(token)
      continue
    }
    const name = token.replace(/^--?/, '')
    const next = rest[index + 1]
    if (next !== undefined && !next.startsWith('-')) {
      flags[name] = next
      index++
    } else {
      flags[name] = true
    }
  }
  return { command, positional, flags }
}

function flagString(args: Args, name: string): string | undefined {
  const value = args.flags[name]
  return typeof value === 'string' ? value : undefined
}

function flagNumber(args: Args, name: string): number | undefined {
  const value = flagString(args, name)
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function configFrom(args: Args): HooklineConfig {
  const overrides: Partial<HooklineConfig> = {}
  const port = flagNumber(args, 'port')
  if (port !== undefined) overrides.port = port
  const host = flagString(args, 'host')
  if (host) overrides.host = host
  const db = flagString(args, 'db')
  if (db) overrides.db = db
  const token = flagString(args, 'token')
  if (token) overrides.token = token
  const publicUrl = flagString(args, 'public-url')
  if (publicUrl) overrides.publicUrl = publicUrl
  const tunnel = flagString(args, 'tunnel') as TunnelKind | undefined
  if (tunnel) overrides.tunnel = tunnel
  const tunnelName = flagString(args, 'name')
  if (tunnelName) overrides.tunnelName = tunnelName
  const relayUrl = flagString(args, 'relay-url')
  if (relayUrl) overrides.relayUrl = relayUrl
  const relayToken = flagString(args, 'relay-token')
  if (relayToken) overrides.relayToken = relayToken
  const tolerance = flagNumber(args, 'tolerance')
  if (tolerance !== undefined) overrides.toleranceMs = tolerance
  const retention = flagNumber(args, 'retention')
  if (retention !== undefined) overrides.retentionDays = retention
  const secret = flagString(args, 'secret')
  if (secret) {
    const provider = flagString(args, 'provider') ?? 'generic'
    overrides.secrets = { ...overrides.secrets, [provider]: secret }
  }
  return loadConfig(process.cwd(), overrides)
}

function banner(config: HooklineConfig, localUrl: string, tunnel: {
  url: string
  kind: string
  note: string | null
} | null): void {
  const publicUrl = tunnel?.url ?? config.publicUrl ?? localUrl
  const inboxUrl = config.token ? `${localUrl}/_hookline?t=${config.token}` : `${localUrl}/_hookline`
  const lines = [
    '',
    `  ${bold(cyan('hookline'))} ${dim('· inbox for webhooks you can actually debug')}`,
    '',
    `  ${dim('public  ')} ${green(publicUrl)}`,
    `  ${dim('inbox   ')} ${cyan(inboxUrl)}`,
    `  ${dim('db      ')} ${dim(config.db)}${config.retentionDays ? dim(` (${config.retentionDays}d retention)`) : ''}`,
    `  ${dim('secrets ')} ${
      Object.keys(config.secrets).length > 0
        ? Object.keys(config.secrets).map((provider) => purple(provider)).join(dim(', '))
        : dim('none — every event will show as unverified')
    }`,
  ]
  if (tunnel) {
    lines.push(`  ${dim('tunnel  ')} ${dim(tunnel.kind)}${tunnel.note ? dim(` · ${tunnel.note}`) : ''}`)
  }
  if (config.tokenGenerated) {
    lines.push('', `  ${amber('!')} a token was generated because a tunnel is public — share it carefully`)
  }
  lines.push('', `  ${dim('paste the public url into your provider dashboard, then watch it land here')}`, '')
  process.stdout.write(`${lines.join('\n')}\n`)
}

async function commandDev(args: Args): Promise<void> {
  const config = configFrom(args)
  const store = openStore(config.db)
  const publicUrl = { current: config.publicUrl }
  const server = createHooklineServer({
    config,
    store,
    publicUrl,
    log: (line) => process.stdout.write(`  ${dim('·')} ${line}\n`),
  })
  const localUrl = await server.listen(config.port, config.host)
  server.setPublicUrl(localUrl)

  let tunnel: Awaited<ReturnType<typeof openTunnel>> = null
  if (config.tunnel !== 'none') {
    if (!tunnelAvailable(config.tunnel)) {
      process.stdout.write(
        `  ${amber('!')} ${config.tunnel} tunnel unavailable (missing ${config.tunnel === 'ssh' ? 'ssh' : config.tunnel}); running local only\n`,
      )
    } else {
      try {
        tunnel = await openTunnel({
          kind: config.tunnel,
          port: config.port,
          name: config.tunnelName,
          relayUrl: config.relayUrl,
          relayToken: config.relayToken,
          workdir: config.workdir,
          onLog: (line) => process.stdout.write(`  ${dim('·')} ${dim(line)}\n`),
        })
        if (tunnel) {
          server.setPublicUrl(tunnel.url)
          publicUrl.current = tunnel.url
        }
      } catch (error) {
        process.stdout.write(`  ${amber('!')} tunnel failed: ${(error as Error).message}\n`)
      }
    }
  }

  banner(config, localUrl, tunnel ? { url: tunnel.url, kind: tunnel.kind, note: tunnel.note } : null)

  const shutdown = async (): Promise<void> => {
    process.stdout.write(`\n  ${dim('shutting down…')}\n`)
    tunnel?.close()
    await server.close()
    store.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

function openLocalStore(config: HooklineConfig) {
  return openStore(config.db)
}

function eventRow(event: StoredEvent, now: number): string {
  const verdict = (VERDICT_COLOR[event.verdict] ?? dim)(event.verdict.padEnd(10))
  const dup = event.duplicateOf ? amber('dup') : dim('·')
  const replay = event.replayOf ? cyan('replay') : dim('·')
  return [
    dim(event.id),
    dim(timeAgo(event.receivedAt, now).padStart(5)),
    formatTime(event.receivedAt),
    paintProvider(event.provider),
    dim(event.eventType || event.path).padEnd(28).slice(0, 28),
    verdict,
    `${dup} ${replay}`,
    dim(formatBytes(event.size).padStart(7)),
  ].join(' ')
}

function paintProvider(provider: string): string {
  const padded = provider.slice(0, 7).padEnd(7)
  if (provider === 'stripe') return purple(padded)
  if (provider === 'github') return bold(padded)
  if (provider === 'slack') return amber(padded)
  if (provider === 'unknown') return dim(padded)
  return cyan(padded)
}

function commandLs(args: Args): void {
  const config = configFrom(args)
  const store = openLocalStore(config)
  const { events } = store.list({
    limit: flagNumber(args, 'limit') ?? 30,
    q: flagString(args, 'q'),
    provider: flagString(args, 'provider'),
    duplicatesOnly: Boolean(args.flags.dup),
    invalidOnly: Boolean(args.flags.invalid),
  })
  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify({ events }, null, 2)}\n`)
    store.close()
    return
  }
  const now = Date.now()
  process.stdout.write(
    `${dim('  id                     age  time   provider event                       verdict     marks      size\n')}`,
  )
  for (const event of events) process.stdout.write(`  ${eventRow(event, now)}\n`)
  if (events.length === 0) process.stdout.write(`  ${dim('inbox is empty — start `hookline dev`')}\n`)
  store.close()
}

function commandShow(args: Args): void {
  const config = configFrom(args)
  const input = args.positional[0]
  if (!input) throw new Error('usage: hookline show <id>')
  const store = openLocalStore(config)
  const id = store.resolveId(input) ?? input
  const event = store.get(id)
  if (!event) {
    store.close()
    throw new Error(`no event ${input} in ${config.db} (ids can be abbreviated)`)
  }
  const publicUrl = config.publicUrl ?? `http://${config.host}:${config.port}`
  const rows: Array<[string, string]> = [
    ['id', event.id],
    ['received', `${new Date(event.receivedAt).toISOString()} (${timeAgo(event.receivedAt)} ago)`],
    ['provider', event.provider],
    ['event', event.eventType || '—'],
    [
      'signature',
      `${(VERDICT_COLOR[event.verdict] ?? dim)(event.verdict)} ${dim(`[${event.signatureScheme}]`)}${
        event.signatureError ? dim(` — ${event.signatureError}`) : ''
      }`,
    ],
    ['request', `${event.method} ${event.path}${event.query ? `?${event.query}` : ''}`],
    ['size', formatBytes(event.size)],
    ['from', event.remoteAddr || '—'],
  ]
  if (event.duplicateOf) rows.push(['duplicate of', event.duplicateOf])
  if (event.replayOf) rows.push(['replay of', event.replayOf])
  if (event.note) rows.push(['note', event.note])
  rows.push(['share', `${publicUrl}/_hookline/p/${event.id}`])
  for (const [label, value] of rows) {
    process.stdout.write(`  ${dim(label.padEnd(12))} ${value}\n`)
  }
  process.stdout.write(`\n  ${dim('headers')}\n`)
  for (const [name, value] of Object.entries(event.headers).sort()) {
    process.stdout.write(`    ${dim(name.padEnd(22))} ${value}\n`)
  }
  process.stdout.write(`\n  ${dim('curl')}\n`)
  process.stdout.write(
    `${buildCurl(event, { url: publicUrl, redact: false })
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n')}\n`,
  )
  store.close()
}

async function commandReplay(args: Args): Promise<void> {
  const config = configFrom(args)
  const id = args.positional[0]
  if (!id) throw new Error('usage: hookline replay <id> [--chaos strip|truncate|mutate|corrupt|delay]')
  const base = flagString(args, 'url') ?? `http://${config.host}:${config.port}`
  const chaos = flagString(args, 'chaos')
  const path = `/_hookline/api/events/${id}/replay${chaos ? `?chaos=${chaos}` : ''}`
  const result = (await requestJson(`${base}${path}`, {
    method: 'POST',
    token: config.token,
  })) as { ok?: boolean; error?: string; event?: StoredEvent }
  if (!result.ok) throw new Error(result.error ?? `replay failed: ${JSON.stringify(result)}`)
  const event = result.event
  process.stdout.write(
    `  ${green('replayed')} ${dim(id)}${chaos ? ` ${amber('chaos:' + chaos)}` : ''} → ${
      event ? `${event.id} ${dim('(verdict ' + event.verdict + ')')}` : 'stored'
    }\n`,
  )
}

function commandStats(args: Args): void {
  const config = configFrom(args)
  const store = openLocalStore(config)
  const stats = store.stats()
  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`)
    store.close()
    return
  }
  process.stdout.write(
    [
      `  ${bold(String(stats.total))} events   ${bold(String(stats.duplicates))} duplicates   ${
        stats.invalid > 0 ? red(String(stats.invalid) + ' invalid') : green('0 invalid')
      }   ${dim(formatBytes(stats.bytes))}`,
      '',
      ...stats.byProvider.map(
        (row) => `  ${paintProvider(row.provider)} ${String(row.count).padStart(6)}`,
      ),
      '',
      `  ${dim('last event')}${stats.lastEventAt ? ` ${timeAgo(stats.lastEventAt)} ago` : ' never'}`,
      '',
    ].join('\n'),
  )
  store.close()
}

function commandPurge(args: Args): void {
  const config = configFrom(args)
  const store = openLocalStore(config)
  const all = Boolean(args.flags.all)
  const beforeValue = flagString(args, 'before')
  const before = beforeValue ? new Date(beforeValue).getTime() : Date.now()
  if (Number.isNaN(before)) throw new Error(`invalid --before date: ${beforeValue}`)
  const removed = store.purge(all ? { all: true } : { before })
  process.stdout.write(`  ${green('purged')} ${removed} event(s)\n`)
  store.close()
}

function commandSign(args: Args): void {
  const provider = (flagString(args, 'provider') ?? 'generic') as Provider
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`unknown provider: ${provider} (expected ${PROVIDERS.join(', ')})`)
  }
  const secret = flagString(args, 'secret')
  if (!secret) throw new Error('--secret is required (this is the secret you would set in the provider)')
  const file = flagString(args, 'file') ?? args.positional[0]
  const body = file
    ? existsSync(file)
      ? readFileSync(file, 'utf8')
      : (() => {
          throw new Error(`file not found: ${file}`)
        })()
    : (flagString(args, 'body') ?? '{"hello":"world"}')
  const url = flagString(args, 'url') ?? 'http://127.0.0.1:4000/stripe'
  const timestamp = flagNumber(args, 'timestamp') ?? Date.now()
  const headers = signPayload({ provider, secret, rawBody: body, timestamp, url })
  const target = new URL(url)
  const event = {
    method: 'POST',
    path: target.pathname,
    query: target.search.replace(/^\?/, ''),
    headers: { host: target.host, ...headers },
    body,
  }
  process.stdout.write(`${buildCurl(event, { url: target.origin, redact: false })}\n`)
  process.stdout.write(
    dim(`\n# ${provider} signature is valid for this exact body; re-running sign produces a new timestamp\n`),
  )
}

const HELP = `${bold('hookline')} ${dim('· a stable public URL for webhooks, with an inbox')}

${bold('usage')}
  hookline dev [options]            start the inbox and expose a public URL
  hookline ls [options]             list captured events
  hookline show <id>                print one event, its headers and a replayable curl
  hookline replay <id> [--chaos m]  re-send an event, optionally mutated
  hookline stats                    counts by provider, duplicates, invalid signatures
  hookline sign --provider p ...    print a correctly signed curl for any provider
  hookline purge [--all|--before d] delete stored events
  hookline relay                    run the self-hosted public relay

${bold('common options')}
  --db <path>             sqlite file to read (ls, show, replay, stats, purge)
  --json                  machine-readable output (ls, stats)
  --limit <n>             rows for ls (default 30)
  --q <text>              search bodies, headers and event types
  --provider <name>       filter by provider
  --dup                   only duplicates (ls)
  --invalid               only invalid or unverified (ls)

${bold('dev options')}
  --port <n>              local port (default 4000)
  --db <path>             sqlite file (default .hookline/inbox.db)
  --tunnel <kind>         none | ssh | cloudflared | relay   (default ssh)
  --name <subdomain>      claim a sticky subdomain (ssh) or relay name
  --relay-url <url>       relay base url, required for --tunnel relay
  --relay-token <token>   relay token
  --public-url <url>      override the url used for twilio verification and curl
  --secret <value>        secret for --provider, sets signature verification
  --provider <name>       stripe | github | slack | svix | shopify | twilio | generic
  --tolerance <ms>        signature timestamp tolerance (default 300000)
  --retention <days>      auto-purge window (default 7)
  --token <value>         ui/api token; generated automatically when a tunnel is on

${bold('environment')}
  HOOKLINE_PORT, HOOKLINE_TOKEN, HOOKLINE_DB, HOOKLINE_PUBLIC_URL, HOOKLINE_TUNNEL,
  HOOKLINE_TUNNEL_NAME, HOOKLINE_RELAY_URL, HOOKLINE_RELAY_TOKEN, HOOKLINE_RETENTION_DAYS,
  HOOKLINE_SECRET_<PROVIDER>   e.g. HOOKLINE_SECRET_STRIPE=whsec_…

${bold('config')}
  .hookline.json in the project root, gitignored by default. See examples/hookline.json.
`

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  try {
    switch (args.command) {
      case 'dev':
        await commandDev(args)
        break
      case 'ls':
      case 'list':
        commandLs(args)
        break
      case 'show':
        commandShow(args)
        break
      case 'replay':
        await commandReplay(args)
        break
      case 'stats':
        commandStats(args)
        break
      case 'purge':
        commandPurge(args)
        break
      case 'sign':
        commandSign(args)
        break
      case 'relay':
        await import('../relay/server.ts')
        break
      case 'help':
      case '--help':
      case '-h':
        process.stdout.write(HELP)
        break
      default:
        process.stderr.write(`unknown command: ${args.command}\n\n${HELP}`)
        process.exit(1)
    }
  } catch (error) {
    process.stderr.write(`${red('error')} ${(error as Error).message}\n`)
    process.exit(1)
  }
}

void main()
