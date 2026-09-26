import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { NdjsonParser, encodeMessage } from '../relay-protocol.ts'
import type { RelayClientMessage, RelayServerMessage } from '../relay-protocol.ts'

export interface RelayClientOptions {
  relayUrl: string
  name: string | null
  token: string | null
  onLog?: (line: string) => void
}

export interface RelayResponse {
  status: number
  headers: Record<string, string>
  body: string
}

export type RelayHandler = (request: {
  id: string
  method: string
  url: string
  headers: Record<string, string>
  body: Buffer
}) => Promise<RelayResponse> | RelayResponse

export interface RelayClient {
  ready: Promise<string>
  setHandler(handler: RelayHandler): void
  close(): void
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
])

export function createLocalProxyHandler(
  port: number,
  host = '127.0.0.1',
  timeoutMs = 60_000,
): RelayHandler {
  return ({ method, url, headers, body }) =>
    new Promise<RelayResponse>((resolvePromise) => {
      const requestHeaders: Record<string, string> = {}
      for (const [name, value] of Object.entries(headers)) {
        if (HOP_BY_HOP.has(name.toLowerCase())) continue
        requestHeaders[name] = value
      }
      if (body.length > 0) requestHeaders['content-length'] = String(body.length)
      const upstream = httpRequest(
        { host, port, method, path: url, headers: requestHeaders, agent: false },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            const outHeaders: Record<string, string> = {}
            for (const [name, value] of Object.entries(res.headers)) {
              if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue
              outHeaders[name] = Array.isArray(value) ? value.join(', ') : value
            }
            resolvePromise({
              status: res.statusCode ?? 502,
              headers: outHeaders,
              body: Buffer.concat(chunks).toString('utf8'),
            })
          })
        },
      )
      const timer = setTimeout(() => {
        upstream.destroy()
        resolvePromise({
          status: 504,
          headers: { 'content-type': 'text/plain' },
          body: 'hookline: local server did not respond in time',
        })
      }, timeoutMs)
      upstream.on('error', (error) => {
        clearTimeout(timer)
        resolvePromise({
          status: 502,
          headers: { 'content-type': 'text/plain' },
          body: `hookline: local server unreachable (${error.message})`,
        })
      })
      upstream.on('close', () => clearTimeout(timer))
      if (body.length > 0) upstream.write(body)
      upstream.end()
    })
}

const PING_INTERVAL_MS = 20_000
const STALL_TIMEOUT_MS = 60_000

export function connectRelay(options: RelayClientOptions): RelayClient {
  const target = new URL(options.relayUrl)
  const name = options.name ?? `hookline-${Math.random().toString(36).slice(2, 8)}`
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest

  let handler: RelayHandler | null = null
  let request: ReturnType<typeof httpRequest> | null = null
  let closed = false
  let pingTimer: NodeJS.Timeout | null = null
  let lastMessageAt = Date.now()
  let reconnectTimer: NodeJS.Timeout | null = null
  let attempt = 0
  let resolveReady: (url: string) => void = () => {}
  let rejectReady: (error: Error) => void = () => {}
  const ready = new Promise<string>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise
    rejectReady = rejectPromise
  })
  let readySettled = false
  let fatal = false
  const settleReady = (error: Error | null, url?: string): void => {
    if (readySettled) return
    readySettled = true
    if (error) rejectReady(error)
    else if (url) resolveReady(url)
  }

  function write(message: unknown): void {
    if (!request || request.destroyed) return
    request.write(encodeMessage(message))
  }

  function open(): void {
    lastMessageAt = Date.now()
    const headers: Record<string, string> = {
      'content-type': 'application/x-ndjson',
      'transfer-encoding': 'chunked',
    }
    if (options.token) headers['authorization'] = `Bearer ${options.token}`
    request = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `/connect?name=${encodeURIComponent(name)}`,
        method: 'POST',
        headers,
      },
      (res) => {
        const status = res.statusCode ?? 0
        if (status >= 400) {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            const detail = Buffer.concat(chunks).toString('utf8')
            options.onLog?.(`  relay said ${status}: ${detail.slice(0, 200)}`)
            // 4xx here means the relay understood us and said no: wrong token,
            // name already taken, bad name. Retrying cannot fix any of those,
            // and a self-hosted relay operator would just watch their log fill
            // up. Only network failures and 5xx are worth retrying.
            if (status >= 400 && status < 500) {
              fatal = true
              options.onLog?.(
                status === 401 || status === 403
                  ? '  not retrying: the relay token is wrong or missing.' +
                      ' The relay prints its token on startup — pass it with --relay-token.'
                  : '  not retrying: the relay refused this name. Try another --name.',
              )
            }
            settleReady(new Error(`relay refused the connection: ${detail || status}`))
          })
          res.on('error', (error) => {
            options.onLog?.(`  relay response error: ${error.message}`)
            settleReady(error)
          })
          return
        }
        attempt = 0
        const parser = new NdjsonParser()
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          lastMessageAt = Date.now()
          for (const message of parser.push(chunk) as RelayServerMessage[]) {
            if (message.type === 'ready') {
              options.onLog?.(`  relay assigned ${message.url}`)
              settleReady(null, message.url)
              continue
            }
            if (message.type === 'error') {
              settleReady(new Error(`${message.code}: ${message.message}`))
              continue
            }
            if (message.type === 'request') {
              const respond = (response: RelayResponse): void => {
                write({
                  type: 'response',
                  id: message.id,
                  status: response.status,
                  headers: response.headers,
                  body: Buffer.from(response.body).toString('base64'),
                })
              }
              if (!handler) {
                respond({
                  status: 503,
                  headers: { 'content-type': 'text/plain' },
                  body: 'hookline: no handler attached',
                })
                continue
              }
              void (async () =>
                handler({
                  id: message.id,
                  method: message.method,
                  url: message.url,
                  headers: message.headers,
                  body: Buffer.from(message.body ?? '', 'base64'),
                }))()
                .then(respond)
                .catch((error: Error) => {
                  respond({
                    status: 500,
                    headers: { 'content-type': 'text/plain' },
                    body: `hookline relay handler failed: ${error.message}`,
                  })
                })
            }
          }
        })
        res.on('end', () => {
          lastMessageAt = 0
        })
      },
    )
    request.on('error', (error) => {
      if (closed) return
      options.onLog?.(`  relay link error: ${error.message}`)
      settleReady(error)
      scheduleReconnect()
    })

    const hello: RelayClientMessage = { type: 'hello', name, version: '0.1.0' }
    request.write(encodeMessage(hello))
    pingTimer = setInterval(() => {
      write({ type: 'ping', t: Date.now() } satisfies RelayClientMessage)
      if (lastMessageAt > 0 && Date.now() - lastMessageAt > STALL_TIMEOUT_MS) {
        options.onLog?.('  relay link stalled, reconnecting')
        request?.destroy()
      }
    }, PING_INTERVAL_MS)
    request.on('close', () => {
      if (pingTimer) clearInterval(pingTimer)
      pingTimer = null
      if (closed) return
      if (fatal) return
      options.onLog?.('  relay link closed by peer')
      scheduleReconnect()
    })
  }

  function scheduleReconnect(): void {
    if (closed || fatal || reconnectTimer) return
    attempt++
    const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6))
    options.onLog?.(`  reconnecting to relay in ${Math.round(delay / 100) / 10}s`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (!closed) open()
    }, delay)
  }

  open()

  return {
    ready,
    setHandler(next: RelayHandler): void {
      handler = next
    },
    close(): void {
      closed = true
      if (pingTimer) clearInterval(pingTimer)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      request?.destroy()
    },
  }
}
