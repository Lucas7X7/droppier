import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifySignature, signPayload, detectProvider, schemeFor } from '../src/verify.ts'
import type { Provider } from '../src/types.ts'

const body = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded', data: { amount: 4200 } })
const TWILIO_URL = 'https://demo.localhost.run/twilio'
const urlFor = (provider: Provider): string | undefined =>
  provider === 'twilio' ? TWILIO_URL : undefined

const CASES: Array<{ provider: Provider; secret: string }> = [
  { provider: 'stripe', secret: 'whsec_test_secret_123' },
  { provider: 'github', secret: 'ghs_deadbeef' },
  { provider: 'slack', secret: '8f742231b10e8888abcd99yyyzzz85a5' },
  { provider: 'svix', secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw' },
  { provider: 'shopify', secret: 'hush_secret' },
  { provider: 'twilio', secret: 'auth_token_abc' },
  { provider: 'generic', secret: 'plain_secret' },
]

for (const { provider, secret } of CASES) {
  test(`${provider}: signed payload verifies`, () => {
    const headers = signPayload({
      provider,
      secret,
      rawBody: body,
      timestamp: 1_700_000_000_000,
      url: urlFor(provider),
    })
    const result = verifySignature({
      provider,
      headers,
      rawBody: body,
      secrets: { [provider]: secret },
      now: 1_700_000_000_000,
      publicUrl: urlFor(provider),
    })
    assert.equal(result.verdict, 'valid', result.error ?? '')
    assert.equal(result.scheme, schemeFor(provider))
    assert.equal(detectProvider(headers), provider)
  })

  test(`${provider}: tampered body is rejected`, () => {
    const headers = signPayload({
      provider,
      secret,
      rawBody: body,
      timestamp: 1_700_000_000_000,
      url: urlFor(provider),
    })
    const result = verifySignature({
      provider,
      headers,
      rawBody: body.replace('4200', '9999'),
      secrets: { [provider]: secret },
      now: 1_700_000_000_000,
      publicUrl: provider === 'twilio' ? `${TWILIO_URL}x` : undefined,
    })
    assert.equal(result.verdict, 'invalid')
  })

  test(`${provider}: wrong secret is rejected`, () => {
    const headers = signPayload({
      provider,
      secret,
      rawBody: body,
      timestamp: 1_700_000_000_000,
      url: urlFor(provider),
    })
    const result = verifySignature({
      provider,
      headers,
      rawBody: body,
      secrets: { [provider]: `${secret}-wrong` },
      now: 1_700_000_000_000,
      publicUrl: urlFor(provider),
    })
    assert.equal(result.verdict, 'invalid')
  })
}

test('twilio: form params participate in the signature, sorted by name', () => {
  const secret = 'auth_token'
  const form = 'MessageBody=hi+there&From=%2B15551234567&To=%2B15557654321'
  const headers = signPayload({
    provider: 'twilio',
    secret,
    rawBody: form,
    url: TWILIO_URL,
  })
  assert.equal(
    verifySignature({
      provider: 'twilio',
      headers,
      rawBody: form,
      secrets: { twilio: secret },
      publicUrl: TWILIO_URL,
    }).verdict,
    'valid',
  )
  const tampered = form.replace('hi+there', 'pay+me')
  assert.equal(
    verifySignature({
      provider: 'twilio',
      headers,
      rawBody: tampered,
      secrets: { twilio: secret },
      publicUrl: TWILIO_URL,
    }).verdict,
    'invalid',
  )
})

test('twilio: without the public url it stays unverified instead of guessing', () => {
  const headers = signPayload({ provider: 'twilio', secret: 't', rawBody: body, url: TWILIO_URL })
  const result = verifySignature({
    provider: 'twilio',
    headers,
    rawBody: body,
    secrets: { twilio: 't' },
  })
  assert.equal(result.verdict, 'unverified')
  assert.match(result.error ?? '', /public-url/)
})

test('stripe: rotated secrets accept either v1', () => {
  const old = 'whsec_old'
  const current = 'whsec_current'
  const headers = signPayload({
    provider: 'stripe',
    secret: current,
    rawBody: body,
    timestamp: 1_700_000_000_000,
  })
  const rotated = signPayload({ provider: 'stripe', secret: old, rawBody: body, timestamp: 1_700_000_000_000 })
  const merged = {
    ...headers,
    'stripe-signature': `${headers['stripe-signature']},v1=${rotated['stripe-signature']!.split('v1=')[1]}`,
  }
  for (const secret of [old, current]) {
    const result = verifySignature({
      provider: 'stripe',
      headers: merged,
      rawBody: body,
      secrets: { stripe: secret },
      now: 1_700_000_000_000,
    })
    assert.equal(result.verdict, 'valid')
  }
})

for (const provider of ['stripe', 'slack', 'svix', 'generic'] as const) {
  test(`${provider}: replay outside tolerance is stale, not valid`, () => {
    const secret = 'secret_value'
    const old = 1_700_000_000_000
    const headers = signPayload({ provider, secret, rawBody: body, timestamp: old })
    const result = verifySignature({
      provider,
      headers,
      rawBody: body,
      secrets: { [provider]: secret },
      toleranceMs: 60_000,
      now: old + 10 * 60_000,
    })
    assert.equal(result.verdict, 'stale')
  })
}

test('svix: secret is base64 after the whsec_ prefix', () => {
  const secretBytes = Buffer.from('super-secret-bytes')
  const secret = `whsec_${secretBytes.toString('base64')}`
  const headers = signPayload({ provider: 'svix', secret, rawBody: body, timestamp: 1_700_000_000_000 })
  const result = verifySignature({
    provider: 'svix',
    headers,
    rawBody: body,
    secrets: { svix: secret },
    now: 1_700_000_000_000,
  })
  assert.equal(result.verdict, 'valid')
})

test('unknown provider is unverified, never silently valid', () => {
  const result = verifySignature({
    provider: 'unknown',
    headers: {},
    rawBody: body,
    secrets: { '*': 'anything' },
  })
  assert.equal(result.verdict, 'unverified')
})

test('missing secret downgrades to unverified instead of throwing', () => {
  const headers = signPayload({ provider: 'stripe', secret: 'whsec_x', rawBody: body })
  const result = verifySignature({
    provider: 'stripe',
    headers,
    rawBody: body,
    secrets: {},
  })
  assert.equal(result.verdict, 'unverified')
  assert.match(result.error ?? '', /no secret/)
})
