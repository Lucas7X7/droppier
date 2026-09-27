import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { request } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import {
  connectRelay,
  createLocalProxyHandler,
  type RelayClient,
} from '../src/tunnel/relay-client.ts'
import { loadConfig } from '../src/config.ts'
import { openStore } from '../src/store.ts'
import { createDroppierServer } from '../src/server.ts'
import { signPayload } from '../src/verify.ts'

const RELAY_TOKEN = 'relay-secret-token'
const DOMAIN = 'relay.test'
const here = dirname(fileURLToPath(import.meta.url))
const relayPath = resolve(here, '..', 'relay', 'server.ts')

interface Relay {
  child: ChildProcess
  port: number
  stop: () => Promise<void>
}

async function startRelay(env: Record<string, string> = {}): Promise<Relay> {
  const child = spawn(process.execPath, [relayPath], {
    env: {
      ...process.env,
      PORT: '0',
      RELAY_DOMAIN: DOMAIN,
      RELAY_TOKEN,
      NO_COLOR: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  child.stdout?.resume()
  child.stderr?.resume()
  const port = await new Promise<number>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('relay did not start in 10s')), 10_000)
    child.on('message', (message: { ready?: boolean; port?: number }) => {
      if (message?.ready && typeof message.port === 'number') {
        clearTimeout(timer)
        resolvePromise(message.port)
      }
    })
    child.on('error', rejectPromise)
    child.on('exit', (code) => {
      clearTimeout(timer)
      rejectPromise(new Error(`relay exited early with code ${code}`))
    })
  })
  return {
    child,
    port,
    stop: () =>
      new Promise<void>((resolvePromise) => {
        const kill = setTimeout(() => child.kill('SIGKILL'), 2000)
        child.once('exit', () => {
          clearTimeout(kill)
          resolvePromise()
        })
        child.kill('SIGTERM')
      }),
  }
}

test('end to end: a signed provider event travels relay -> local server -> inbox', async () => {
  await withRelay(async ({ port }) => {
    const dir = mkdtempSync(join(tmpdir(), 'droppier-e2e-'))
    const config = loadConfig(
      process.cwd(),
      { db: join(dir, 'inbox.db'), port: 0, token: 'e2e', secrets: { stripe: 'whsec_e2e' }, tunnel: 'none' },
      {},
    )
    const store = openStore(config.db)
    const server = createDroppierServer({ config, store, publicUrl: { current: null } })
    const localUrl = await server.listen(0, '127.0.0.1')
    const localPort = Number(new URL(localUrl).port)

    const client = connectRelay({
      relayUrl: `http://127.0.0.1:${port}`,
      name: 'e2e',
      token: RELAY_TOKEN,
    })
    client.setHandler(createLocalProxyHandler(localPort))
    try {
      await client.ready
      const body = JSON.stringify({ id: 'evt_e2e', type: 'invoice.paid' })
      const headers = signPayload({ provider: 'stripe', secret: 'whsec_e2e', rawBody: body })
      const response = await post(port, `e2e.${DOMAIN}`, '/stripe', body, headers)
      assert.equal(response.status, 200)
      assert.match(response.text, /"verdict":"valid"/)

      const stored = store.list({ limit: 1 }).events[0]
      assert.equal(stored?.eventType, 'invoice.paid')
      assert.equal(stored?.verdict, 'valid')
      assert.equal(stored?.path, '/stripe')
      assert.equal(stored?.body, body)
    } finally {
      client.close()
      await server.close()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

function post(
  port: number,
  host: string,
  path: string,
  body: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const payload = Buffer.from(body, 'utf8')
  return new Promise((resolvePromise, rejectPromise) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path,
        agent: false,
        headers: {
          host,
          'content-type': 'application/json',
          'content-length': payload.length,
          ...extraHeaders,
        },
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          text += chunk
        })
        res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, text }))
      },
    )
    req.on('error', rejectPromise)
    req.end(payload)
  })
}

async function withRelay(
  fn: (context: { relay: Relay; port: number }) => Promise<void>,
  env: Record<string, string> = {},
): Promise<void> {
  const relay = await startRelay(env)
  try {
    await fn({ relay, port: relay.port })
  } finally {
    await relay.stop()
  }
}

