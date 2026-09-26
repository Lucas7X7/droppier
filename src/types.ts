export const PROVIDERS = [
  'stripe',
  'github',
  'slack',
  'svix',
  'twilio',
  'shopify',
  'generic',
  'unknown',
] as const

export type Provider = (typeof PROVIDERS)[number]

export type Verdict = 'valid' | 'invalid' | 'stale' | 'unverified'

const VERDICT_CODES: Record<Verdict, number> = {
  valid: 1,
  invalid: 0,
  stale: 3,
  unverified: 2,
}

const CODE_VERDICTS: Record<number, Verdict> = Object.fromEntries(
  Object.entries(VERDICT_CODES).map(([k, v]) => [v, k as Verdict]),
) as Record<number, Verdict>

export function verdictToCode(v: Verdict): number {
  return VERDICT_CODES[v]
}

export function codeToVerdict(c: number): Verdict {
  return CODE_VERDICTS[c] ?? 'unverified'
}

export interface EventSummary {
  seq: number
  id: string
  receivedAt: number
  provider: Provider
  eventType: string
  method: string
  path: string
  query: string
  verdict: Verdict
  size: number
  duplicateOf: string | null
  status: number
  durationMs: number
  remoteAddr: string
  replayOf: string | null
  note: string | null
}

export interface StoredEvent extends EventSummary {
  headers: Record<string, string>
  body: string
  pretty: string | null
  dedupeKey: string | null
  signatureScheme: string
  signatureError: string | null
}

export interface ListQuery {
  limit?: number
  before?: number
  after?: number
  q?: string
  provider?: string
  eventType?: string
  duplicatesOnly?: boolean
  invalidOnly?: boolean
}

export interface Stats {
  total: number
  duplicates: number
  invalid: number
  unverified: number
  byProvider: Array<{ provider: string; count: number }>
  byHour: Array<{ hour: number; count: number }>
  lastEventAt: number | null
  bytes: number
}
