import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { NdjsonParser, encodeMessage, RELAY_CLIENT_PING_MS } from '../src/relay-protocol.ts'
import type { RelayServerMessage } from '../src/relay-protocol.ts'

type WireMessage = {
  type?: string
  id?: string
  status?: number
  headers?: Record<string, string>
  body?: string
  t?: number
}

const PORT = Number(process.env.PORT ?? 8080)
const DOMAIN = process.env.RELAY_DOMAIN ?? ''
const TOKEN = process.env.RELAY_TOKEN ?? randomBytes(16).toString('base64url')
const TOKEN_FROM_ENV = Boolean(process.env.RELAY_TOKEN)
const MAX_BODY_BYTES = 5 * 1024 * 1024
const FORWARD_TIMEOUT_MS = Number(process.env.RELAY_TIMEOUT_MS ?? 30_000)

/**
 * Whether X-Forwarded-For may be believed when identifying a client IP.
 *
 * Off by default, and the default is the interesting one: the deployment this
 * relay documents is "point nginx/caddy at :8080", which means every client
 * arrives from the proxy's address. With the header ignored, every tenant on a
 * shared relay shares one per-IP budget and the per-IP limits are useless
 * rather than merely strict. Turning it on says "nothing but my own proxy can
 * open a socket to this port", which is the thing an operator has to be able to
 * say for the header to be worth anything: a client that can set the header
 * itself can mint a fresh per-IP budget per request.
 */
const TRUST_PROXY = envFlag('RELAY_TRUST_PROXY')

/**
 * Limits. Every one of these is a knob because "public relay" and "shared
 * relay on a domain other people use" are different risk levels, and a number
 * baked into the source cannot be argued with in either direction. 0 disables.
 */
const LIMITS = {
  maxConnections: envNumber('RELAY_MAX_CONNECTIONS', 64),
  maxConnectionsPerIp: envNumber('RELAY_MAX_CONNECTIONS_PER_IP', 4),
  ratePerMinute: envNumber('RELAY_RATE_PER_MIN', 600),
  maxInflight: envNumber('RELAY_MAX_INFLIGHT', 64),
  maxFrameChars: envNumber('RELAY_MAX_FRAME_CHARS', 8 * 1024 * 1024),
  maxFramesPerSecond: envNumber('RELAY_MAX_FRAMES_PER_SEC', 200),
  maxResponseBytes: envNumber('RELAY_MAX_RESPONSE_BYTES', 5 * 1024 * 1024),
  maxResponseHeaders: envNumber('RELAY_MAX_RESPONSE_HEADERS', 100),
  /**
   * Silence after which the holder of a name is presumed dead.
   *
   * Derived from the client's ping interval rather than typed next to it: a
   * healthy client with nothing to say is quiet for a whole interval by design,
   * so a window at or below that interval reports live tunnels as dead for part
   * of every minute — which is exactly what `force=1` is not supposed to take.
   * Three pings of slack means a dropped packet is not a dead client.
   */
  staleMs: envNumber('RELAY_STALE_MS', RELAY_CLIENT_PING_MS * 3),
  /** Whether a client may steal a subdomain from a *live* connection. */
  allowForce: envFlag('RELAY_ALLOW_FORCE'),
  /** Attempts to /connect per IP per minute, good or bad. */
  connectPerMinute: envNumber('RELAY_CONNECT_PER_MIN', 30),
  /** Whether the per-IP limits above are keyed on X-Forwarded-For. */
  trustProxy: TRUST_PROXY,
}

interface Connection {
  name: string
  req: IncomingMessage
  res: ServerResponse
  connectedAt: number
  requests: number
  lastSeenAt: number
  /** Concurrently forwarded requests waiting on this client. */
  inflight: number
  /** Forwarded-request budget, refilled lazily. Protects the client, not the relay. */
  bucket: TokenBucket
  /** Frame budget from the client, per second. */
  frameWindow: FrameWindow
  remoteIp: string
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function envFlag(name: string): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return false
  return raw === '1' || raw.toLowerCase() === 'true'
}

