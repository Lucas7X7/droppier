import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { NdjsonParser, encodeMessage } from '../src/relay-protocol.ts'
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

interface Connection {
  name: string
  req: IncomingMessage
  res: ServerResponse
  connectedAt: number
  requests: number
  lastSeenAt: number
}

const connections = new Map<string, Connection>()
const parserFor = new WeakMap<IncomingMessage, NdjsonParser>()
const log = (line: string): void => {
  process.stdout.write(`${line}\n`)
}
const debug = (line: string): void => {
  if (process.env.RELAY_DEBUG === '1') log(`  ${line}`)
}

function tokenMatches(provided: string | null | undefined): boolean {
  if (!provided) return false
  const a = Buffer.from(TOKEN)
  const b = Buffer.from(provided)
  return a.length === b.length && timingSafeEqual(a, b)
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

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
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
      sendJson(res, 200, {
        ok: true,
        domain: DOMAIN || null,
        connections: [...connections.values()].map((c) => ({
          name: c.name,
          url: publicUrlFor(c.name),
          connectedAt: c.connectedAt,
          requests: c.requests,
        })),
      })
      return
    }

    if (url.pathname === '/connect' && req.method === 'POST') {
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
      const existing = connections.get(requested)
      if (existing && !force) {
        sendJson(res, 409, { ok: false, error: `name "${requested}" is already connected` })
        return
      }
      if (existing && force) {
        log(`! stealing ${requested} from a previous connection`)
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
      }
      connections.set(requested, connection)
      log(`+ ${requested} connected from ${req.socket.remoteAddress} -> ${publicUrlFor(requested)}`)

      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      const send = (message: RelayServerMessage): void => {
        if (!res.writableEnded) res.write(encodeMessage(message))
      }
      send({ type: 'ready', url: publicUrlFor(requested), name: requested })

      const parser = new NdjsonParser()
      parserFor.set(req, parser)
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => {
        connection.lastSeenAt = Date.now()
        for (const message of parser.push(chunk) as WireMessage[]) {
          if (message.type === 'response' && typeof message.id === 'string') {
            respond(
              message.id,
              Number(message.status ?? 502),
              message.headers ?? {},
              Buffer.from(message.body ?? '', 'base64'),
            )
          }
        }
      })
      const cleanup = (): void => {
        if (connections.get(requested) === connection) {
          connections.delete(requested)
          log(`- ${requested} disconnected after ${connection.requests} request(s)`)
        }
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
        hint: 'start `hookline dev --tunnel relay --name ' + name + ' --relay-url …`',
      })
      return
    }

    let body: Buffer
    try {
      body = await readBody(req)
    } catch (error) {
      sendJson(res, 413, { ok: false, error: (error as Error).message })
      return
    }
    await forward(connection, req, res, body)
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
}, 15_000)

server.listen(PORT, '0.0.0.0', () => {
  const address = server.address()
  const boundPort = typeof address === 'object' && address ? address.port : PORT
  log('hookline relay listening on :' + boundPort)
  log(`domain: ${DOMAIN || '(none — set RELAY_DOMAIN=relay.example.com behind a wildcard cert)'}`)
  if (!TOKEN_FROM_ENV) log(`relay token (generated, save it): ${TOKEN}`)
  else log('relay token: from RELAY_TOKEN')
  log('')
  log(`  point nginx/caddy at :${boundPort} with a wildcard certificate for *.${DOMAIN || 'example.com'}`)
  log('  then: hookline dev --tunnel relay --relay-url https://relay.example.com --name me')
  log('')
  if (process.send) process.send({ ready: true, port: boundPort })
})
