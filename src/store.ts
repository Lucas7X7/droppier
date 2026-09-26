import { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { ListQuery, Provider, Stats, StoredEvent, Verdict } from './types.ts'
import { codeToVerdict, verdictToCode } from './types.ts'

type Row = Record<string, unknown>

/**
 * `alter table ... add column` has no `if not exists` in SQLite, and it cannot be
 * folded into the `create table`. So check the column list first and make every
 * add idempotent — that way a database left half-migrated by an older build
 * (crashed between two alters) repairs itself instead of dying on
 * `duplicate column name` forever.
 */
function addColumn(db: DatabaseSync, table: string, column: string, type: string): void {
  const columns = db.prepare(`pragma table_info(${table})`).all() as Row[]
  if (columns.some((row) => row.name === column)) return
  db.exec(`alter table ${table} add column ${column} ${type}`)
}

type Migration = (db: DatabaseSync) => void

const MIGRATIONS: Migration[] = [
  (db) => {
    db.exec(`
    create table if not exists events (
      seq              integer primary key autoincrement,
      id               text not null unique,
      received_at      integer not null,
      provider         text not null,
      event_type       text not null default '',
      method           text not null default 'POST',
      path             text not null default '/',
      query            text not null default '',
      headers          text not null default '{}',
      body             text not null default '',
      pretty           text,
      dedupe_key       text,
      duplicate_of     text,
      verdict          integer not null default 2,
      signature_scheme text not null default 'none',
      signature_error  text,
      status           integer not null default 200,
      duration_ms      integer not null default 0,
      remote_addr      text not null default ''
    );
    create index if not exists events_received_at on events (received_at desc);
    create index if not exists events_dedupe_key on events (dedupe_key);
    create index if not exists events_provider on events (provider);
  `)
  },
  (db) => {
    addColumn(db, 'events', 'replay_of', 'text')
    addColumn(db, 'events', 'note', 'text')
  },
]

export interface NewEvent {
  receivedAt: number
  provider: Provider
  eventType: string
  method: string
  path: string
  query: string
  headers: Record<string, string>
  body: string
  verdict: Verdict
  signatureScheme: string
  signatureError: string | null
  status: number
  durationMs: number
  remoteAddr: string
  replayOf?: string | null
  note?: string | null
}

export interface Store {
  append(input: NewEvent): StoredEvent
  get(id: string): StoredEvent | null
  resolveId(prefix: string): string | null
  list(query: ListQuery): { events: StoredEvent[]; nextCursor: number | null }
  stats(): Stats
  purge(options: { before?: number; all?: boolean }): number
  close(): void
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

function eventId(now: number): string {
  const time = now.toString(36).padStart(9, '0')
  const random = randomBytes(6)
  let tail = ''
  for (const byte of random) tail += ALPHABET[byte % 36]
  return time + tail
}

function prettyJson(body: string): string | null {
  const trimmed = body.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return null
  }
}

function toEvent(row: Row): StoredEvent {
  return {
    seq: Number(row.seq),
    id: String(row.id),
    receivedAt: Number(row.received_at),
    provider: String(row.provider) as Provider,
    eventType: String(row.event_type),
    method: String(row.method),
    path: String(row.path),
    query: String(row.query),
    headers: JSON.parse(String(row.headers)) as Record<string, string>,
    body: String(row.body),
    pretty: row.pretty === null ? null : String(row.pretty),
    dedupeKey: row.dedupe_key === null ? null : String(row.dedupe_key),
    duplicateOf: row.duplicate_of === null ? null : String(row.duplicate_of),
    verdict: codeToVerdict(Number(row.verdict)),
    size: Buffer.byteLength(String(row.body)),
    status: Number(row.status),
    durationMs: Number(row.duration_ms),
    remoteAddr: String(row.remote_addr),
    signatureScheme: String(row.signature_scheme),
    signatureError: row.signature_error === null ? null : String(row.signature_error),
    replayOf: row.replay_of === null ? null : String(row.replay_of),
    note: row.note === null ? null : String(row.note),
  }
}

function bodyJson(body: string): Record<string, unknown> | null {
  const trimmed = body.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    return JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    return null
  }
}

function headerId(provider: string, headers: Record<string, string>): string | null {
  const candidates: Record<string, string[]> = {
    github: ['x-github-delivery'],
    svix: ['svix-id'],
    shopify: ['x-shopify-webhook-id'],
    generic: ['x-hookline-id'],
  }
  for (const name of candidates[provider] ?? []) {
    const value = headers[name]
    if (value) return `${provider}:${value.split(',')[0]!.trim()}`
  }
  if (provider === 'slack') {
    const timestamp = headers['x-slack-request-timestamp']
    if (timestamp) return `slack:${timestamp}:${headers['x-slack-retry-num'] ?? '0'}`
  }
  return null
}

