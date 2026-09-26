import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openStore } from '../src/store.ts'
import { signPayload } from '../src/verify.ts'

function withStore(fn: (store: ReturnType<typeof openStore>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'hookline-store-'))
  const store = openStore(join(dir, 'inbox.db'))
  try {
    fn(store)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const stripeSecret = 'whsec_test'
const eventBody = JSON.stringify({ id: 'evt_1', type: 'invoice.paid' })

function stripeEvent(store: ReturnType<typeof openStore>, overrides: { body?: string; path?: string } = {}) {
  const body = overrides.body ?? eventBody
  const headers = signPayload({ provider: 'stripe', secret: stripeSecret, rawBody: body })
  return store.append({
    receivedAt: Date.now(),
    provider: 'stripe',
    eventType: '',
    method: 'POST',
    path: overrides.path ?? '/stripe',
    query: '',
    headers,
    body,
    verdict: 'valid',
    signatureScheme: 'hmac-sha256/timestamped',
    signatureError: null,
    status: 200,
    durationMs: 3,
    remoteAddr: '127.0.0.1',
  })
}

test('append assigns sortable ids and infers event type from the payload', () => {
  withStore((store) => {
    const first = stripeEvent(store)
    const second = stripeEvent(store, { body: JSON.stringify({ id: 'evt_2', type: 'charge.failed' }) })
    assert.equal(first.eventType, 'invoice.paid')
    assert.equal(second.eventType, 'charge.failed')
    assert.ok(second.seq > first.seq)
    assert.equal(first.pretty?.includes('\n'), true)
  })
})

test('retry of the same provider id is flagged as a duplicate', () => {
  withStore((store) => {
    const first = stripeEvent(store)
    const retry = stripeEvent(store)
    assert.equal(first.duplicateOf, null)
    assert.equal(retry.duplicateOf, first.id)
  })
})

test('replay keeps the original duplicate link and records its origin', () => {
  withStore((store) => {
    const first = stripeEvent(store)
    const replay = store.append({
      receivedAt: Date.now(),
      provider: 'stripe',
      eventType: '',
      method: 'POST',
      path: '/stripe',
      query: '',
      headers: { 'stripe-signature': 't=1,v1=deadbeef' },
      body: eventBody,
      verdict: 'valid',
      signatureScheme: 'hmac-sha256/timestamped',
      signatureError: null,
      status: 200,
      durationMs: 1,
      remoteAddr: 'replay',
      replayOf: first.id,
      note: 'replay',
    })
    assert.equal(replay.replayOf, first.id)
    assert.equal(replay.note, 'replay')
    assert.equal(replay.duplicateOf, first.id)
  })
})

test('list filters by provider, text and duplicate flag', () => {
  withStore((store) => {
    stripeEvent(store)
    stripeEvent(store)
    store.append({
      receivedAt: Date.now(),
      provider: 'github',
      eventType: '',
      method: 'POST',
      path: '/gh',
      query: '',
      headers: { 'x-github-delivery': 'd1', 'x-github-event': 'push' },
      body: JSON.stringify({ ref: 'refs/heads/main' }),
      verdict: 'unverified',
      signatureScheme: 'hmac-sha256/hex',
      signatureError: null,
      status: 200,
      durationMs: 1,
      remoteAddr: '127.0.0.1',
    })
    assert.equal(store.list({ provider: 'github' }).events.length, 1)
    assert.equal(store.list({ provider: 'stripe' }).events.length, 2)
    assert.equal(store.list({ q: 'main' }).events.length, 1)
    assert.equal(store.list({ duplicatesOnly: true }).events.length, 1)
    assert.equal(store.list({ eventType: 'invoice.paid' }).events.length, 2)
    assert.equal(store.list({ limit: 1 }).events.length, 1)
  })
})

test('list paginates with a cursor instead of skipping rows', () => {
  withStore((store) => {
    for (let index = 0; index < 5; index++) {
      stripeEvent(store, { body: JSON.stringify({ id: `evt_${index}`, type: 'ping' }) })
    }
    const first = store.list({ limit: 2 })
    assert.equal(first.events.length, 2)
    const second = store.list({ limit: 2, before: first.nextCursor! })
    assert.equal(second.events.length, 2)
    const ids = new Set([...first.events, ...second.events].map((event) => event.id))
    assert.equal(ids.size, 4)
  })
})

test('stats aggregate by provider and count invalid signatures', () => {
  withStore((store) => {
    stripeEvent(store)
    stripeEvent(store)
    store.append({
      receivedAt: Date.now(),
      provider: 'unknown',
      eventType: '',
      method: 'GET',
      path: '/favicon.ico',
      query: '',
      headers: {},
      body: '',
      verdict: 'unverified',
      signatureScheme: 'none',
      signatureError: null,
      status: 200,
      durationMs: 0,
      remoteAddr: '',
    })
    const stats = store.stats()
    assert.equal(stats.total, 3)
    assert.equal(stats.duplicates, 1)
    assert.equal(stats.unverified, 1)
    assert.equal(stats.byProvider[0]?.provider, 'stripe')
    assert.equal(stats.byProvider[0]?.count, 2)
    assert.ok(stats.bytes > 0)
  })
})

test('purge respects the retention cutoff and can wipe everything', () => {
  withStore((store) => {
    const old = store.append({
      receivedAt: Date.now() - 10 * 86_400_000,
      provider: 'generic',
      eventType: '',
      method: 'POST',
      path: '/old',
      query: '',
      headers: {},
      body: '{}',
      verdict: 'unverified',
      signatureScheme: 'none',
      signatureError: null,
      status: 200,
      durationMs: 0,
      remoteAddr: '',
    })
    stripeEvent(store)
    assert.equal(old.receivedAt < Date.now() - 5 * 86_400_000, true)
    assert.equal(store.purge({ before: Date.now() - 5 * 86_400_000 }), 1)
    assert.equal(store.stats().total, 1)
    assert.equal(store.purge({ all: true }), 1)
    assert.equal(store.stats().total, 0)
  })
})

test('migrations are idempotent across reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hookline-migrate-'))
  const file = join(dir, 'inbox.db')
  try {
    const first = openStore(file)
    stripeEvent(first)
    first.close()
    const second = openStore(file)
    assert.equal(second.stats().total, 1)
    const event = second.list({}).events[0]!
    assert.equal(event.replayOf, null)
    assert.equal(event.note, null)
    second.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a database left half-migrated by an older build repairs itself', () => {
  // Older builds ran the two `alter table add column` statements outside a
  // transaction and recorded the version afterwards, so a crash in between left
  // `replay_of` present, `note` missing, and the version still claiming 1. The
  // next start re-ran the migration and died on `duplicate column name`, which
  // bricked the inbox permanently.
  const dir = mkdtempSync(join(tmpdir(), 'hookline-migrate-legacy-'))
  const file = join(dir, 'inbox.db')
  try {
    const first = openStore(file)
    const seeded = stripeEvent(first)
    first.close()

    const damaged = new DatabaseSync(file)
    damaged.exec('alter table events drop column note')
    damaged
      .prepare('update meta set value = ? where key = ?')
      .run('1', 'schema_version')
    damaged.close()

    const repaired = openStore(file)
    try {
      const event = repaired.get(seeded.id)!
      assert.equal(event.note, null, 'the missing column is added back')
      assert.equal(event.replayOf, null, 'the column already there is left alone')
      const version = (
        new DatabaseSync(file)
          .prepare('select value from meta where key = ?')
          .get('schema_version') as { value: string }
      ).value
      assert.equal(version, '2')
    } finally {
      repaired.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a failed migration rolls back and says so', () => {
  // The version bump shares the migration's transaction, so a failure can
  // never be recorded as applied — otherwise the next start would skip the
  // migration that never actually finished.
  const dir = mkdtempSync(join(tmpdir(), 'hookline-migrate-fail-'))
  const file = join(dir, 'inbox.db')
  try {
    const broken = new DatabaseSync(file)
    broken.exec('create table meta (key text primary key, value text not null)')
    // An `events` table with none of the expected columns: `create table if not
    // exists` is a no-op, and the index on `provider` then fails.
    broken.exec('create table events (seq integer primary key)')
    broken.prepare('insert into meta (key, value) values (?, ?)').run('schema_version', '0')
    broken.close()

    assert.throws(() => openStore(file), /schema migration 1 failed, database left unchanged/)

    const after = new DatabaseSync(file)
    const version = (
      after.prepare('select value from meta where key = ?').get('schema_version') as {
        value: string
      }
    ).value
    assert.equal(version, '0', 'the failed migration must not be recorded as applied')
    after.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