function connect(port: number, name: string, token = RELAY_TOKEN): RelayClient {
  return connectRelay({ relayUrl: `http://127.0.0.1:${port}`, name, token })
}

test('a refused connection is not retried forever', async () => {
  await withRelay(async ({ port }) => {
    // Found by running a client against a relay with the wrong token: it kept
    // reconnecting on a backoff forever (0.5s, 1s, 2s, 4s...) against a relay
    // that had already said no and never would say yes, spamming the log of
    // whoever self-hosts the relay.
    const log: string[] = []
    const client = connectRelay({
      relayUrl: `http://127.0.0.1:${port}`,
      name: 'refused',
      token: 'wrong-token',
      onLog: (line) => log.push(line),
    })
    try {
      await assert.rejects(client.ready, /refused/)
      // 3s covers several backoff rounds at 0.5s/1s/2s.
      await new Promise((r) => setTimeout(r, 3000))
      assert.equal(
        log.filter((line) => line.includes('reconnecting')).length,
        0,
        `should not retry, but logged: ${log.join(' | ')}`,
      )
      assert.ok(
        log.some((line) => line.includes('--relay-token')),
        `should say how to fix it, but logged: ${log.join(' | ')}`,
      )
    } finally {
      client.close()
    }
  })
})

test('relay forwards a request to the connected client and returns its response', async () => {
  await withRelay(async ({ port }) => {
    const client = connect(port, 'demo')
    try {
      assert.equal(await client.ready, `https://demo.${DOMAIN}`)
      client.setHandler(({ method, url, headers, body }) => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, url, host: headers['x-forwarded-host'], length: body.length }),
      }))

      const payload = JSON.stringify({ id: 'evt_1' })
      const response = await post(port, `demo.${DOMAIN}`, '/stripe?x=1', payload)
      assert.equal(response.status, 200)
      assert.deepEqual(JSON.parse(response.text), {
        method: 'POST',
        url: '/stripe?x=1',
        host: `demo.${DOMAIN}`,
        length: payload.length,
      })
    } finally {
      client.close()
    }
  })
})

test('relay preserves status and multi-value headers from the client', async () => {
  await withRelay(async ({ port }) => {
    const client = connect(port, 'echo')
    try {
      await client.ready
      client.setHandler(() => ({
        status: 418,
        headers: { 'content-type': 'text/plain', 'set-cookie': 'a=1, b=2' },
        body: 'teapot',
      }))
      const response = await post(port, `echo.${DOMAIN}`, '/', 'x')
      assert.equal(response.status, 418)
      assert.equal(response.text, 'teapot')
    } finally {
      client.close()
    }
  })
})

test('relay refuses bad tokens and duplicate name claims', async () => {
  await withRelay(async ({ port }) => {
    const client = connect(port, 'taken')
    try {
      await client.ready
      client.setHandler(() => ({ status: 200, headers: {}, body: 'ok' }))

      const clash = connect(port, 'taken')
      await assert.rejects(clash.ready, /already connected/)
      clash.close()

      const unauthorized = connect(port, 'other', 'wrong-token')
      await assert.rejects(unauthorized.ready, /refused/)
      unauthorized.close()

      // /healthz is public and used to hand out the full roster.
      const health = (await (
        await fetch(`http://127.0.0.1:${port}/healthz`)
      ).json()) as Record<string, unknown>
      assert.equal(health.ok, true)
      assert.equal(health.connections, 1, 'only a count, not a list')
      assert.equal(health.domain, undefined, 'the base domain is not public')
      assert.equal(JSON.stringify(health).includes('taken'), false, 'no name leaks')
      assert.equal(JSON.stringify(health).includes(DOMAIN), false, 'no url leaks')

      const status = (await (
        await fetch(`http://127.0.0.1:${port}/status`, {
          headers: { authorization: `Bearer ${RELAY_TOKEN}` },
        })
      ).json()) as { connections: Array<{ name: string; url: string }> }
      assert.deepEqual(
        status.connections.map((c) => c.name),
        ['taken'],
      )
      assert.equal(status.connections[0]?.url, `https://taken.${DOMAIN}`)
    } finally {
      client.close()
    }
  })
})