const BODY_ID_PATHS: Record<string, string[][]> = {
  stripe: [['id'], ['data', 'object', 'id']],
  twilio: [['MessageSid'], ['SmsSid'], ['CallSid']],
  slack: [['event_id']],
  generic: [['id'], ['event_id'], ['webhook_id'], ['uid']],
  unknown: [['id'], ['event_id'], ['webhook_id']],
}

function findDedupeKey(
  provider: string,
  headers: Record<string, string>,
  body: string,
): string | null {
  const fromHeader = headerId(provider, headers)
  if (fromHeader) return fromHeader
  const parsed = bodyJson(body)
  if (!parsed) return null
  for (const path of BODY_ID_PATHS[provider] ?? BODY_ID_PATHS.unknown!) {
    let cursor: unknown = parsed
    for (const step of path) {
      if (typeof cursor !== 'object' || cursor === null) {
        cursor = undefined
        break
      }
      cursor = (cursor as Record<string, unknown>)[step]
    }
    if (typeof cursor === 'string' && cursor.length > 0) return `${provider}:${cursor}`
  }
  return null
}

function guessEventType(provider: string, headers: Record<string, string>, body: string): string {
  const byHeader: Record<string, string> = {
    github: headers['x-github-event'] ?? '',
    shopify: `${headers['x-shopify-topic'] ?? ''}`,
    svix: headers['svix-type'] ?? '',
    twilio: '',
  }
  const headerValue = byHeader[provider] ?? ''
  if (headerValue) return headerValue.replace(/\s+/g, '_').toLowerCase()

  const trimmed = body.trim()
  if (!trimmed.startsWith('{')) return ''
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    return ''
  }
  const byPayload: Array<[string, string[]]> = [
    ['stripe', ['type']],
    ['generic', ['type', 'event', 'event_type', 'action', 'topic']],
    ['unknown', ['type', 'event', 'event_type', 'topic']],
  ]
  for (const [key, fields] of byPayload) {
    if (key !== provider && key !== 'unknown' && key !== 'generic') continue
    for (const field of fields) {
      const value = parsed[field]
      if (typeof value === 'string' && value.length > 0) {
        return value.replace(/\s+/g, '_').toLowerCase()
      }
    }
  }
  if (typeof parsed['status'] === 'number' && typeof parsed['message'] === 'string') {
    return 'message'
  }
  return ''
}