/**
 * Token bucket, refilled lazily when read. No timer and no background work, so
 * an idle relay costs nothing and there is nothing to tear down.
 *
 * `capacity` is the burst: a client that has been quiet can send `capacity`
 * requests back to back, then settles to `refillPerSecond`. A flat
 * requests-per-second counter punishes exactly the wrong client — the one
 * whose provider fires a burst of retries after an outage.
 */
class TokenBucket {
  #capacity: number
  #refillPerSecond: number
  #tokens: number
  #updatedAt = Date.now()

  // Fields are declared and assigned by hand rather than as constructor
  // parameter properties: droppier runs TypeScript by stripping types, and
  // stripping cannot erase a parameter property because it has to emit an
  // assignment. Node refuses the file outright.
  constructor(capacity: number, refillPerSecond: number) {
    this.#capacity = capacity
    this.#refillPerSecond = refillPerSecond
    this.#tokens = capacity
  }

  get disabled(): boolean {
    return this.#capacity <= 0 || this.#refillPerSecond <= 0
  }

  take(cost = 1, now = Date.now()): boolean {
    if (this.disabled) return true
    const elapsed = now - this.#updatedAt
    if (elapsed > 0) {
      this.#tokens = Math.min(
        this.#capacity,
        this.#tokens + (elapsed / 1000) * this.#refillPerSecond,
      )
      this.#updatedAt = now
    }
    if (this.#tokens < cost) return false
    this.#tokens -= cost
    return true
  }

  /** Whole seconds until one more request would be allowed, at least 1. */
  retryAfter(): number {
    if (this.#refillPerSecond <= 0) return 60
    const missing = 1 - this.#tokens
    if (missing <= 0) return 0
    return Math.max(1, Math.ceil(missing / this.#refillPerSecond))
  }

  /**
   * True once the bucket has refilled to capacity, i.e. it is indistinguishable
   * from a bucket that never existed. Deliberately not derived from retryAfter():
   * that one answers "when may the next request in", and it does so without
   * accounting for the time that has already passed, so a drained bucket would
   * report a non-zero wait forever and never be collectable.
   */
  full(now = Date.now()): boolean {
    if (this.disabled) return true
    if (this.#tokens >= this.#capacity) return true
    return this.#tokens + ((now - this.#updatedAt) / 1000) * this.#refillPerSecond >= this.#capacity
  }
}

/** Fixed window frame counter, for bounding how fast a client can talk to us. */
class FrameWindow {
  #limit: number
  #count = 0
  #startedAt = Date.now()

  constructor(limit: number) {
    this.#limit = limit
  }

  get disabled(): boolean {
    return this.#limit <= 0
  }

  /** Consumes one frame. False means the client is over budget for this second. */
  take(now = Date.now()): boolean {
    if (this.disabled) return true
    if (now - this.#startedAt >= 1000) {
      this.#startedAt = now
      this.#count = 0
    }
    this.#count++
    return this.#count <= this.#limit
  }
}

const connections = new Map<string, Connection>()
const parserFor = new WeakMap<IncomingMessage, NdjsonParser>()
const log = (line: string): void => {
  process.stdout.write(`${line}\n`)
}
const debug = (line: string): void => {
  if (process.env.RELAY_DEBUG === '1') log(`  ${line}`)
}

const startedAt = Date.now()

function tokenMatches(provided: string | null | undefined): boolean {
  if (!provided) return false
  const a = Buffer.from(TOKEN)
  const b = Buffer.from(provided)
  return a.length === b.length && timingSafeEqual(a, b)
}

function headerBearer(req: IncomingMessage): string | null {
  const auth = req.headers.authorization
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null
}

/** Per-IP budget for /connect, good or bad token. */
const connectBuckets = new Map<string, TokenBucket>()

/**
 * How many source IPs we remember before the reaper starts collecting, and how
 * often it looks. Both are here so the bound is testable: the interesting
 * failure is a map that only ever grows, and that cannot be observed from
 * outside without either a knob or a thousand real source addresses.
 */
const TRACKED_IP_CAP = envNumber('RELAY_TRACKED_IP_CAP', 4096)
const SWEEP_MS = Math.max(250, envNumber('RELAY_SWEEP_MS', 15_000))

function clientIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    const header = req.headers['x-forwarded-for']
    // Leftmost entry: the address the outermost trusted hop saw. Proxies append,
    // so anything to the right of it describes hops we already trust less.
    const first = (Array.isArray(header) ? header[0] : header)?.split(',')[0]?.trim()
    if (first) return first
  }
  return req.socket.remoteAddress ?? 'unknown'
}

function connectBucketFor(ip: string): TokenBucket {
  let bucket = connectBuckets.get(ip)
  if (!bucket) {
    bucket = new TokenBucket(
      Math.max(1, Math.ceil(LIMITS.connectPerMinute / 4)),
      LIMITS.connectPerMinute / 60,
    )
    connectBuckets.set(ip, bucket)
  }
  return bucket
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks)))
    req.on('error', rejectPromise)
  })
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers,
  })
  res.end(body)
}