test('/status is refused without the token', async () => {
  await withRelay(async ({ port }) => {
    for (const headers of [{}, { authorization: 'Bearer wrong-token' }]) {
      const res = await fetch(`http://127.0.0.1:${port}/status`, { headers })
      assert.equal(res.status, 401)
    }
  })
})

test('requests for an offline subdomain fail fast with a hint', async () => {
  await withRelay(async ({ port }) => {
    const response = await post(port, `nobody.${DOMAIN}`, '/', '{}')
    assert.equal(response.status, 502)
    const payload = JSON.parse(response.text) as { error: string; hint: string }
    assert.match(payload.error, /nothing is listening/)
    assert.match(payload.hint, /droppier dev --tunnel relay --name nobody/)

    const foreign = await post(port, 'not-a-subdomain', '/', '{}')
    assert.equal(foreign.status, 404)
  })
})

test('a client that never answers produces a 504 instead of a hung socket', async () => {
  await withRelay(
    async ({ port }) => {
      const client = connect(port, 'slow')
      try {
        await client.ready
        client.setHandler(() => new Promise<never>(() => {}))
        const started = Date.now()
        const response = await post(port, `slow.${DOMAIN}`, '/', '{}')
        assert.equal(response.status, 504)
        assert.ok(Date.now() - started < 5000, 'should not wait for the client timeout')
      } finally {
        client.close()
      }
    },
    { RELAY_TIMEOUT_MS: '300' },
  )
})

test('a client that throws does not take the relay down', async () => {
  await withRelay(async ({ port }) => {
    const client = connect(port, 'broken')
    try {
      await client.ready
      client.setHandler(() => {
        throw new Error('handler exploded')
      })
      const response = await post(port, `broken.${DOMAIN}`, '/', '{}')
      assert.equal(response.status, 500)
      assert.match(response.text, /handler exploded/)

      const after = await fetch(`http://127.0.0.1:${port}/healthz`)
      assert.equal(after.status, 200)
    } finally {
      client.close()
    }
  })
})

/**
 * A deliberately dumb client: raw NDJSON over a chunked request, so a test can
 * put frames on the wire that the real client would never produce. The real one
 * is well behaved by construction, which is exactly why the relay's own parsing
 * has to be the thing under test.
 */
function openRaw(
  port: number,
  name: string,
  token = RELAY_TOKEN,
  query = '',
  extraHeaders: Record<string, string> = {},
): {
  req: ReturnType<typeof request>
  ready: Promise<void>
  send: (line: string) => void
  /** Everything the relay wrote to us, so a test can read its frames. */
  frames: string[]
} {
  const req = request({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path: `/connect?name=${encodeURIComponent(name)}${query}`,
    agent: false,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/x-ndjson',
      'transfer-encoding': 'chunked',
      ...extraHeaders,
    },
  })
  req.on('error', () => {
    /* the relay drops us on purpose in some of these tests */
  })
  const frames: string[] = []
  let ready: () => void = () => {}
  const readyPromise = new Promise<void>((resolvePromise) => {
    ready = resolvePromise
  })
  req.on('response', (res) => {
    res.setEncoding('utf8')
    res.on('data', (chunk: string) => {
      frames.push(chunk)
      if (chunk.includes('"type":"ready"')) ready()
    })
    res.resume()
  })
  // Written straight away, not from a 'connect' handler: http.ClientRequest is
  // lazy and does not emit 'connect', so a deferred write would sit there
  // forever and the headers would never be flushed.
  req.write(`${JSON.stringify({ type: 'hello', name, version: 'test' })}\n`)
  return { req, ready: readyPromise, send: (line) => req.write(line), frames }
}

async function relayIsUp(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok
  } catch {
    return false
  }
}

test('a malformed frame from a client does not take the relay down', async () => {
  // This one killed the process. JSON.parse ran unguarded inside an on('data')
  // handler, so a single line of garbage from any client was an uncaught
  // exception and every other tenant's tunnel died with it.
  await withRelay(async ({ port }) => {
    const hostile = openRaw(port, 'hostile')
    await hostile.ready
    hostile.send('this is not json at all\n')

    assert.ok(await relayIsUp(port), 'the relay must survive a bad frame')

    const good = connect(port, 'innocent')
    try {
      await good.ready
      good.setHandler(() => ({ status: 200, headers: {}, body: 'still here' }))
      const response = await post(port, `innocent.${DOMAIN}`, '/', '{}')
      assert.equal(response.status, 200)
      assert.equal(response.text, 'still here')
    } finally {
      good.close()
      hostile.req.destroy()
    }
  })
})

