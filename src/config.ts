import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROVIDERS, type Provider } from './types.ts'

export type TunnelKind = 'none' | 'ssh' | 'cloudflared' | 'relay'

export interface HooklineConfig {
  port: number
  host: string
  db: string
  token: string | null
  tokenGenerated: boolean
  publicUrl: string | null
  toleranceMs: number
  tunnel: TunnelKind
  tunnelName: string | null
  relayUrl: string | null
  relayToken: string | null
  retentionDays: number | null
  secrets: Record<string, string>
  pretty: boolean
  workdir: string
}

export const CONFIG_FILENAMES = ['.hookline.json', 'hookline.config.json']

const TUNNEL_KINDS: TunnelKind[] = ['none', 'ssh', 'cloudflared', 'relay']

function fromFile(workdir: string): Partial<HooklineConfig> {
  for (const name of CONFIG_FILENAMES) {
    const path = resolve(workdir, name)
    if (!existsSync(path)) continue
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<HooklineConfig>
      return parsed
    } catch (error) {
      throw new Error(`invalid ${name}: ${(error as Error).message}`)
    }
  }
  return {}
}

function fromEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const secrets: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('HOOKLINE_SECRET_') || !value) continue
    const provider = key.slice('HOOKLINE_SECRET_'.length).toLowerCase()
    secrets[provider] = value
  }
  const out: Record<string, string> = { ...secrets }
  if (env.HOOKLINE_PORT) out.port = env.HOOKLINE_PORT
  if (env.HOOKLINE_HOST) out.host = env.HOOKLINE_HOST
  if (env.HOOKLINE_DB) out.db = env.HOOKLINE_DB
  if (env.HOOKLINE_TOKEN) out.token = env.HOOKLINE_TOKEN
  if (env.HOOKLINE_PUBLIC_URL) out.publicUrl = env.HOOKLINE_PUBLIC_URL
  if (env.HOOKLINE_TOLERANCE_MS) out.toleranceMs = env.HOOKLINE_TOLERANCE_MS
  if (env.HOOKLINE_TUNNEL) out.tunnel = env.HOOKLINE_TUNNEL
  if (env.HOOKLINE_TUNNEL_NAME) out.tunnelName = env.HOOKLINE_TUNNEL_NAME
  if (env.HOOKLINE_RELAY_URL) out.relayUrl = env.HOOKLINE_RELAY_URL
  if (env.HOOKLINE_RELAY_TOKEN) out.relayToken = env.HOOKLINE_RELAY_TOKEN
  if (env.HOOKLINE_RETENTION_DAYS) out.retentionDays = env.HOOKLINE_RETENTION_DAYS
  if (env.HOOKLINE_PLAIN === '1') out.pretty = 'false'
  return out
}

export function loadConfig(
  workdir: string = process.cwd(),
  overrides: Partial<HooklineConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): HooklineConfig {
  const file = fromFile(workdir)
  const envValues = fromEnv(env)
  const merged = { ...file, ...envValues, ...overrides } as Partial<HooklineConfig>

  const tunnel = (merged.tunnel ?? 'ssh') as TunnelKind
  if (!TUNNEL_KINDS.includes(tunnel)) {
    throw new Error(`unknown tunnel: ${tunnel} (expected ${TUNNEL_KINDS.join(', ')})`)
  }

  const secrets: Record<string, string> = {}
  for (const provider of PROVIDERS) {
    const value = merged.secrets?.[provider]
    if (value) secrets[provider] = value
  }
  for (const [key, value] of Object.entries(merged.secrets ?? {})) {
    if (!value) continue
    if (!PROVIDERS.includes(key as Provider)) {
      throw new Error(`unknown provider in secrets: ${key}`)
    }
    secrets[key] = value
  }

  const tokenGenerated = !merged.token && tunnel !== 'none'
  const token = merged.token ?? (tokenGenerated ? randomBytes(12).toString('base64url') : null)

  return {
    port: Number(merged.port ?? 4000),
    host: merged.host ?? '127.0.0.1',
    db: resolve(workdir, merged.db ?? '.hookline/inbox.db'),
    token,
    tokenGenerated,
    publicUrl: merged.publicUrl ?? null,
    toleranceMs: Number(merged.toleranceMs ?? 300_000),
    tunnel,
    tunnelName: merged.tunnelName ?? null,
    relayUrl: merged.relayUrl ?? null,
    relayToken: merged.relayToken ?? null,
    retentionDays: merged.retentionDays === undefined ? 7 : merged.retentionDays,
    secrets,
    pretty: merged.pretty ?? true,
    workdir,
  }
}