function publicUrlFor(name: string): string {
  return DOMAIN ? `https://${name}.${DOMAIN}` : `http://${name}.localhost:${PORT}`
}

function resolveName(host: string | undefined): string | null {
  if (!host || !DOMAIN) return null
  const suffix = `.${DOMAIN}`
  if (!host.endsWith(suffix)) return null
  const name: string = host.slice(0, -suffix.length).split(':')[0] ?? ''
  return /^[a-z0-9][a-z0-9-]{1,62}$/.test(name) ? name : null
}

function forward(
  connection: Connection,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
): Promise<void> {
  return new Promise((resolvePromise) => {
    const id = randomBytes(8).toString('base64url')
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
    }
    delete headers.host
    delete headers['content-length']
    headers['x-forwarded-host'] = req.headers.host ?? ''
    headers['x-forwarded-proto'] = 'https'
    const entry: Pending = { connection, res, resolve: resolvePromise }
    pending.set(id, entry)
    const timer = setTimeout(() => {
      if (!pending.has(id)) return
      pending.delete(id)
      try {
        res.writeHead(504, { 'content-type': 'text/plain' })
        res.end('relay: client did not respond in time')
      } catch {
        /* socket already gone */
      }
      resolvePromise()
    }, FORWARD_TIMEOUT_MS)
    const originalResolve = entry.resolve
    entry.resolve = () => {
      clearTimeout(timer)
      originalResolve()
    }
    connection.res.write(
      encodeMessage({
        type: 'request',
        id,
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers,
        body: body.toString('base64'),
      }),
    )
    connection.requests++
    connection.lastSeenAt = Date.now()
    debug(`${connection.name} <- ${req.method ?? 'GET'} ${req.url} (${body.length}b, id ${id})`)
  })
}

interface Pending {
  connection: Connection
  res: ServerResponse
  resolve: () => void
}

const pending = new Map<string, Pending>()

/** Token, then the printable bytes Node itself accepts in a header. */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const HEADER_VALUE_RE = /^[\t\x20-\x7e\x80-\xff]*$/

/**
 * Validate a response frame coming back from a client.
 *
 * The client is authenticated, but it is still a peer on the internet: a buggy
 * or hostile one could otherwise name a 4 GiB body and have the relay allocate
 * all of it, or a header set large enough to blow up the response write. This
 * turns that into a 502 for one request instead of an out-of-memory kill for
 * everyone on the relay.
 *
 * Names and values are checked here rather than left to `writeHead`, because
 * `writeHead` throwing is not a plan: the response is already half-written from
 * the request's point of view, and the only way to recover is to answer 502
 * instead — which is a decision worth making while the frame is still in hand.
 */