test('a frame that never ends does not exhaust memory', async () => {
  // A peer that opens the stream and then never sends a newline used to grow
  // the parser's buffer until the process died.
  await withRelay(
    async ({ port }) => {
      const greedy = openRaw(port, 'greedy')
      await greedy.ready
      for (let i = 0; i < 20; i++) greedy.send('x'.repeat(200))
      assert.ok(await relayIsUp(port), 'the relay must survive an unterminated frame')
      const good = connect(port, 'bystander')
      try {
        await good.ready
      } finally {
        good.close()
        greedy.req.destroy()
      }
    },
    { RELAY_MAX_FRAME_CHARS: '1024' },
  )
})

test('a client over its frame rate is disconnected, and the relay survives', async () => {
  await withRelay(
    async ({ port }) => {
      const chatty = openRaw(port, 'chatty')
      await chatty.ready
      for (let i = 0; i < 10; i++) chatty.send(`${JSON.stringify({ type: 'ping', t: i })}\n`)
      assert.ok(await relayIsUp(port), 'the relay must survive a frame flood')
      const good = connect(port, 'calm')
      try {
        await good.ready
      } finally {
        good.close()
        chatty.req.destroy()
      }
    },
    { RELAY_MAX_FRAMES_PER_SEC: '2' },
  )
})

test('forwarded requests are rate limited per connection', async () => {
  // The rate limit protects the client, not the relay: an open forwarder is an
  // invitation to fill someone's inbox and disk.
  await withRelay(
    async ({ port }) => {
      const client = connect(port, 'busy')
      try {
        await client.ready
        client.setHandler(() => ({ status: 200, headers: {}, body: 'ok' }))

        const statuses: number[] = []
        for (let i = 0; i < 5; i++) {
          const response = await post(port, `busy.${DOMAIN}`, '/hook', '{}')
          statuses.push(response.status)
          if (response.status === 429) {
            assert.match(response.text, /too many requests for busy/)
            break
          }
        }
        assert.ok(
          statuses.includes(429),
          `expected a 429 once the budget ran out, got ${statuses.join(',')}`,
        )
      } finally {
        client.close()
      }
    },
    { RELAY_RATE_PER_MIN: '2' },
  )
})

test('a client is not asked to handle unlimited requests at once', async () => {
  await withRelay(
    async ({ port }) => {
      const client = connect(port, 'slowpoke')
      try {
        await client.ready
        // never resolves: every request stays in flight until the timeout
        client.setHandler(() => new Promise<never>(() => {}))

        const both = await Promise.all([
          post(port, `slowpoke.${DOMAIN}`, '/a', '{}'),
          post(port, `slowpoke.${DOMAIN}`, '/b', '{}'),
        ])
        const codes = both.map((r) => r.status).sort()
        assert.deepEqual(codes, [503, 504], `expected one 503 and one 504, got ${codes.join()}`)
        assert.match(
          both.find((r) => r.status === 503)!.text,
          /already handling 1 requests/,
        )
      } finally {
        client.close()
      }
    },
    { RELAY_MAX_INFLIGHT: '1', RELAY_TIMEOUT_MS: '300' },
  )
})

test('the relay refuses more connections than it is configured for', async () => {
  await withRelay(
    async ({ port }) => {
      const first = connect(port, 'first')
      await first.ready
      try {
        const second = await rawConnectStatus(port, 'second')
        assert.equal(second.status, 503)
        assert.match(second.body, /relay is full/)
      } finally {
        first.close()
      }
    },
    { RELAY_MAX_CONNECTIONS: '1', RELAY_MAX_CONNECTIONS_PER_IP: '0' },
  )
})

