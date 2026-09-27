import type { StoredEvent } from './types.ts'

const SIGNATURE_HEADERS = new Set([
  'x-droppier-signature',
  'stripe-signature',
  'x-hub-signature',
  'x-hub-signature-256',
  'x-slack-signature',
  'svix-signature',
  'x-twilio-signature',
  'x-shopify-hmac-sha256',
])

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-droppier-token',
  ...SIGNATURE_HEADERS,
])

export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADERS.has(name.toLowerCase())
}

export function isSignatureHeader(name: string): boolean {
  return SIGNATURE_HEADERS.has(name.toLowerCase())
}

/** Replace a signature digest with garbage of the same shape (hex stays hex, base64 stays base64). */
export function corruptSignatureValue(value: string): string {
  // Stripe packs timestamp and digest into one header ("t=…,v1=…"), so the
  // digest starts after the *last* "=".
  const split = value.lastIndexOf('=')
  if (split === -1) return '0'.repeat(value.length || 64)
  const prefix = value.slice(0, split + 1)
  const digest = value.slice(split + 1)
  if (/^[0-9a-f]+$/i.test(digest)) return `${prefix}${'0'.repeat(digest.length)}`
  const bytes = Buffer.alloc(Math.max(8, Math.ceil(digest.length * 0.75)))
  return prefix + bytes.toString('base64').slice(0, digest.length)
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._/:@%+,=-]+$/.test(value)) return value
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function buildCurl(
  event: Pick<StoredEvent, 'method' | 'path' | 'query' | 'headers' | 'body'>,
  options: { url: string; redact?: boolean },
): string {
  const target = `${options.url}${event.path}${event.query ? `?${event.query}` : ''}`
  // -sS: the interesting output is the JSON response, not a progress bar. Errors
  // still print to stderr, so a failed replay is never silent.
  const parts: string[] = [`curl -sS -X ${event.method} ${shellQuote(target)}`]
  let redacted = 0
  for (const [name, value] of Object.entries(event.headers)) {
    if (name === 'host' || name === 'content-length' || name === 'connection') continue
    if (options.redact !== false && isSensitiveHeader(name)) {
      parts.push(`-H ${shellQuote(`${name}: <redacted>`)}`)
      redacted++
      continue
    }
    parts.push(`-H ${shellQuote(`${name}: ${value}`)}`)
  }
  if (event.body) parts.push(`-d ${shellQuote(event.body)}`)
  const lines = [parts[0]!, ...parts.slice(1).map((part) => `  ${part}`)]
  let command = lines.join(' \\\n')
  if (redacted > 0) {
    command += `\n# ${redacted} signature header(s) redacted — open with ?raw=1 and the token to replay`
  }
  return command
}