function readResponse(
  message: WireMessage,
): { status: number; headers: Record<string, string>; body: Buffer } | { error: string } {
  const status = Number(message.status ?? 502)
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    return { error: `response status ${JSON.stringify(message.status)} is not an HTTP status` }
  }
  const raw = message.headers
  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
    return { error: 'response headers must be an object' }
  }
  const entries = Object.entries(raw ?? {})
  if (LIMITS.maxResponseHeaders > 0 && entries.length > LIMITS.maxResponseHeaders) {
    return { error: `response has ${entries.length} headers, limit is ${LIMITS.maxResponseHeaders}` }
  }
  const body = Buffer.from(typeof message.body === 'string' ? message.body : '', 'base64')
  if (LIMITS.maxResponseBytes > 0 && body.length > LIMITS.maxResponseBytes) {
    return { error: `response body is ${body.length}b, limit is ${LIMITS.maxResponseBytes}b` }
  }
  const headers: Record<string, string> = {}
  for (const [name, value] of entries) {
    if (typeof value !== 'string' && typeof value !== 'number') continue
    if (!HEADER_NAME_RE.test(name)) {
      return { error: `response header name ${JSON.stringify(name)} is not a header name` }
    }
    const text = String(value)
    if (!HEADER_VALUE_RE.test(text)) {
      return { error: `response header ${name} has a value the relay cannot send` }
    }
    headers[name] = text
  }
  return { status, headers, body }
}

/**
 * Tell a client why it is being dropped, then close.
 *
 * No `writeHead` here: the 200 stream head went out at connect time, so a second
 * one throws ERR_HTTP_HEADERS_SENT — and when it threw from inside the same try
 * that was meant to deliver the reason, the reason was swallowed and the client
 * learned nothing. The `error` frame is the one thing it can act on.
 */
function dropStream(res: ServerResponse, code: string, message: string): void {
  try {
    if (!res.writableEnded) res.end(encodeMessage({ type: 'error', code, message }))
  } catch {
    /* socket already gone */
  }
}