test('one host cannot take every connection slot', async () => {
  await withRelay(
    async ({ port }) => {
      const first = connect(port, 'mine')
      await first.ready
      try {
        const second = await rawConnectStatus(port, 'mine2')
        assert.equal(second.status, 429)
        assert.match(second.body, /too many connections from/)
      } finally {
        first.close()
      }
    },
    { RELAY_MAX_CONNECTIONS: '0', RELAY_MAX_CONNECTIONS_PER_IP: '1' },
  )
})

test('a forged x-forwarded-for buys nothing unless the operator trusts the proxy', async () => {
  // The default has to survive a client that simply claims a new address, or the
  // per-IP limits are one HTTP header away from being decorative.
  await withRelay(
    async ({ port }) => {
      const first = connect(port, 'one')
      await first.ready
      try {
        const second = await rawConnectStatus(port, 'two', RELAY_TOKEN, '', {
          'x-forwarded-for': '203.0.113.9',
        })
        assert.equal(second.status, 429, 'the forged address must not separate these two clients')
      } finally {
        first.close()
      }
    },
    { RELAY_MAX_CONNECTIONS: '0', RELAY_MAX_CONNECTIONS_PER_IP: '1' },
  )
})

test('RELAY_TRUST_PROXY=1 keys the per-ip limits on x-forwarded-for', async () => {
  // Behind caddy/nginx every client arrives from the proxy's own address, so
  // this is the configuration where per-IP limits mean anything at all.
  await withRelay(
    async ({ port }) => {
      // Both connections stay open, so the per-ip limit is counting live slots
      // rather than counting how many times an address was seen.
      const a = openRaw(port, 'from-one', RELAY_TOKEN, '', {
        'x-forwarded-for': '203.0.113.1, 10.0.0.1',
      })
      await a.ready
      const b = openRaw(port, 'from-two', RELAY_TOKEN, '', {
        'x-forwarded-for': '203.0.113.2',
      })
      await b.ready
      try {
        const c = await rawConnectStatus(port, 'from-two-again', RELAY_TOKEN, '', {
          'x-forwarded-for': '203.0.113.2',
        })
        assert.equal(c.status, 429, 'but the same client as b is still out of budget')

        const status = await fetch(`http://127.0.0.1:${port}/status`, {
          headers: { authorization: `Bearer ${RELAY_TOKEN}` },
        })
        const body = (await status.json()) as {
          limits: { trustProxy: boolean }
          connections: { name: string; remoteIp: string }[]
        }
        assert.equal(body.limits.trustProxy, true, '/status should say it believes the header')
        assert.deepEqual(
          body.connections.map((c) => [c.name, c.remoteIp]).sort(),
          [
            ['from-one', '203.0.113.1'],
            ['from-two', '203.0.113.2'],
          ],
          'and the connections it is tracking should be keyed on the forwarded address',
        )
      } finally {
        a.req.destroy()
        b.req.destroy()
      }
    },
    { RELAY_TRUST_PROXY: '1', RELAY_MAX_CONNECTIONS: '0', RELAY_MAX_CONNECTIONS_PER_IP: '1' },
  )
})

