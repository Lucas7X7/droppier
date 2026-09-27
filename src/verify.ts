import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Provider, Verdict } from './types.ts'

export interface Secrets {
  [provider: string]: string | undefined
}

export interface VerifyOptions {
  provider: Provider
  headers: Record<string, string>
  rawBody: string
  secrets: Secrets
  toleranceMs?: number
  publicUrl?: string
  now?: number
}

export interface VerifyResult {
  verdict: Verdict
  scheme: string
  error: string | null
}

const DEFAULT_TOLERANCE_MS = 300_000

export function detectProvider(headers: Record<string, string>): Provider {
  if (headers['stripe-signature']) return 'stripe'
  if (headers['x-hub-signature-256'] || headers['x-hub-signature']) return 'github'
  if (headers['x-slack-signature']) return 'slack'
  if (headers['svix-id'] || headers['svix-signature']) return 'svix'
  if (headers['x-twilio-signature']) return 'twilio'
  if (headers['x-shopify-hmac-sha256']) return 'shopify'
  if (headers['x-droppier-signature']) return 'generic'
  return 'unknown'
}

export function schemeFor(provider: Provider): string {
  switch (provider) {
    case 'stripe':
      return 'hmac-sha256/timestamped'
    case 'github':
      return 'hmac-sha256/hex'
    case 'slack':
      return 'hmac-sha256/prefixed'
    case 'svix':
      return 'hmac-sha256/base64'
    case 'twilio':
      return 'hmac-sha1/url'
    case 'shopify':
      return 'hmac-sha256/base64'
    case 'generic':
      return 'hmac-sha256/hex'
    default:
      return 'none'
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function hmacHex(key: string | Buffer, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('hex')
}

function hmacB64(key: string | Buffer, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('base64')
}

function svixKey(secret: string): Buffer {
  const raw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret
  return Buffer.from(raw, 'base64')
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

function fieldList(value: string, prefix: string): string[] {
  return splitList(value)
    .filter((part) => part.startsWith(prefix))
    .map((part) => part.slice(prefix.length))
}

/**
 * Age verdict for a provider timestamp header.
 *
 * Takes the raw string on purpose. An earlier version parsed it as
 * `Number(value) * 1000 || null`, which has two ways to lie:
 *
 *  - a legitimate `t=0` becomes `null`, i.e. "no timestamp", and the freshness
 *    check is skipped entirely — a correctly signed replay from 1970 came back
 *    `valid`;
 *  - a present-but-unparseable timestamp (`t=not-a-number`) also becomes
 *    `null`, so a signature that checks out is reported `valid` even though
 *    nothing established *when* it was signed.
 *
 * `Number.isFinite` is the real test for "not a number", and an unparseable
 * timestamp is `stale`, not `valid`: freshness could not be established, and
 * `valid` is the one verdict a caller is likely to act on.
 *
 * Absent stays `missing`, because the `generic` scheme signs the bare body
 * with no timestamp at all and that is a legitimate `valid`. The timestamped
 * providers reject a missing timestamp before ever getting here.
 */
function timestampAge(
  rawTimestamp: string | undefined | null,
  toleranceMs: number,
  now: number,
): 'ok' | 'stale' | 'missing' {
  if (rawTimestamp === undefined || rawTimestamp === null || rawTimestamp === '') return 'missing'
  const seconds = Number(rawTimestamp)
  if (!Number.isFinite(seconds)) return 'stale'
  const age = Math.abs(now - seconds * 1000)
  return age > toleranceMs ? 'stale' : 'ok'
}

export function verifySignature(options: VerifyOptions): VerifyResult {
  const { provider, headers, rawBody, secrets } = options
  const toleranceMs = options.toleranceMs ?? DEFAULT_TOLERANCE_MS
  const now = options.now ?? Date.now()
  const scheme = schemeFor(provider)
  const secret = secrets[provider] ?? secrets['*']

  const unverified = (error: string | null): VerifyResult => ({
    verdict: secret ? 'invalid' : 'unverified',
    scheme,
    error,
  })

  switch (provider) {
    case 'stripe': {
      if (!secret) return unverified('no secret configured for stripe')
      const header = headers['stripe-signature'] ?? ''
      const timestamp = fieldList(header, 't=')[0]
      const signatures = fieldList(header, 'v1=')
      if (!timestamp || signatures.length === 0) {
        return { verdict: 'invalid', scheme, error: 'malformed stripe-signature header' }
      }
      const age = timestampAge(timestamp, toleranceMs, now)
      const expected = hmacHex(secret, `${timestamp}.${rawBody}`)
      const matched = signatures.some((candidate) => safeEqual(candidate, expected))
      if (!matched) return { verdict: 'invalid', scheme, error: 'signature mismatch' }
      return age === 'stale'
        ? { verdict: 'stale', scheme, error: `timestamp outside ${toleranceMs}ms tolerance` }
        : { verdict: 'valid', scheme, error: null }
    }

    case 'github': {
      if (!secret) return unverified('no secret configured for github')
      const sha256 = headers['x-hub-signature-256']?.replace(/^sha256=/, '')
      if (sha256) {
        return safeEqual(sha256, hmacHex(secret, rawBody))
          ? { verdict: 'valid', scheme, error: null }
          : { verdict: 'invalid', scheme, error: 'signature mismatch' }
      }
      const sha1 = headers['x-hub-signature']?.replace(/^sha1=/, '')
      if (sha1) {
        const expected = createHmac('sha1', secret).update(rawBody, 'utf8').digest('hex')
        return safeEqual(sha1, expected)
          ? { verdict: 'valid', scheme, error: null }
          : { verdict: 'invalid', scheme, error: 'signature mismatch (sha1)' }
      }
      return { verdict: 'invalid', scheme, error: 'missing x-hub-signature-256' }
    }

    case 'slack': {
      if (!secret) return unverified('no secret configured for slack')
      const header = headers['x-slack-signature'] ?? ''
      const timestamp = headers['x-slack-request-timestamp']
      const signature = fieldList(header, 'v0=')[0]
      if (!timestamp || !signature) {
        return { verdict: 'invalid', scheme, error: 'missing slack timestamp or v0 signature' }
      }
      const age = timestampAge(timestamp, toleranceMs, now)
      const expected = hmacHex(secret, `v0:${timestamp}:${rawBody}`)
      if (!safeEqual(signature, expected)) {
        return { verdict: 'invalid', scheme, error: 'signature mismatch' }
      }
      return age === 'stale'
        ? { verdict: 'stale', scheme, error: 'timestamp outside tolerance' }
        : { verdict: 'valid', scheme, error: null }
    }

    case 'svix': {
      if (!secret) return unverified('no secret configured for svix')
      const id = headers['svix-id']
      const timestamp = headers['svix-timestamp']
      const signatures = fieldList(headers['svix-signature'] ?? '', 'v1=')
      if (!id || !timestamp || signatures.length === 0) {
        return { verdict: 'invalid', scheme, error: 'missing svix-id, svix-timestamp or v1' }
      }
      const age = timestampAge(timestamp, toleranceMs, now)
      const expected = hmacB64(svixKey(secret), `${id}.${timestamp}.${rawBody}`)
      const matched = signatures.some((candidate) => safeEqual(candidate, expected))
      if (!matched) return { verdict: 'invalid', scheme, error: 'signature mismatch' }
      return age === 'stale'
        ? { verdict: 'stale', scheme, error: 'timestamp outside tolerance' }
        : { verdict: 'valid', scheme, error: null }
    }

    case 'twilio': {
      if (!secret) return unverified('no secret configured for twilio')
      const signature = headers['x-twilio-signature'] ?? ''
      const url = options.publicUrl
      if (!url) {
        return { verdict: 'unverified', scheme, error: 'twilio needs --public-url to verify' }
      }
      let data = url
      if ((headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')) {
        const params = new URLSearchParams(rawBody)
        for (const key of [...new Set(params.keys())].sort()) {
          data += `${key}${params.getAll(key).join('')}`
        }
      }
      const expected = createHmac('sha1', secret).update(data, 'utf8').digest('base64')
      return safeEqual(signature, expected)
        ? { verdict: 'valid', scheme, error: null }
        : { verdict: 'invalid', scheme, error: 'signature mismatch' }
    }

    case 'shopify': {
      if (!secret) return unverified('no secret configured for shopify')
      const signature = headers['x-shopify-hmac-sha256'] ?? ''
      const expected = hmacB64(secret, rawBody)
      return safeEqual(signature, expected)
        ? { verdict: 'valid', scheme, error: null }
        : { verdict: 'invalid', scheme, error: 'signature mismatch' }
    }

    case 'generic': {
      if (!secret) return unverified('no secret configured for generic')
      const header = headers['x-droppier-signature'] ?? ''
      const timestamp = headers['x-droppier-timestamp']
      const signature = header.replace(/^(sha256=)?/, '')
      const data = timestamp ? `${timestamp}.${rawBody}` : rawBody
      const age = timestampAge(timestamp, toleranceMs, now)
      if (!safeEqual(signature, hmacHex(secret, data))) {
        return { verdict: 'invalid', scheme, error: 'signature mismatch' }
      }
      return age === 'stale'
        ? { verdict: 'stale', scheme, error: 'timestamp outside tolerance' }
        : { verdict: 'valid', scheme, error: null }
    }

    default:
      return { verdict: 'unverified', scheme, error: 'unknown provider' }
  }
}

export interface SignOptions {
  provider: Provider
  secret: string
  rawBody: string
  timestamp?: number
  url?: string
}

export function signPayload(options: SignOptions): Record<string, string> {
  const { provider, secret, rawBody } = options
  const timestamp = Math.floor((options.timestamp ?? Date.now()) / 1000)
  const id = `msg_${Math.abs(hash(rawBody + timestamp)).toString(36)}`

  switch (provider) {
    case 'stripe':
      return {
        'content-type': 'application/json',
        'stripe-signature': `t=${timestamp},v1=${hmacHex(secret, `${timestamp}.${rawBody}`)}`,
      }
    case 'github':
      return {
        'content-type': 'application/json',
        'x-github-event': 'push',
        'x-github-delivery': id,
        'x-hub-signature-256': `sha256=${hmacHex(secret, rawBody)}`,
        'user-agent': 'GitHub-Hookshot/droppier',
      }
    case 'slack':
      return {
        'content-type': 'application/json',
        'x-slack-request-timestamp': String(timestamp),
        'x-slack-signature': `v0=${hmacHex(secret, `v0:${timestamp}:${rawBody}`)}`,
      }
    case 'svix':
      return {
        'content-type': 'application/json',
        'svix-id': id,
        'svix-timestamp': String(timestamp),
        'svix-signature': `v1=${hmacB64(svixKey(secret), `${id}.${timestamp}.${rawBody}`)}`,
      }
    case 'twilio': {
      const url = options.url ?? ''
      const params = new URLSearchParams(rawBody)
      let data = url
      for (const key of [...new Set(params.keys())].sort()) {
        data += `${key}${params.getAll(key).join('')}`
      }
      return {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': createHmac('sha1', secret).update(data, 'utf8').digest('base64'),
      }
    }
    case 'shopify':
      return {
        'content-type': 'application/json',
        'x-shopify-topic': 'orders/create',
        'x-shopify-webhook-id': id,
        'x-shopify-hmac-sha256': hmacB64(secret, rawBody),
      }
    case 'generic':
      return {
        'content-type': 'application/json',
        'x-droppier-timestamp': String(timestamp),
        'x-droppier-id': id,
        'x-droppier-signature': hmacHex(secret, `${timestamp}.${rawBody}`),
      }
    default:
      return { 'content-type': 'application/json' }
  }
}

function hash(input: string): number {
  let value = 0
  for (let i = 0; i < input.length; i++) {
    value = (value * 31 + input.charCodeAt(i)) | 0
  }
  return value
}