function respond(id: string, status: number, headers: Record<string, string>, body: Buffer): void {
  const entry = pending.get(id)
  if (!entry) return
  pending.delete(id)
  const outHeaders: Record<string, string> = { ...headers }
  for (const [name, value] of Object.entries(outHeaders)) {
    if (value === undefined) delete outHeaders[name]
  }
  if (outHeaders['transfer-encoding']) delete outHeaders['transfer-encoding']
  outHeaders['content-length'] = String(body.length)
  try {
    entry.res.writeHead(status, outHeaders)
    entry.res.end(body)
  } catch {
    // writeHead throws on a header value the http parser would never have let
    // through — a client can send one inside a frame, where nothing has checked
    // it. The request must still be answered: clearing the timeout and giving up
    // here would leave the sender waiting on a socket nobody is ever going to
    // write to, which is a way for one client to pin connections open on the
    // relay forever.
    try {
      entry.res.writeHead(502, { 'content-type': 'text/plain' })
      entry.res.end('relay: client sent a response the relay cannot send')
    } catch {
      /* socket already gone */
    }
    entry.resolve()
    return
  }
  entry.resolve()
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    debug(`incoming ${req.method} ${req.url} host=${req.headers.host}`)

    if (url.pathname === '/healthz') {
      // Public on purpose — this is what a load balancer, a Docker healthcheck
      // or an uptime monitor hits, and none of them have the token. So it says
      // "am I up" and nothing else. It used to also list every connected
      // subdomain with its public url, uptime and request count, which handed a
      // stranger a roster of everyone using the relay and told them which names
      // were worth attacking. That listing is `/status`, behind the token.
      sendJson(res, 200, {
        ok: true,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        connections: connections.size,
      })
      return
    }

    if (url.pathname === '/status') {
      // Header only. The `?token=` form is still accepted on /connect for
      // compatibility, but an operator endpoint has no reason to accept a
      // secret that lands in every access log between here and the client.
      if (!tokenMatches(headerBearer(req))) {
        sendJson(res, 401, { ok: false, error: 'bad or missing relay token' })
        return
      }
      sendJson(res, 200, {
        ok: true,
        domain: DOMAIN || null,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        limits: LIMITS,
        pending: pending.size,
        trackedIps: connectBuckets.size,
        connections: [...connections.values()].map((c) => ({
          name: c.name,
          url: publicUrlFor(c.name),
          remoteIp: c.remoteIp,
          connectedAt: c.connectedAt,
          idleMs: Date.now() - c.lastSeenAt,
          requests: c.requests,
          inflight: c.inflight,
        })),
      })
      return
    }

    if (url.pathname === '/connect' && req.method === 'POST') {
      const remoteIp = clientIp(req)

      // Before the token check, not after: a flood of wrong tokens is exactly
      // what the limit is for, and checking after would let the flood through
      // to spend a constant-time compare each time.
      const connectBucket = connectBucketFor(remoteIp)
      if (!connectBucket.take()) {
        log(`! connect rate limit hit by ${remoteIp}`)
        sendJson(
          res,
          429,
          { ok: false, error: 'too many /connect attempts; slow down' },
          { 'retry-after': String(connectBucket.retryAfter()) },
        )
        return
      }

      const auth = req.headers.authorization
      const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null
      if (!tokenMatches(bearer ?? (url.searchParams.get('token') ?? null))) {
        sendJson(res, 401, { ok: false, error: 'bad or missing relay token' })
        return
      }
      const requested = url.searchParams.get('name') ?? ''
      const force = url.searchParams.get('force') === '1'
      if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(requested)) {
        sendJson(res, 400, { ok: false, error: 'name must match [a-z0-9][a-z0-9-]{1,62}' })
        return
      }

      if (LIMITS.maxConnections > 0 && connections.size >= LIMITS.maxConnections) {
        sendJson(
          res,
          503,
          {
            ok: false,
            error: `relay is full (${connections.size}/${LIMITS.maxConnections} connections)`,
          },
          { 'retry-after': '30' },
        )
        return
      }
      if (LIMITS.maxConnectionsPerIp > 0) {
        const fromIp = [...connections.values()].filter((c) => c.remoteIp === remoteIp).length
        if (fromIp >= LIMITS.maxConnectionsPerIp) {
          sendJson(
            res,
            429,
            {
              ok: false,
              error: `too many connections from ${remoteIp} (${fromIp}/${LIMITS.maxConnectionsPerIp})`,
            },
            { 'retry-after': '30' },
          )
          return
        }
      }

      const existing = connections.get(requested)
      if (existing && !force) {
        sendJson(res, 409, { ok: false, error: `name "${requested}" is already connected` })
        return
      }
      if (existing && force) {
        // `force=1` on a self-hosted relay is a denial of service, not a
        // convenience: the token is shared by everyone using this relay, so
        // "anyone with the token" means "any other tenant", and a stolen
        // subdomain silently swallows that tenant's webhooks.
        //
        // The case force actually exists for is a laptop that died without
        // closing the stream, and that one is detectable — nobody has said
        // anything on the stream in a while. So stealing a *live* tunnel is
        // refused by default and allowed when the incumbent looks dead, which
        // keeps the convenience without handing out the attack. Set
        // RELAY_ALLOW_FORCE=1 to restore the old behaviour.
        const idleMs = Date.now() - existing.lastSeenAt
        const incumbentIsDead = LIMITS.staleMs > 0 && idleMs > LIMITS.staleMs
        if (!LIMITS.allowForce && !incumbentIsDead) {
          sendJson(
            res,
            409,
            {
              ok: false,
              error: `name "${requested}" is held by a live connection (idle ${idleMs}ms)`,
              hint:
                `wait for it to go stale (>${LIMITS.staleMs}ms) or set RELAY_ALLOW_FORCE=1 on the relay`,
            },
            { 'retry-after': String(Math.max(1, Math.ceil((LIMITS.staleMs - idleMs) / 1000))) },
          )
          return
        }
        log(
          `! stealing ${requested} from ${existing.remoteIp} after ${idleMs}ms idle` +
            (incumbentIsDead ? ' (stale)' : ' (forced, RELAY_ALLOW_FORCE)'),
        )
        existing.res.end()
        connections.delete(requested)
      }
      const connection: Connection = {
        name: requested,
        req,
        res,
        connectedAt: Date.now(),
        requests: 0,
        lastSeenAt: Date.now(),
        inflight: 0,
        bucket: new TokenBucket(
          Math.max(1, Math.ceil(LIMITS.ratePerMinute / 10)),
          LIMITS.ratePerMinute / 60,
        ),
        frameWindow: new FrameWindow(LIMITS.maxFramesPerSecond),
        remoteIp,
      }
      connections.set(requested, connection)
      log(`+ ${requested} connected from ${remoteIp} -> ${publicUrlFor(requested)}`)

      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      const send = (message: RelayServerMessage): void => {
        if (!res.writableEnded) res.write(encodeMessage(message))
      }
      send({ type: 'ready', url: publicUrlFor(requested), name: requested })

      const parser = new NdjsonParser(LIMITS.maxFrameChars)
      parserFor.set(req, parser)
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => {
        connection.lastSeenAt = Date.now()
        let messages: WireMessage[]
        try {
          messages = parser.push(chunk) as WireMessage[]
        } catch (error) {
          // This handler used to call JSON.parse unguarded. One malformed line
          // from any client was an uncaught exception and the relay was gone —
          // every other tenant's tunnel with it. Broken framing is not
          // recoverable, so the answer is to drop this connection, loudly.
          log(`! ${requested} sent an unusable frame: ${(error as Error).message}`)
          dropStream(res, 'bad_frame', (error as Error).message)
          req.destroy()
          return
        }
        for (const message of messages) {
          if (!connection.frameWindow.take()) {
            log(`! ${requested} exceeded ${LIMITS.maxFramesPerSecond} frames/s`)
            dropStream(res, 'rate_limited', `frame rate limit exceeded`)
            req.destroy()
            return
          }
          if (message.type === 'response' && typeof message.id === 'string') {
            const result = readResponse(message)
            if ('error' in result) {
              log(`! ${requested} sent a bad response frame: ${result.error}`)
              respond(
                message.id,
                502,
                { 'content-type': 'text/plain' },
                Buffer.from(`relay: ${result.error}`, 'utf8'),
              )
              continue
            }
            respond(message.id, result.status, result.headers, result.body)
          }
        }
      })
      const cleanup = (): void => {
        if (connections.get(requested) === connection) {
          connections.delete(requested)
          log(`- ${requested} disconnected after ${connection.requests} request(s)`)
        }
        // Every in-flight request is in `pending` and resolves below, so the
        // `finally` in the request path brings `inflight` back to zero on its
        // own. Zeroing it here as well used to leave the counter going negative.
        for (const [id, entry] of pending) {
          if (entry.connection === connection) {
            pending.delete(id)
            try {
              entry.res.writeHead(502, { 'content-type': 'text/plain' })
              entry.res.end('relay: client disconnected before responding')
            } catch {
              /* socket already gone */
            }
            entry.resolve()
          }
        }
      }
      req.on('close', cleanup)
      req.on('error', cleanup)
      res.on('close', cleanup)
      return
    }

    const name = resolveName(req.headers.host)
    if (!name) {
      sendJson(res, 404, {
        ok: false,
        error: DOMAIN
          ? `no subdomain for host ${req.headers.host}; expected <name>.${DOMAIN}`
          : 'set RELAY_DOMAIN or use /connect',
      })
      return
    }
    const connection = connections.get(name)
    if (!connection) {
      sendJson(res, 502, {
        ok: false,
        error: `nothing is listening on ${name} right now`,
        hint: 'start `droppier dev --tunnel relay --name ' + name + ' --relay-url …`',
      })
      return
    }

    // This is the request path a stranger can reach, so it is where the limits
    // that protect the *client* belong: the client is a laptop with one Node
    // process behind it, and an open forwarder is an invitation to fill its
    // inbox and its disk. The client is rate limited per connection rather
    // than per source IP, because the source of a real webhook is whatever
    // provider the user happens to be testing, not the thing we want to police.
    if (!connection.bucket.take()) {
      log(`! rate limit for ${name} (${LIMITS.ratePerMinute}/min)`)
      sendJson(
        res,
        429,
        {
          ok: false,
          error: `too many requests for ${name} (limit ${LIMITS.ratePerMinute}/min)`,
          hint: 'this is a debugging relay, not production infrastructure',
        },
        { 'retry-after': String(connection.bucket.retryAfter()) },
      )
      return
    }
    if (LIMITS.maxInflight > 0 && connection.inflight >= LIMITS.maxInflight) {
      sendJson(
        res,
        503,
        {
          ok: false,
          error: `${name} is already handling ${connection.inflight} requests`,
        },
        { 'retry-after': '1' },
      )
      return
    }

    let body: Buffer
    try {
      body = await readBody(req)
    } catch (error) {
      sendJson(res, 413, { ok: false, error: (error as Error).message })
      return
    }
    connection.inflight++
    try {
      await forward(connection, req, res, body)
    } finally {
      connection.inflight--
    }
  })()
})