test('bookkeeping for idle source ips does not accumulate forever', async () => {
  // One entry per source IP is one entry an attacker chooses. Without a bound,
  // /connect is a slow memory leak with a public URL on it.
  await withRelay(
    async ({ port }) => {
      const status = async (): Promise<number> => {
        const response = await fetch(`http://127.0.0.1:${port}/status`, {
          headers: { authorization: `Bearer ${RELAY_TOKEN}` },
        })
        const body = (await response.json()) as { trackedIps: number }
        return body.trackedIps
      }

      // Every attempt from a distinct address, refused on the token so nothing
      // connects. 40 at a time: sequential would take longer than the test
      // should ever take.
      const perBatch = 40
      for (let base = 0; base < 120; base += perBatch) {
        await Promise.all(
          Array.from({ length: perBatch }, (_, i) => {
            const n = base + i
            return rawConnectStatus(port, `probe${n}`, 'wrong-token', '', {
              'x-forwarded-for': `10.${(n >> 8) & 255}.${n & 255}.${n % 251}`,
            })
          }),
        )
      }

      // 120 addresses went in and the map is allowed to hold 64. Asserting it
      // never exceeded 64 would be asserting something the design does not
      // promise: the cap is applied by the sweep, so between sweeps the map is
      // free to hold whatever arrived. What has to hold is that the next sweep
      // brings it back under. Asserting it grew past the cap and stayed there
      // would be asserting the leak this test exists to catch.
      const flood = await status()
      assert.ok(flood > 0, `the flood should have been rate limited, got ${flood}`)

      const capped = await new Promise<number>((resolvePromise) => {
        const timer = setTimeout(() => resolvePromise(-1), 10_000)
        const poll = setInterval(() => {
          void status().then((count) => {
            if (count <= 64) {
              clearInterval(poll)
              clearTimeout(timer)
              resolvePromise(count)
            }
          })
        }, 100)
      })
      assert.ok(
        capped >= 0,
        `the sweep should cap the map at 64, still at ${flood} of 120 addresses`,
      )

      // Buckets refill at connectPerMinute/60 tokens per second and the flood
      // drained one token from each, so "full" — and therefore collectable — is
      // about two seconds out, plus up to one sweep interval. Poll instead of
      // sleeping a fixed amount: the exact moment is a race and a fixed sleep
      // is either flaky or slow, never both right.
      const swept = await new Promise<number>((resolvePromise) => {
        const timer = setTimeout(() => resolvePromise(-1), 10_000)
        const poll = setInterval(() => {
          void status().then((count) => {
            if (count < capped) {
              clearInterval(poll)
              clearTimeout(timer)
              resolvePromise(count)
            }
          })
        }, 100)
      })
      assert.ok(
        swept >= 0,
        `idle source addresses should be dropped, stuck at ${capped} of a cap of 64`,
      )
    },
    { RELAY_TRUST_PROXY: '1', RELAY_TRACKED_IP_CAP: '64', RELAY_SWEEP_MS: '250' },
  )
})

/** Connect once and report what the relay said, without keeping the stream. */
function rawConnectStatus(
  port: number,
  name: string,
  token = RELAY_TOKEN,
  query = '',
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: `/connect?name=${encodeURIComponent(name)}${query}`,
        agent: false,
        headers: { authorization: `Bearer ${token}`, ...extraHeaders },
      },
      (res) => {
        let body = ''
        let settled = false
        const finish = (): void => {
          if (settled) return
          settled = true
          resolvePromise({ status: res.statusCode ?? 0, body })
        }
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
          // A 200 means the relay accepted us and is holding the stream open as
          // a tunnel, so it will never end. The ready frame is the only ending
          // a successful connect is ever going to produce.
          if (body.includes('"type":"ready"')) {
            res.destroy()
            finish()
          }
        })
        res.on('end', finish)
        res.on('error', () => finish())
      },
    )
    req.on('error', rejectPromise)
    req.end()
  })
}

test('force=1 cannot steal a live tunnel by default', async () => {
  // The token is shared by everyone using a self-hosted relay, so "anyone with
  // the token" means "any other tenant". force=1 was a denial of service: steal
  // a neighbour's subdomain and their webhooks land in your inbox instead.
  await withRelay(async ({ port }) => {
    const incumbent = openRaw(port, 'victim')
    await incumbent.ready
    try {
      const thief = await rawConnectStatus(port, 'victim', RELAY_TOKEN, '&force=1')
      assert.equal(thief.status, 409)
      assert.match(thief.body, /held by a live connection/)
      assert.match(thief.body, /RELAY_ALLOW_FORCE=1/)
    } finally {
      incumbent.req.destroy()
    }
  })
})

test('force=1 still works for the case it exists for: a dead client', async () => {
  // A laptop that died without closing its stream holds the name for 90s. That
  // is the convenience force=1 was for, and it is safe to allow: nobody has
  // spoken on the stream in a while, so there is no live tunnel to steal.
  await withRelay(
    async ({ port }) => {
      const dead = openRaw(port, 'zombie')
      await dead.ready
      // The relay only ever heard from it at connect time; no frames since.
      await new Promise((r) => setTimeout(r, 250))

      const heir = await rawConnectStatus(port, 'zombie', RELAY_TOKEN, '&force=1')
      assert.equal(heir.status, 200, `expected the steal to be allowed: ${heir.body}`)
      assert.match(heir.body, /"type":"ready"/)
      dead.req.destroy()
    },
    { RELAY_STALE_MS: '100' },
  )
})

