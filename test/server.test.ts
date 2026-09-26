import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.ts'
import { openStore } from '../src/store.ts'
import { createHooklineServer } from '../src/server.ts'
import { signPayload } from '../src/verify.ts'

const SECRET = 'whsec_test_secret'

interface Harness {
  base: string
  close: () => Promise<void>
  token: string
}

async function harness(overrides: Record<string, unknown> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'hookline-server-'))
  const config = loadConfig(
    process.cwd(),
    {
      db: join(dir, 'inbox.db'),
      port: 0,
      token: 'test-token',
      secrets: { stripe: SECRET },
      tunnel: 'none',
      ...overrides,
    },
    {},
  )
  const store = openStore(config.db)
  const publicUrl = { current: null as string | null }
  const server = createHooklineServer({ config, store, publicUrl })
  const base = await server.listen(0, '127.0.0.1')
  return {
    base,
    token: config.token!,
    async close() {
      await server.close()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function signed(body: string, secret = SECRET): Record<string, string> {
  return signPayload({ provider: 'stripe', secret, rawBody: body })
}

test('captures a signed event on any path and reports the verdict', async () => {
  const app = await harness()
  try {
    const body = JSON.stringify({ id: 'evt_9', type: 'charge.succeeded' })
    const response = await fetch(`${app.base}/stripe`, {
      method: 'POST',
      headers: signed(body),
      body,
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-hookline-verdict'), 'valid')
    const id = response.headers.get('x-hookline-id')
    assert.ok(id)

    const list = (await (
      await fetch(`${app.base}/_hookline/api/events?limit=10`, {
        headers: { 'x-hookline-token': app.token },
      })
    ).json()) as { events: Array<{ id: string; eventType: string; provider: string }> }
    assert.equal(list.events.length, 1)
    assert.equal(list.events[0]?.id, id)
    assert.equal(list.events[0]?.eventType, 'charge.succeeded')
    assert.equal(list.events[0]?.provider, 'stripe')
  } finally {
    await app.close()
  }
})

test('a tampered signature is stored as invalid instead of being dropped', async () => {
  const app = await harness()
  try {
    const body = JSON.stringify({ id: 'evt_bad', type: 'charge.failed' })
    const response = await fetch(`${app.base}/stripe`, {
      method: 'POST',
      headers: { ...signed(body), 'stripe-signature': 't=1,v1=' + '0'.repeat(64) },
      body,
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-hookline-verdict'), 'invalid')
  } finally {
    await app.close()
  }
})

test('retry of the same event id is linked as a duplicate', async () => {
  const app = await harness()
  try {
    const body = JSON.stringify({ id: 'evt_dup', type: 'invoice.paid' })
    await fetch(`${app.base}/stripe`, { method: 'POST', headers: signed(body), body })
    const second = await fetch(`${app.base}/stripe`, {
      method: 'POST',
      headers: signed(body),
      body,
    })
    const id = second.headers.get('x-hookline-id')
    const detail = (await (
      await fetch(`${app.base}/_hookline/api/events/${id}`, {
        headers: { 'x-hookline-token': app.token },
      })
    ).json()) as { duplicateOf: string | null }
    assert.ok(detail.duplicateOf)
    assert.notEqual(detail.duplicateOf, id)
  } finally {
    await app.close()
  }
})

test('replay resends the exact bytes and chaos modes mutate them on purpose', async () => {
  const app = await harness()
  try {
    const body = JSON.stringify({ id: 'evt_r', type: 'charge.succeeded', data: { amount: 100 } })
    const first = await fetch(`${app.base}/stripe`, { method: 'POST', headers: signed(body), body })
    const id = first.headers.get('x-hookline-id')!
    const auth = { 'x-hookline-token': app.token }

    const clean = (await (
      await fetch(`${app.base}/_hookline/api/events/${id}/replay`, { method: 'POST', headers: auth })
    ).json()) as { event: { id: string; body: string; verdict: string; replayOf: string } }
    assert.equal(clean.event.body, body)
    assert.equal(clean.event.replayOf, id)

    const truncated = (await (
      await fetch(`${app.base}/_hookline/api/events/${id}/replay?chaos=truncate`, {
        method: 'POST',
        headers: auth,
      })
    ).json()) as { event: { body: string; verdict: string; note: string } }
    assert.ok(truncated.event.body.length < body.length)
    assert.equal(truncated.event.verdict, 'invalid')
    assert.match(truncated.event.note, /truncated/)

    const stripped = (await (
      await fetch(`${app.base}/_hookline/api/events/${id}/replay?chaos=strip`, {
        method: 'POST',
        headers: auth,
      })
    ).json()) as { event: { headers: Record<string, string>; verdict: string } }
    assert.equal(stripped.event.headers['stripe-signature'], undefined)
    assert.equal(stripped.event.verdict, 'unverified')

    // Regression: `corrupt` used to rewrite only x-hookline-signature, so for a
    // real provider it changed nothing and the replay came back `valid`.
    const corrupted = (await (
      await fetch(`${app.base}/_hookline/api/events/${id}/replay?chaos=corrupt`, {
        method: 'POST',
        headers: auth,
      })
    ).json()) as { event: { headers: Record<string, string>; body: string; verdict: string; note: string } }
    assert.equal(corrupted.event.verdict, 'invalid')
    assert.match(
      corrupted.event.headers['stripe-signature'] ?? '',
      /^t=\d+,v1=0{64}$/,
      'digest keeps its shape, only the bytes change',
    )
    assert.equal(corrupted.event.body, body, 'corrupt must not touch the body')
    assert.match(corrupted.event.note, /corrupted/)

    const bad = await fetch(`${app.base}/_hookline/api/events/${id}/replay?chaos=nonsense`, {
      method: 'POST',
      headers: auth,
    })
    assert.equal(bad.status, 400)
    assert.match(((await bad.json()) as { error: string }).error, /unknown chaos mode/)
  } finally {
    await app.close()
  }
})

test('the inbox is locked without a token and share pages stay public', async () => {
  const app = await harness()
  try {
    const body = JSON.stringify({ id: 'evt_share', type: 'charge.succeeded' })
    const created = await fetch(`${app.base}/stripe`, { method: 'POST', headers: signed(body), body })
    const id = created.headers.get('x-hookline-id')!

    assert.equal((await fetch(`${app.base}/_hookline`)).status, 401)
    assert.equal((await fetch(`${app.base}/_hookline/api/events`)).status, 401)
    assert.equal(
      (await fetch(`${app.base}/_hookline/api/events?t=${app.token}`)).status,
      200,
    )
    assert.equal(
      (await fetch(`${app.base}/_hookline/api/events`, {
        headers: { authorization: `Bearer ${app.token}` },
      })).status,
      200,
    )

    const share = await fetch(`${app.base}/_hookline/p/${id}`)
    assert.equal(share.status, 200)
    const html = await share.text()
    assert.match(html, /evt_share/)
    assert.match(html, /<redacted>/)
    assert.doesNotMatch(html, /v1=[0-9a-f]{16}/, 'public page must not leak the signature')
    assert.match(html, /signature header\(s\) hidden/)

    const raw = await fetch(`${app.base}/_hookline/p/${id}?raw=1&t=${app.token}`)
    assert.match(await raw.text(), /stripe-signature/)

    const json = (await (
      await fetch(`${app.base}/_hookline/p/${id}.json`)
    ).json()) as { headers: Record<string, string> }
    assert.equal(json.headers['stripe-signature'], '<redacted>')

    const rawJson = (await (
      await fetch(`${app.base}/_hookline/p/${id}.json?raw=1&t=${app.token}`)
    ).json()) as { headers: Record<string, string> }
    assert.match(rawJson.headers['stripe-signature'] ?? '', /^t=\d+,v1=/)

    assert.equal((await fetch(`${app.base}/_hookline/p/deadbeef`)).status, 404)
  } finally {
    await app.close()
  }
})

test('curl output is replayable and strips secrets by default', async () => {
  const app = await harness()
  try {
    const body = JSON.stringify({ id: 'evt_curl', type: 'charge.succeeded' })
    const created = await fetch(`${app.base}/stripe`, { method: 'POST', headers: signed(body), body })
    const id = created.headers.get('x-hookline-id')!
    const redacted = (await (
      await fetch(`${app.base}/_hookline/api/events/${id}/curl`, {
        headers: { 'x-hookline-token': app.token },
      })
    ).json()) as { curl: string }
    assert.match(redacted.curl, /<redacted>/)

    const raw = (await (
      await fetch(`${app.base}/_hookline/api/events/${id}/curl?raw=1`, {
        headers: { 'x-hookline-token': app.token },
      })
    ).json()) as { curl: string }
    assert.match(raw.curl, /stripe-signature: t=\d+,v1=/)
    assert.match(raw.curl, /-X POST/)
  } finally {
    await app.close()
  }
})

test('escape hatches for probes: __no-store, __status and __delay', async () => {
  const app = await harness()
  try {
    const auth = { 'x-hookline-token': app.token }
    const countEvents = async (): Promise<number> =>
      ((await (await fetch(`${app.base}/_hookline/api/stats`, { headers: auth })).json()) as {
        total: number
      }).total

    const probe = await fetch(`${app.base}/health?__no-store=1`)
    assert.equal(probe.status, 200)
    assert.deepEqual(await probe.json(), { ok: true, stored: false })
    assert.equal(await countEvents(), 0)

    const failing = await fetch(`${app.base}/boom?__status=503`, {
      method: 'POST',
      body: 'nope',
    })
    assert.equal(failing.status, 503)
    assert.equal(await countEvents(), 1)
  } finally {
    await app.close()
  }
})

test('the live stream pushes new events to subscribers', async () => {
  const app = await harness()
  try {
    const controller = new AbortController()
    const stream = await fetch(`${app.base}/_hookline/api/stream?t=${app.token}`, {
      signal: controller.signal,
    })
    assert.equal(stream.headers.get('content-type'), 'text/event-stream; charset=utf-8')
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()

    const body = JSON.stringify({ id: 'evt_live', type: 'ping' })
    const sent = fetch(`${app.base}/hook`, { method: 'POST', headers: signed(body), body })

    let buffer = ''
    while (!buffer.includes('evt_live')) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
    }
    assert.match(buffer, /event: event/)
    assert.match(buffer, /evt_live/)
    controller.abort()
    await sent
  } finally {
    await app.close()
  }
})

test('browser noise never lands in the inbox', async () => {
  const app = await harness()
  try {
    // Found by opening the public url in a browser: every visit stored an
    // `unknown /favicon.ico unverified` event that nobody sent.
    const before = await (await fetch(`${app.base}/_hookline/api/stats?t=${app.token}`)).json()
    for (const path of ['/favicon.ico', '/robots.txt']) {
      const res = await fetch(`${app.base}${path}`)
      assert.equal(res.status, 204, `${path} should be answered, not stored`)
    }
    const after = await (await fetch(`${app.base}/_hookline/api/stats?t=${app.token}`)).json()
    assert.equal(after.total, before.total)
    assert.equal(after.unverified, before.unverified)
  } finally {
    await app.close()
  }
})
