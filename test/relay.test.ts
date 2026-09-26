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
import { createHooklineServer } from '../src/server.ts'
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
    const dir = mkdtempSync(join(tmpdir(), 'hookline-e2e-'))
    const config = loadConfig(
      process.cwd(),
      { db: join(dir, 'inbox.db'), port: 0, token: 'e2e', secrets: { stripe: 'whsec_e2e' }, tunnel: 'none' },
      {},
    )
    const store = openStore(config.db)
    const server = createHooklineServer({ config, store, publicUrl: { current: null } })
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

      const health = (await (
        await fetch(`http://127.0.0.1:${port}/healthz`)
      ).json()) as { connections: Array<{ name: string; url: string }> }
      assert.deepEqual(
        health.connections.map((c) => c.name),
        ['taken'],
      )
      assert.equal(health.connections[0]?.url, `https://taken.${DOMAIN}`)
    } finally {
      client.close()
    }
  })
})

test('requests for an offline subdomain fail fast with a hint', async () => {
  await withRelay(async ({ port }) => {
    const response = await post(port, `nobody.${DOMAIN}`, '/', '{}')
    assert.equal(response.status, 502)
    const payload = JSON.parse(response.text) as { error: string; hint: string }
    assert.match(payload.error, /nothing is listening/)
    assert.match(payload.hint, /hookline dev --tunnel relay --name nobody/)

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