test('RELAY_ALLOW_FORCE=1 restores stealing a live tunnel', async () => {
  await withRelay(
    async ({ port }) => {
      const incumbent = openRaw(port, 'mine')
      await incumbent.ready
      const thief = await rawConnectStatus(port, 'mine', RELAY_TOKEN, '&force=1')
      assert.equal(thief.status, 200, `expected the steal to be allowed: ${thief.body}`)
      incumbent.req.destroy()
    },
    { RELAY_ALLOW_FORCE: '1' },
  )
})

test('/connect attempts are rate limited per ip, bad token or not', async () => {
  // The limit has to be in front of the token check, or a flood of wrong tokens
  // still gets to spend a constant-time compare each and every time.
  await withRelay(
    async ({ port }) => {
      const seen: number[] = []
      for (let i = 0; i < 12; i++) {
        const response = await rawConnectStatus(port, `probe${i}`, 'wrong-token')
        seen.push(response.status)
      }
      // Six a minute buys a burst of two, then the bucket is empty.
      assert.deepEqual(
        seen,
        [401, 401, ...Array(10).fill(429)],
        `wrong tokens should be judged twice then throttled, got ${seen.join(',')}`,
      )
    },
    { RELAY_CONNECT_PER_MIN: '6' },
  )
})

test('an oversized response body from a client is refused, not relayed', async () => {
  // The client is authenticated, but it is still a peer on the internet. This
  // used to be `Buffer.from(body, 'base64')` with no size check, so one frame
  // could ask the relay to allocate as much memory as it liked.
  await withRelay(
    async ({ port }) => {
      const client = connect(port, 'verbose')
      try {
        await client.ready
        client.setHandler(() => ({
          status: 200,
          headers: {},
          body: 'x'.repeat(50_000),
        }))
        const response = await post(port, `verbose.${DOMAIN}`, '/', '{}')
        assert.equal(response.status, 502)
        assert.match(response.text, /response body is 50000b, limit is 1024b/)
        assert.ok(await relayIsUp(port))
      } finally {
        client.close()
      }
    },
    { RELAY_MAX_RESPONSE_BYTES: '1024' },
  )
})

test('a nonsense status or header set from a client is refused', async () => {
  await withRelay(async ({ port }) => {
    const client = connect(port, 'odd')
    try {
      await client.ready
      client.setHandler(() => ({ status: 99999, headers: {}, body: 'nope' }))
      const bad = await post(port, `odd.${DOMAIN}`, '/', '{}')
      assert.equal(bad.status, 502)
      assert.match(bad.text, /not an HTTP status/)

      client.setHandler(() => ({
        status: 200,
        headers: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`x-h${i}`, 'v'])),
        body: 'nope',
      }))
      const many = await post(port, `odd.${DOMAIN}`, '/', '{}')
      assert.equal(many.status, 502)
      assert.match(many.text, /200 headers, limit is 100/)
      assert.ok(await relayIsUp(port))
    } finally {
      client.close()
    }
  })
})



/**
 * `post` with a deadline, because "the sender is left waiting" is not a state
 * this suite can assert on: without one, the bug shows up as a test that never
 * finishes.
 */
function postWithin(
  port: number,
  host: string,
  path: string,
  ms: number,
): Promise<{ status: number; text: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      req.destroy()
      resolvePromise({ status: 0, text: `no answer after ${ms}ms` })
    }, ms)
    const req = request(
      { host: '127.0.0.1', port, method: 'POST', path, agent: false, headers: { host } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          clearTimeout(timer)
          resolvePromise({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString() })
        })
      },
    )
    req.on('error', (error) => {
      clearTimeout(timer)
      rejectPromise(error)
    })
    req.end('{}')
  })
}