server.on('clientError', (_error, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
})

setInterval(() => {
  const now = Date.now()
  for (const [name, connection] of connections) {
    if (now - connection.lastSeenAt > 90_000) {
      log(`! ${name} timed out, dropping`)
      connection.res.end()
      connections.delete(name)
    }
  }
  // Otherwise `connectBuckets` grows one entry per source IP forever, which is
  // the same unbounded-memory-by-remote-attacker problem in a smaller size.
  if (connectBuckets.size > TRACKED_IP_CAP) {
    for (const [ip, bucket] of connectBuckets) {
      if (bucket.full()) connectBuckets.delete(ip)
    }
    // Full buckets are the only ones worth keeping, but a flood that keeps
    // every bucket drained means the sweep above reaps nothing and the map
    // grows without limit — the cap would be a trigger rather than a bound.
    // So past the cap, the oldest addresses go regardless of how full they are:
    // forgetting a rate limit costs one attacker a slower flood, and the
    // alternative is memory the attacker chooses the size of. Map iteration is
    // insertion order, so the front is the oldest.
    for (const ip of [...connectBuckets.keys()]) {
      if (connectBuckets.size <= TRACKED_IP_CAP) break
      connectBuckets.delete(ip)
    }
  }
}, SWEEP_MS)

server.listen(PORT, '0.0.0.0', () => {
  const address = server.address()
  const boundPort = typeof address === 'object' && address ? address.port : PORT
  log('droppier relay listening on :' + boundPort)
  log(`domain: ${DOMAIN || '(none — set RELAY_DOMAIN=relay.example.com behind a wildcard cert)'}`)
  if (!TOKEN_FROM_ENV) log(`relay token (generated, save it): ${TOKEN}`)
  else log('relay token: from RELAY_TOKEN')
  log('')
  log(`  point nginx/caddy at :${boundPort} with a wildcard certificate for *.${DOMAIN || 'example.com'}`)
  log(
    '  then: droppier dev --tunnel relay' +
      ` --relay-url https://relay.example.com --name me --relay-token ${TOKEN}`,
  )
  log('')
  log('  the token is required: a client without it is refused, and says nothing while failing')
  log('')
  log('  limits:')
  log(
    `    connections        ${LIMITS.maxConnections} total, ${LIMITS.maxConnectionsPerIp} per ip` +
      (LIMITS.maxConnectionsPerIp > 0 ? '' : ' (off)'),
  )
  log(`    requests           ${LIMITS.ratePerMinute}/min per connection, ${LIMITS.maxInflight} in flight`)
  log(
    `    frames from client ${LIMITS.maxFramesPerSecond}/s, ${LIMITS.maxFrameChars} chars per frame` +
      (LIMITS.maxFrameChars > 0 && LIMITS.maxFramesPerSecond > 0 ? '' : ' (off)'),
  )
  log(`    responses          ${LIMITS.maxResponseBytes}b body, ${LIMITS.maxResponseHeaders} headers`)
  log(`    connect attempts   ${LIMITS.connectPerMinute}/min per ip`)
  log(
    `    force=1            ${LIMITS.allowForce ? 'may steal a live tunnel' : `only a stale one (>${LIMITS.staleMs}ms idle)`}`,
  )
  if (
    !TRUST_PROXY &&
    (LIMITS.maxConnectionsPerIp > 0 || LIMITS.connectPerMinute > 0)
  ) {
    log('')
    log('    per-ip limits are counting the proxy, not your clients: behind caddy/nginx')
    log('    every client shares one budget. Set RELAY_TRUST_PROXY=1 if nothing but your')
    log('    own proxy can reach this port. Only then is the header worth believing.')
  }
  log('')
  log('  /healthz is public and says nothing but "up". /status needs the token.')
  log('')
  if (process.send) process.send({ ready: true, port: boundPort })
})
