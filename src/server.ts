import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { DroppierConfig } from './config.ts'
import type { Store, NewEvent } from './store.ts'
import type { ListQuery, StoredEvent } from './types.ts'
import { detectProvider, verifySignature } from './verify.ts'
import { buildCurl, corruptSignatureValue, isSensitiveHeader, isSignatureHeader } from './curl.ts'
import { renderIndex, renderShare, renderNotFound } from './public/index.ts'

const INTERNAL_PREFIX = '/_droppier'
const MAX_BODY_BYTES = 5 * 1024 * 1024
const NOISE_PATHS = new Set(['/favicon.ico', '/robots.txt'])
const DAY_MS = 86_400_000
const RETENTION_SWEEP_MS = 60 * 60_000
const MAX_DELAY_MS = 30_000

export interface ServerDeps {
  config: DroppierConfig
  store: Store
  publicUrl: { current: string | null }
  onIngest?: (event: StoredEvent) => void
  log?: (line: string) => void
  /**
   * How often to enforce `config.retentionDays`. Exposed only so tests do not
   * have to wait an hour; production callers should leave it alone.
   */
  retentionSweepMs?: number
}

export interface DroppierServer {
  server: Server
  listen(port: number, host: string): Promise<string>
  close(): Promise<void>
  handleIngest(input: IngestInput): Promise<{ event: StoredEvent | null; status: number }>
  setPublicUrl(url: string): void
}

export interface IngestInput {
  method: string
  path: string
  query: string
  headers: Record<string, string>
  body: string
  remoteAddr: string
  status: number
  durationMs: number
  persist: boolean
  replayOf?: string | null
  note?: string | null
}

function flattenHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
  }
  return out
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        rejectPromise(new Error(`body exceeds ${limit} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectPromise)
  })
}

function tokenMatches(expected: string, provided: string | null): boolean {
  if (!provided) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(provided)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function authorized(config: DroppierConfig, url: URL, req: IncomingMessage): boolean {
  if (!config.token) return true
  const fromQuery = url.searchParams.get('t')
  if (fromQuery && tokenMatches(config.token, fromQuery)) return true
  const header = req.headers.authorization
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    if (tokenMatches(config.token, header.slice('Bearer '.length))) return true
  }
  const custom = req.headers['x-droppier-token']
  if (typeof custom === 'string' && tokenMatches(config.token, custom)) return true
  return false
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
  })
  res.end(html)
}

function parseListQuery(url: URL): ListQuery {
  const query: ListQuery = {}
  const limit = url.searchParams.get('limit')
  if (limit) query.limit = Number(limit)
  const before = url.searchParams.get('before')
  if (before) query.before = Number(before)
  const after = url.searchParams.get('after')
  if (after) query.after = Number(after)
  const q = url.searchParams.get('q')
  if (q) query.q = q
  const provider = url.searchParams.get('provider')
  if (provider) query.provider = provider
  const eventType = url.searchParams.get('type')
  if (eventType) query.eventType = eventType
  if (url.searchParams.get('dup') === '1') query.duplicatesOnly = true
  if (url.searchParams.get('invalid') === '1') query.invalidOnly = true
  return query
}

export function createDroppierServer(deps: ServerDeps): DroppierServer {
  const { config, store, publicUrl } = deps
  const log = deps.log ?? (() => {})
  const streams = new Set<ServerResponse>()
  let retentionTimer: NodeJS.Timeout | null = null

  /**
   * Enforce the retention window.
   *
   * This used to be config that nothing read: `retentionDays` defaulted to 7,
   * the banner printed "7d retention" and `droppier purge --before` existed,
   * but no code path ever deleted anything on its own. On a public URL that is
   * the difference between "stores payloads for a week" and "grows until the
   * disk fills", because ingest is unauthenticated by design and every stored
   * body is raw attacker-controllable bytes.
   */
  function sweepRetention(): number {
    const days = config.retentionDays
    if (days === null || !Number.isFinite(days) || days <= 0) return 0
    const removed = store.purge({ before: Date.now() - days * DAY_MS })
    if (removed > 0) log(`retention: purged ${removed} event(s) older than ${days}d`)
    return removed
  }

  function startRetentionSweep(): void {
    if (retentionTimer) return
    sweepRetention()
    retentionTimer = setInterval(sweepRetention, deps.retentionSweepMs ?? RETENTION_SWEEP_MS)
    // Never let the sweep be the reason the process refuses to exit.
    retentionTimer.unref()
  }

  function broadcast(event: StoredEvent): void {
    const payload = `event: event\ndata: ${JSON.stringify(event)}\n\n`
    for (const res of streams) res.write(payload)
  }

  function baseUrl(): string {
    return publicUrl.current ?? `http://${config.host}:${config.port}`
  }

  async function handleIngest(input: IngestInput): Promise<{ event: StoredEvent | null; status: number }> {
    const provider = detectProvider(input.headers)
    const verification = verifySignature({
      provider,
      headers: input.headers,
      rawBody: input.body,
      secrets: config.secrets,
      toleranceMs: config.toleranceMs,
      publicUrl: publicUrl.current ?? undefined,
    })
    if (!input.persist) {
      return { event: null, status: input.status }
    }
    const record: NewEvent = {
      receivedAt: Date.now(),
      provider,
      eventType: '',
      method: input.method,
      path: input.path,
      query: input.query,
      headers: input.headers,
      body: input.body,
      verdict: verification.verdict,
      signatureScheme: verification.scheme,
      signatureError: verification.error,
      status: input.status,
      durationMs: input.durationMs,
      remoteAddr: input.remoteAddr,
      replayOf: input.replayOf ?? null,
      note: input.note ?? null,
    }
    const event = store.append(record)
    deps.onIngest?.(event)
    broadcast(event)
    log(
      `${event.provider.padEnd(8)} ${event.eventType || '-'.padEnd(24)} ${event.verdict.padEnd(10)} ${event.path}`,
    )
    return { event, status: input.status }
  }

  const server = createServer((req, res) => {
    const started = Date.now()
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const path = decodeURIComponent(url.pathname)

    void (async () => {
      try {
        if (path === INTERNAL_PREFIX || path.startsWith(`${INTERNAL_PREFIX}/`)) {
          await handleInternal(req, res, url, path)
          return
        }

        // Any browser that opens the public url asks for these. They are never
        // webhooks, and storing them fills the inbox with `unknown
        // /favicon.ico unverified` noise the first time anyone looks at the
        // page in a browser.
        if (NOISE_PATHS.has(path)) {
          res.writeHead(204, { 'cache-control': 'public, max-age=86400' })
          res.end()
          return
        }

        const body = await readBody(req, MAX_BODY_BYTES)
        // The `__` escape hatches exist to let you rehearse a failure against
        // your own handler (force a 503, stall, skip the store) without
        // writing a second request by hand. They are deliberately inert unless
        // the caller is authorised: this is an unauthenticated endpoint by
        // design, and anyone who can reach the public url could otherwise make
        // droppier return 500 forever — which is precisely the retry storm the
        // tool is supposed to make visible — or pin a socket open for 30s.
        // With no token configured (`--tunnel none`, CI) there is nothing to
        // protect, so they stay open for local use.
        const trusted = authorized(config, url, req)
        const statusParam = trusted ? Number(url.searchParams.get('__status') ?? 200) : 200
        const delayParam = trusted ? Number(url.searchParams.get('__delay') ?? 0) : 0
        const persist = !trusted || url.searchParams.get('__no-store') !== '1'
        const status =
          Number.isInteger(statusParam) && statusParam >= 100 && statusParam <= 599
            ? statusParam
            : 200
        if (Number.isFinite(delayParam) && delayParam > 0) {
          await new Promise((r) => setTimeout(r, Math.min(delayParam, MAX_DELAY_MS)))
        }
        const { event } = await handleIngest({
          method: req.method ?? 'GET',
          path,
          query: url.searchParams.toString(),
          headers: flattenHeaders(req),
          body,
          remoteAddr: req.socket.remoteAddress ?? '',
          status,
          durationMs: Date.now() - started,
          persist,
        })
        const headers: Record<string, string> = {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        }
        if (event) {
          headers['x-droppier-id'] = event.id
          headers['x-droppier-verdict'] = event.verdict
          headers['x-droppier-provider'] = event.provider
        }
        const payload = event
          ? { ok: true, id: event.id, provider: event.provider, verdict: event.verdict }
          : { ok: true, stored: false }
        res.writeHead(status, headers)
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify(payload))
      } catch (error) {
        sendJson(res, 400, { ok: false, error: (error as Error).message })
      }
    })()
  })

  async function handleInternal(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    path: string,
  ): Promise<void> {
    const route = path.slice(INTERNAL_PREFIX.length) || '/'
    const method = req.method ?? 'GET'
    const isPublicShare = route.startsWith('/p/')

    if (route === '/healthz') {
      sendJson(res, 200, { ok: true, events: store.stats().total })
      return
    }

    if (isPublicShare) {
      const raw = route.slice('/p/'.length)
      const wantsJson = raw.endsWith('.json') || url.searchParams.get('format') === 'json'
      const id = raw.endsWith('.json') ? raw.slice(0, -'.json'.length) : raw
      const event = store.get(id)
      if (!event) {
        sendHtml(res, 404, renderNotFound())
        return
      }
      const redact = url.searchParams.get('raw') !== '1' || !authorized(config, url, req)
      if (wantsJson) {
        sendJson(res, 200, redact ? { ...event, headers: redactHeaders(event.headers) } : event)
        return
      }
      const view = redact ? { ...event, headers: redactHeaders(event.headers) } : event
      sendHtml(
        res,
        200,
        renderShare(view, {
          curl: buildCurl(event, { url: baseUrl(), redact }),
          redacted: redact
            ? Object.keys(event.headers).filter((name) => isSensitiveHeader(name)).length
            : 0,
        }),
      )
      return
    }

    if (!authorized(config, url, req)) {
      sendHtml(
        res,
        401,
        `<!doctype html><meta charset="utf-8"><title>droppier</title>
<body style="background:#0b0d10;color:#e6edf3;font:14px ui-monospace,monospace;padding:40px">
<p>🔒 locked.</p>
<p>Add your token: <code>?t=YOUR_TOKEN</code>, or send <code>Authorization: Bearer YOUR_TOKEN</code>.</p>
<p style="color:#8b949e">The token is printed by <code>droppier dev</code> and stored in <code>.droppier.json</code> as <code>token</code>.</p>`,
      )
      return
    }

    if (route === '/' || route === '/index.html') {
      sendHtml(
        res,
        200,
        renderIndex({
          token: config.token,
          publicUrl: baseUrl(),
          relayUrl: config.relayUrl,
          tunnel: config.tunnel,
          tokenGenerated: config.tokenGenerated,
        }),
      )
      return
    }

    if (route === '/api/stats') {
      sendJson(res, 200, { ...store.stats(), publicUrl: baseUrl() })
      return
    }

    if (route === '/api/config') {
      sendJson(res, 200, {
        publicUrl: baseUrl(),
        tunnel: config.tunnel,
        tokenGenerated: config.tokenGenerated,
        hasToken: Boolean(config.token),
        providers: Object.keys(config.secrets),
        toleranceMs: config.toleranceMs,
      })
      return
    }

    if (route === '/api/events') {
      if (method === 'DELETE') {
        const all = url.searchParams.get('all') === '1'
        const before = Number(url.searchParams.get('before') ?? 0)
        const removed = store.purge(all ? { all: true } : { before: before || Date.now() })
        sendJson(res, 200, { ok: true, removed })
        return
      }
      const { events, nextCursor } = store.list(parseListQuery(url))
      sendJson(res, 200, { events, nextCursor })
      return
    }

    if (route === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      streams.add(res)
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000)
      req.on('close', () => {
        clearInterval(heartbeat)
        streams.delete(res)
      })
      return
    }

    const eventMatch = /^\/api\/events\/([A-Za-z0-9]+)(\/[a-z]+)?$/.exec(route)
    if (eventMatch) {
      const requested = eventMatch[1]!
      const action = eventMatch[2]
      const event = store.get(requested) ?? (store.resolveId(requested) ? store.get(store.resolveId(requested)!)! : null)
      if (!event) {
        sendJson(res, 404, { ok: false, error: 'event not found' })
        return
      }
      if (action === '/curl') {
        const redact = url.searchParams.get('raw') !== '1'
        sendJson(res, 200, { curl: buildCurl(event, { url: baseUrl(), redact }) })
        return
      }
      if (action === '/replay' && method === 'POST') {
        const chaos = url.searchParams.get('chaos')
        const replayed = await replayEvent(event, chaos ?? null)
        sendJson(res, 200, { ok: true, event: replayed, chaos: chaos ?? 'none' })
        return
      }
      if (route === `/api/events/${requested}` && method === 'GET') {
        sendJson(res, 200, event)
        return
      }
    }

    sendJson(res, 404, { ok: false, error: 'not found' })
  }

  async function replayEvent(
    event: StoredEvent,
    chaos: string | null,
  ): Promise<StoredEvent | null> {
    const mutations: Record<string, { headers?: Record<string, string>; body?: string; note: string }> =
      {
        strip: { note: 'chaos: signature headers removed' },
        'strip-signature': {
          note: 'chaos: signature headers removed',
        },
        truncate: { body: event.body.slice(0, Math.max(1, Math.floor(event.body.length / 2))), note: 'chaos: body truncated' },
        mutate: { body: event.body.replace(/"amount":\s*\d+/, '"amount":999999'), note: 'chaos: amount mutated' },
        delay: { note: 'chaos: replayed with 2s delay' },
        corrupt: { note: 'chaos: signature corrupted' },
      }
    let mutation = chaos ? mutations[chaos] : undefined
    if (chaos && !mutation) {
      throw new Error(`unknown chaos mode: ${chaos} (${Object.keys(mutations).join(', ')})`)
    }
    const headers = { ...event.headers }
    if (chaos === 'strip' || chaos === 'strip-signature') {
      for (const name of Object.keys(headers)) {
        if (/(signature|hmac)/i.test(name)) delete headers[name]
      }
    }
    if (chaos === 'corrupt') {
      // Corrupt every signature header this event actually carries, whatever the
      // provider calls it. Only touching x-droppier-signature would silently do
      // nothing for stripe/github/slack/svix/shopify/twilio.
      let touched = 0
      for (const name of Object.keys(headers)) {
        if (!isSignatureHeader(name)) continue
        headers[name] = corruptSignatureValue(headers[name] ?? '')
        touched++
      }
      // No signature header at all: flip a body byte instead, which invalidates
      // any HMAC just as reliably.
      if (touched === 0 && event.body.length > 0) {
        mutation = { body: `${event.body.slice(0, -1)}X`, note: 'chaos: body byte flipped' }
      }
    }
    const delayMs = chaos === 'delay' ? 2000 : 0
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
    const { event: replayed } = await handleIngest({
      method: event.method,
      path: event.path,
      query: event.query,
      headers,
      body: mutation?.body ?? event.body,
      remoteAddr: 'replay',
      status: event.status,
      durationMs: event.durationMs,
      persist: true,
      replayOf: event.id,
      note: mutation?.note ?? 'replay',
    })
    return replayed
  }

  function redactHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [name, value] of Object.entries(headers)) {
      out[name] = /(signature|hmac|authorization|cookie)/i.test(name) ? '<redacted>' : value
    }
    return out
  }

  return {
    server,
    handleIngest,
    setPublicUrl(url: string): void {
      publicUrl.current = url
    },
    listen(port: number, host: string): Promise<string> {
      return new Promise((resolvePromise) => {
        server.listen(port, host, () => {
          const address = server.address()
          const actualPort = typeof address === 'object' && address ? address.port : port
          startRetentionSweep()
          resolvePromise(`http://${host}:${actualPort}`)
        })
      })
    },
    close(): Promise<void> {
      if (retentionTimer) {
        clearInterval(retentionTimer)
        retentionTimer = null
      }
      for (const res of streams) res.end()
      streams.clear()
      return new Promise((resolvePromise) => {
        server.close(() => resolvePromise())
      })
    },
  }
}