test('a response frame with a header the relay cannot send is answered, not hung on', async () => {
  // writeHead throws on a header value with a newline in it, and a client can
  // put one there inside a frame, where nothing has looked at it. The catch that
  // handled that used to resolve the request without writing to it, and
  // resolving also cleared the forward timeout — so the sender waited forever on
  // a socket nobody would ever answer.
  await withRelay(async ({ port }) => {
    const hostile = openRaw(port, 'hostile')
    await hostile.ready

    const answered = postWithin(port, `hostile.${DOMAIN}`, '/', 5000)
    // The relay hands the client the id it expects the answer on.
    const id = await new Promise<string>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error('no request frame arrived')), 5000)
      const poll = setInterval(() => {
        for (const frame of hostile.frames.join('').split('\n')) {
          try {
            const message = JSON.parse(frame) as { type?: string; id?: string }
            if (message.type === 'request' && message.id) {
              clearInterval(poll)
              clearTimeout(timer)
              resolvePromise(message.id)
            }
          } catch {
            /* not a frame yet */
          }
        }
      }, 20)
    })
    hostile.send(
      `${JSON.stringify({ type: 'response', id, status: 200, headers: { 'x-bad': 'a\nb' }, body: '' })}\n`,
    )

    const response = await answered
    assert.equal(response.status, 502, `the sender must be told, not left waiting: ${JSON.stringify(response)}`)
    assert.match(response.text, /cannot send/)
    hostile.req.destroy()
  })
})

test('a client that keeps talking is not stealable, however old it is', async () => {
  // The relay reads "is the incumbent alive" as silence, so a healthy client
  // that pings must survive a force=1 no matter how long it has held the name.
  // This is the case RELAY_STALE_MS below the client's 20s ping interval broke:
  // the tunnel was live and idle at the same time, which is most of a minute.
  await withRelay(
    async ({ port }) => {
      const incumbent = openRaw(port, 'busy')
      await incumbent.ready
      const pinger = setInterval(() => incumbent.send(`${JSON.stringify({ type: 'ping', t: 1 })}\n`), 40)
      try {
        // Well past the staleness window: three times over, with pings in between.
        await new Promise((r) => setTimeout(r, 450))
        const thief = await rawConnectStatus(port, 'busy', RELAY_TOKEN, '&force=1')
        assert.equal(thief.status, 409, `a live tunnel was stolen: ${thief.body}`)
        assert.match(thief.body, /held by a live connection/)
      } finally {
        clearInterval(pinger)
        incumbent.req.destroy()
      }
    },
    { RELAY_STALE_MS: '150' },
  )
})

test('a frame limit of 0 means no limit, not no frames', async () => {
  // Every other limit on the relay takes 0 as "off", and the docs say so. This
  // one did not: 0 is below the length of any line, so a client was dropped by
  // the first frame it ever sent.
  await withRelay(
    async ({ port }) => {
      const client = connect(port, 'unbounded')
      try {
        await client.ready
        client.setHandler(() => ({ status: 200, headers: {}, body: 'fine' }))
        const response = await post(port, `unbounded.${DOMAIN}`, '/', '{}')
        assert.equal(response.status, 200, `the tunnel should still work: ${response.text}`)
        assert.equal(response.text, 'fine')
      } finally {
        client.close()
      }
    },
    { RELAY_MAX_FRAME_CHARS: '0' },
  )
})

test('a dropped client is told why, in a frame it can parse', async () => {
  // The 200 stream head is long gone by then, so a second writeHead throws and
  // the reason went out with it. What is left is the reason.
  await withRelay(async ({ port }) => {
    const chatty = openRaw(port, 'chatty')
    await chatty.ready
    for (let i = 0; i < 10; i++) chatty.send(`${JSON.stringify({ type: 'ping', t: i })}\n`)

    const error = await new Promise<{ code?: string; message?: string } | null>((resolvePromise) => {
      const timer = setTimeout(() => resolvePromise(null), 5000)
      const poll = setInterval(() => {
        for (const chunk of chatty.frames) {
          for (const line of chunk.split('\n')) {
            try {
              const message = JSON.parse(line) as { type?: string; code?: string; message?: string }
              if (message.type === 'error') {
                clearInterval(poll)
                clearTimeout(timer)
                resolvePromise(message)
              }
            } catch {
              /* not a frame yet */
            }
          }
        }
      }, 20)
    })
    assert.ok(error, 'the client should be told why it was dropped')
    assert.equal(error!.code, 'rate_limited')
    chatty.req.destroy()
  }, { RELAY_MAX_FRAMES_PER_SEC: '2' })
})
