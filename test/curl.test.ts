import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { buildCurl, shellQuote, isSensitiveHeader } from '../src/curl.ts'
import { signPayload } from '../src/verify.ts'

const run = promisify(execFile)

test('shellQuote only quotes when it has to', () => {
  assert.equal(shellQuote('https://a.b/c'), 'https://a.b/c')
  assert.equal(shellQuote('application/json'), 'application/json')
  assert.equal(shellQuote("it's here"), `'it'\\''s here'`)
  assert.equal(shellQuote('$(rm -rf /)'), "'$(rm -rf /)'")
  assert.equal(shellQuote('a b'), "'a b'")
})

test('sensitive headers are recognised case-insensitively', () => {
  assert.equal(isSensitiveHeader('Stripe-Signature'), true)
  assert.equal(isSensitiveHeader('X-Hub-Signature-256'), true)
  assert.equal(isSensitiveHeader('X-Shopify-Hmac-Sha256'), true)
  assert.equal(isSensitiveHeader('content-type'), false)
})

test('every line but the last is continued, so the whole command runs', () => {
  const body = '{"id":"evt_1","type":"ping"}'
  const headers = signPayload({ provider: 'stripe', secret: 'whsec_x', rawBody: body })
  const command = buildCurl(
    { method: 'POST', path: '/stripe', query: '', headers: { ...headers, host: 'x' }, body },
    { url: 'http://127.0.0.1:4000', redact: false },
  )
  const lines = command.split('\n')
  for (const line of lines.slice(0, -1)) {
    assert.ok(line.endsWith('\\'), `line should continue: ${line}`)
  }
  assert.match(lines[0]!, /^curl -sS -X POST /)
  assert.match(command, /-d '\{"id":"evt_1"/)
})

test('the generated command actually reproduces the request', async () => {
  const received: Array<{ url: string; headers: Record<string, unknown>; body: string }> = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      received.push({
        url: req.url ?? '',
        headers: req.headers as Record<string, unknown>,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  const body = JSON.stringify({ id: 'evt_replay_me', type: 'charge.succeeded', note: "it's fine" })
  const headers = signPayload({ provider: 'stripe', secret: 'whsec_x', rawBody: body })
  const command = buildCurl(
    {
      method: 'POST',
      path: '/stripe',
      query: 'attempt=2',
      headers: { ...headers, host: 'old.example.com', 'content-length': '999' },
      body,
    },
    { url: `http://127.0.0.1:${port}`, redact: false },
  )
  try {
    const { stdout } = await run('sh', ['-c', command])
    assert.match(stdout, /"ok":true/)
    assert.equal(received.length, 1)
    assert.equal(received[0]?.url, '/stripe?attempt=2')
    assert.equal(received[0]?.body, body)
    assert.equal(received[0]?.headers['stripe-signature'], headers['stripe-signature'])
    assert.equal(received[0]?.headers.host, `127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test('redaction keeps the command runnable but removes the signature', async () => {
  const body = '{"a":1}'
  const headers = signPayload({ provider: 'generic', secret: 's', rawBody: body })
  const command = buildCurl(
    { method: 'POST', path: '/x', query: '', headers, body },
    { url: 'http://127.0.0.1:1', redact: true },
  )
  assert.match(command, /x-hookline-signature: <redacted>/)
  assert.match(command, /# 1 signature header\(s\) redacted/)
  assert.doesNotMatch(command, /v1=|sha256=[0-9a-f]{8}/)
})