export function openStore(file: string): Store {
  if (file !== ':memory:') {
    mkdirSync(dirname(resolve(file)), { recursive: true })
  }
  const db = new DatabaseSync(file)
  db.exec('pragma journal_mode = wal;')
  db.exec('pragma busy_timeout = 5000;')
  db.exec('pragma synchronous = normal;')
  db.exec('pragma foreign_keys = on;')
  db.exec('create table if not exists meta (key text primary key, value text not null);')
  const applied = Number(
    (db.prepare('select value from meta where key = ?').get('schema_version') as Row | undefined)
      ?.value ?? 0,
  )
  for (let version = applied; version < MIGRATIONS.length; version++) {
    // One transaction per migration, with the version bump inside it. Before
    // this, the alters ran outside any transaction and the version was written
    // afterwards, so a crash between the two `alter table` statements left the
    // schema half-applied with the old version still recorded — and every
    // subsequent start re-ran the migration and died on `duplicate column
    // name`, bricking the inbox.
    db.exec('begin')
    try {
      MIGRATIONS[version]!(db)
      db.prepare(
        'insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value',
      ).run('schema_version', String(version + 1))
      db.exec('commit')
    } catch (error) {
      try {
        db.exec('rollback')
      } catch {
        // Already rolled back by SQLite itself; the original error is the useful one.
      }
      throw new Error(
        `schema migration ${version + 1} failed, database left unchanged: ${(error as Error).message}`,
        { cause: error },
      )
    }
  }

  const insertStmt = db.prepare(`
    insert into events (
      id, received_at, provider, event_type, method, path, query, headers, body, pretty,
      dedupe_key, duplicate_of, verdict, signature_scheme, signature_error,
      status, duration_ms, remote_addr, replay_of, note
    ) values (
      @id, @received_at, @provider, @event_type, @method, @path, @query, @headers, @body, @pretty,
      @dedupe_key, @duplicate_of, @verdict, @signature_scheme, @signature_error,
      @status, @duration_ms, @remote_addr, @replay_of, @note
    )
  `)
  const findByDedupeStmt = db.prepare(
    'select id from events where dedupe_key = ? order by seq asc limit 1',
  )

  return {
    append(input: NewEvent): StoredEvent {
      const id = eventId(input.receivedAt)
      const dedupeKey = findDedupeKey(input.provider, input.headers, input.body)
      const previous = dedupeKey
        ? (findByDedupeStmt.get(dedupeKey) as Row | undefined)
        : undefined
      const duplicateOf = previous?.id === undefined ? null : String(previous.id)
      const params: Record<string, string | number | null> = {
        id,
        received_at: input.receivedAt,
        provider: input.provider,
        event_type: guessEventType(input.provider, input.headers, input.body),
        method: input.method,
        path: input.path,
        query: input.query,
        headers: JSON.stringify(input.headers),
        body: input.body,
        pretty: prettyJson(input.body),
        dedupe_key: dedupeKey,
        duplicate_of: duplicateOf,
        verdict: verdictToCode(input.verdict),
        signature_scheme: input.signatureScheme,
        signature_error: input.signatureError,
        status: input.status,
        duration_ms: input.durationMs,
        remote_addr: input.remoteAddr,
        replay_of: input.replayOf ?? null,
        note: input.note ?? null,
      }
      insertStmt.run(params)
      const row = db.prepare('select * from events where id = ?').get(id) as Row
      return toEvent(row)
    },

    get(id: string): StoredEvent | null {
      const row = db.prepare('select * from events where id = ?').get(id) as Row | undefined
      return row ? toEvent(row) : null
    },

    resolveId(prefix: string): string | null {
      if (prefix.length >= 13) {
        return (db.prepare('select id from events where id = ?').get(prefix) as Row | undefined)
          ?.id === undefined
          ? null
          : prefix
      }
      const rows = db
        .prepare('select id from events where id like ? order by seq desc limit 2')
        .all(`${prefix}%`) as Row[]
      return rows.length === 1 ? String(rows[0]!.id) : null
    },

    list(query: ListQuery): { events: StoredEvent[]; nextCursor: number | null } {
      const clauses: string[] = []
      const params: Array<string | number> = []
      if (query.before !== undefined) {
        clauses.push('seq < ?')
        params.push(query.before)
      }
      if (query.after !== undefined) {
        clauses.push('seq > ?')
        params.push(query.after)
      }
      if (query.provider) {
        clauses.push('provider = ?')
        params.push(query.provider)
      }
      if (query.eventType) {
        clauses.push('event_type = ?')
        params.push(query.eventType)
      }
      if (query.duplicatesOnly) clauses.push('duplicate_of is not null')
      if (query.invalidOnly) clauses.push('verdict = 0')
      if (query.q) {
        clauses.push('(body like ? or event_type like ? or path like ? or headers like ?)')
        const like = `%${query.q}%`
        params.push(like, like, like, like)
      }
      const where = clauses.length > 0 ? `where ${clauses.join(' and ')}` : ''
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200)
      const rows = db
        .prepare(`select * from events ${where} order by seq desc limit ?`)
        .all(...params, limit) as Row[]
      const events = rows.map(toEvent)
      const last = events[events.length - 1]
      return { events, nextCursor: last ? last.seq : null }
    },

    stats(): Stats {
      const total = Number(
        (db.prepare('select count(*) as c from events').get() as Row).c,
      )
      const duplicates = Number(
        (db.prepare('select count(*) as c from events where duplicate_of is not null').get() as Row)
          .c,
      )
      const invalid = Number(
        (db.prepare('select count(*) as c from events where verdict = 0').get() as Row).c,
      )
      const unverified = Number(
        (db.prepare('select count(*) as c from events where verdict = 2').get() as Row).c,
      )
      const bytes = Number(
        (db.prepare('select coalesce(sum(length(body)), 0) as c from events').get() as Row).c,
      )
      const lastRow = db.prepare('select max(received_at) as t from events').get() as Row
      const byProvider = db
        .prepare('select provider, count(*) as c from events group by provider order by c desc')
        .all() as Row[]
      const byHour = db
        .prepare(
          `select (received_at / 3600000) * 3600000 as hour, count(*) as c
           from events group by hour order by hour asc limit 48`,
        )
        .all() as Row[]
      return {
        total,
        duplicates,
        invalid,
        unverified,
        bytes,
        lastEventAt: lastRow.t === null ? null : Number(lastRow.t),
        byProvider: byProvider.map((r) => ({ provider: String(r.provider), count: Number(r.c) })),
        byHour: byHour.map((r) => ({ hour: Number(r.hour), count: Number(r.c) })),
      }
    },

    purge(options: { before?: number; all?: boolean }): number {
      if (options.all) {
        const result = db.prepare('delete from events').run()
        return Number(result.changes)
      }
      if (options.before !== undefined) {
        const result = db
          .prepare('delete from events where received_at < ?')
          .run(options.before)
        return Number(result.changes)
      }
      return 0
    },

    close(): void {
      db.close()
    },
  }
}
