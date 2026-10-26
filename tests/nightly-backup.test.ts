// tests/nightly-backup.test.ts -- nightly D1 -> R2 backup (src/backup/nightly.ts). Real migrated schema (backup_runs from
// migration 0259), fake fetch (Cloudflare REST export + signed URL + Telegram) and a fake R2 bucket. No network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import type { Env } from '../src/types'
import {
  backupKey, manifestKey, runNightlyBackup, selectRetention, startNightlyBackup,
  type BackupStep, type Manifest,
} from '../src/backup/nightly'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const SQL = 'CREATE TABLE t (id INTEGER);\nINSERT INTO t VALUES (1);\n'.repeat(50)
const SIGNED = 'https://signed.example.invalid/dump.sql?sig=SECRET123'
const TOKEN = 'cf-backup-token-value'

// ── fake R2 ──────────────────────────────────────────────────────────────────
class FakeR2 {
  objects = new Map<string, Uint8Array>()
  deletes: string[] = []
  corruptKeySuffix: string | null = null
  private store(key: string, bytes: Uint8Array): void {
    const out = bytes.slice()
    if (this.corruptKeySuffix && key.endsWith(this.corruptKeySuffix)) out[out.length - 1] ^= 0xff
    this.objects.set(key, out)
  }
  async put(key: string, value: string | Uint8Array): Promise<void> {
    this.store(key, typeof value === 'string' ? new TextEncoder().encode(value) : value)
  }
  async get(key: string): Promise<{ body: ReadableStream<Uint8Array>; json(): Promise<unknown>; size: number } | null> {
    const b = this.objects.get(key)
    if (!b) return null
    return {
      body: new Response(b).body as ReadableStream<Uint8Array>,
      json: async () => JSON.parse(new TextDecoder().decode(b)),
      size: b.byteLength,
    }
  }
  async delete(keys: string | string[]): Promise<void> {
    for (const k of Array.isArray(keys) ? keys : [keys]) { this.deletes.push(k); this.objects.delete(k) }
  }
  async list(opts: { prefix?: string; cursor?: string }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }> {
    const all = [...this.objects.keys()].filter((k) => k.startsWith(opts.prefix ?? '')).sort()
    const start = opts.cursor ? Number(opts.cursor) : 0
    const page = all.slice(start, start + 7) // tiny pages so pagination is exercised
    const next = start + 7
    return { objects: page.map((key) => ({ key })), truncated: next < all.length, cursor: String(next) }
  }
  async createMultipartUpload(key: string) {
    const parts: Uint8Array[] = []
    return {
      uploadPart: async (n: number, data: Uint8Array) => { parts[n - 1] = data; return { partNumber: n, etag: `e${n}` } },
      complete: async () => { this.store(key, Uint8Array.from(parts.flatMap((p) => [...p]))) },
      abort: async () => undefined,
    }
  }
}

const step: BackupStep = {
  do: (async (_name: string, a: unknown, b?: unknown) => (typeof a === 'function' ? a : b as () => Promise<unknown>)()) as BackupStep['do'],
  sleep: async () => undefined,
}

interface Calls { urls: string[]; auth: Array<string | null>; telegram: string[] }
function stubFetch(exportScript: Array<Record<string, unknown>>): Calls {
  const calls: Calls = { urls: [], auth: [], telegram: [] }
  const queue = [...exportScript]
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.urls.push(url)
    calls.auth.push(new Headers(init?.headers).get('authorization'))
    if (url.startsWith('https://api.telegram.org/')) {
      calls.telegram.push(String(JSON.parse(String(init?.body)).text))
      return new Response('{"ok":true}', { status: 200 })
    }
    if (url === SIGNED) return new Response(SQL, { status: 200 })
    if (url.includes('/d1/database/') && url.endsWith('/export')) {
      const next = queue.shift()
      if (!next) throw new Error('unexpected extra export call')
      return new Response(JSON.stringify(next), { status: 200 })
    }
    throw new Error(`unexpected fetch ${url}`)
  })
  return calls
}

const ACTIVE = { success: true, result: { status: 'active', at_bookmark: 'bm-1' } }
const COMPLETE = { success: true, result: { status: 'complete', at_bookmark: 'bm-1', result: { filename: 'x.sql', signed_url: SIGNED } } }
const EXPORT_ERR = { success: true, result: { status: 'error', at_bookmark: 'bm-1', error: 'boom' } }

let h: SqliteD1Harness
let r2: FakeR2
const TODAY = '2026-10-26'
function envOf(over: Partial<Env> = {}): Env {
  // as: the test supplies only the bindings the backup reads; the rest of Env is irrelevant here.
  return {
    DB: h.db, NIGHTLY_BACKUP: '1', BACKUPS: r2 as unknown as R2Bucket,
    BACKUP_CF_API_TOKEN: TOKEN, BACKUP_ACCOUNT_ID: 'acct', BACKUP_D1_ID: 'dbid',
    TELEGRAM_BOT_TOKEN: '123456:telegramtoken', TELEGRAM_CHAT_ID: '42', ...over,
  } as unknown as Env
}
const rows = () => h.sqlite.prepare('SELECT * FROM backup_runs').all() as Array<Record<string, unknown>>

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  r2 = new FakeR2()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})
afterEach(() => { h.close(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('nightly backup', () => {
  it('happy path: polls, stores a gzip dump, writes a manifest, records ok, sends no alert', async () => {
    const calls = stubFetch([ACTIVE, COMPLETE])
    const out = await runNightlyBackup(envOf(), { runDate: TODAY }, step)
    expect(out.status).toBe('ok')

    const gz = r2.objects.get(backupKey(TODAY))
    expect(gz).toBeDefined()
    expect(gunzipSync(Buffer.from(gz ?? new Uint8Array())).toString()).toBe(SQL)

    const manifest = JSON.parse(new TextDecoder().decode(r2.objects.get(manifestKey(TODAY)))) as Manifest
    expect(manifest.sha256).toBe(createHash('sha256').update(gz ?? new Uint8Array()).digest('hex'))
    expect(manifest.size_bytes).toBe(gz?.byteLength)
    expect(manifest.raw_bytes).toBe(Buffer.byteLength(SQL))
    expect(manifest.bookmark).toBe('bm-1')
    expect(manifest.started_at <= manifest.finished_at).toBe(true)

    const [row] = rows()
    expect(row).toMatchObject({ status: 'ok', r2_key: backupKey(TODAY), sha256: manifest.sha256, size_bytes: manifest.size_bytes, bookmark: 'bm-1' })
    expect(calls.telegram).toEqual([])
    // export calls carry the dedicated token; the signed URL download must not
    expect(calls.auth[0]).toBe(`Bearer ${TOKEN}`)
    expect(calls.auth[calls.urls.indexOf(SIGNED)]).toBeNull()
  })

  it('missing secret: records skipped:no_credential and sends exactly one alert, no export call', async () => {
    const calls = stubFetch([])
    const out = await runNightlyBackup(envOf({ BACKUP_CF_API_TOKEN: undefined }), { runDate: TODAY }, step)
    expect(out.status).toBe('skipped:no_credential')
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({ status: 'skipped:no_credential', alerted: 1 })
    expect(calls.telegram).toHaveLength(1)
    expect(calls.telegram[0]).toContain('BACKUP_CF_API_TOKEN')
    expect(calls.urls.some((u) => u.includes('/export'))).toBe(false)
    expect(r2.objects.size).toBe(0)
  })

  it('export failure: one alert, a failed row, nothing stored, nothing deleted', async () => {
    r2.objects.set(backupKey('2026-10-01'), new Uint8Array([1]))
    const calls = stubFetch([EXPORT_ERR])
    const out = await runNightlyBackup(envOf(), { runDate: TODAY }, step)
    expect(out.status).toBe('failed')
    expect(calls.telegram).toHaveLength(1)
    expect(calls.telegram[0]).toContain('boom')
    expect(rows()[0]).toMatchObject({ status: 'failed', alerted: 1 })
    expect(r2.objects.has(backupKey(TODAY))).toBe(false)
    expect(r2.deletes).toEqual([])
  })

  it('alert text never carries the signed URL or the API token', async () => {
    const calls = stubFetch([COMPLETE])
    r2.corruptKeySuffix = '.sql.gz' // forces verify_failed after the signed URL was used
    await runNightlyBackup(envOf(), { runDate: TODAY }, step)
    for (const t of calls.telegram) { expect(t).not.toContain('SECRET123'); expect(t).not.toContain(TOKEN) }
  })

  describe('retention', () => {
    const iso = (d: Date) => d.toISOString().slice(0, 10)
    function seed(): { daily: string[]; monthly: string[] } {
      const daily: string[] = []
      for (let i = 1; i <= 45; i++) daily.push(iso(new Date(Date.UTC(2026, 9, 26 - i)))) // 2026-10-25 back 45 days
      const monthly: string[] = []
      for (let m = 0; m < 16; m++) monthly.push(iso(new Date(Date.UTC(2026, 8 - m, 1)))) // 2026-09-01 back 16 months
      for (const d of new Set([...daily, ...monthly])) {
        r2.objects.set(backupKey(d), new Uint8Array([1]))
        r2.objects.set(manifestKey(d), new Uint8Array([1]))
      }
      r2.objects.set('d1/mupot/README.txt', new Uint8Array([1]))
      r2.objects.set('other/2020-01-02.sql.gz', new Uint8Array([1]))
      return { daily, monthly }
    }

    it('after a verified dump: keeps 30 daily + 12 monthly (1st of month), deletes the rest, touches nothing foreign', async () => {
      const { daily } = seed()
      stubFetch([COMPLETE])
      const out = await runNightlyBackup(envOf(), { runDate: TODAY }, step)
      expect(out.status).toBe('ok')
      const dates = new Set([...r2.objects.keys()].map((k) => /(\d{4}-\d{2}-\d{2})\./.exec(k)?.[1]).filter(Boolean))
      const newest29 = daily.slice(0, 29) // + today = 30 daily
      for (const d of [TODAY, ...newest29]) expect(r2.objects.has(backupKey(d))).toBe(true)
      expect(r2.objects.has(backupKey(daily[40]))).toBe(false) // old, not a 1st
      const kept1sts = [...dates].filter((d) => d?.endsWith('-01'))
      expect(kept1sts.length).toBe(12)
      expect(r2.objects.has(backupKey('2026-09-01'))).toBe(true)
      expect(r2.objects.has(backupKey('2025-11-01'))).toBe(true) // 12th newest 1st (2026-10-01 is among them)
      expect(r2.objects.has(backupKey('2025-10-01'))).toBe(false)
      expect(r2.objects.has(manifestKey('2025-10-01'))).toBe(false) // manifests go with their dump
      expect(r2.objects.has('d1/mupot/README.txt')).toBe(true)
      expect(r2.objects.has('other/2020-01-02.sql.gz')).toBe(true)
    })

    it('a dump that fails verification deletes NOTHING and alerts', async () => {
      seed()
      const before = r2.objects.size
      const calls = stubFetch([COMPLETE])
      r2.corruptKeySuffix = '.sql.gz'
      const out = await runNightlyBackup(envOf(), { runDate: TODAY }, step)
      expect(out.status).toBe('failed')
      expect(out.error).toContain('sha256_mismatch')
      expect(r2.deletes).toEqual([])
      expect(r2.objects.size).toBe(before + 2) // only today's (bad) dump + manifest were added
      expect(calls.telegram).toHaveLength(1)
      expect(rows()[0]).toMatchObject({ status: 'failed' })
    })

    it('selectRetention is pure: protects today and never removes the newest 30 or the newest 12 firsts', () => {
      const dates = Array.from({ length: 60 }, (_, i) => iso(new Date(Date.UTC(2026, 9, 26 - i))))
      const { keep, remove } = selectRetention(dates, TODAY)
      expect(keep).toContain(TODAY)
      expect(keep.length + remove.length).toBe(60)
      expect(remove).not.toContain(dates[29])
      expect(remove).toContain(dates[59] === '2026-08-28' ? '2026-08-28' : dates[59])
    })
  })

  describe('flag', () => {
    it('NIGHTLY_BACKUP off: runNightlyBackup does nothing at all', async () => {
      const calls = stubFetch([])
      const out = await runNightlyBackup(envOf({ NIGHTLY_BACKUP: undefined }), { runDate: TODAY }, step)
      expect(out.status).toBe('disabled')
      expect(calls.urls).toEqual([])
      expect(rows()).toHaveLength(0)
      expect(r2.objects.size).toBe(0)
    })

    it('NIGHTLY_BACKUP off: the cron entry does not start the workflow or alert', async () => {
      const calls = stubFetch([])
      const create = vi.fn()
      await startNightlyBackup(envOf({ NIGHTLY_BACKUP: '0', BACKUP_WORKFLOW: { create, get: vi.fn() } }), new Date('2026-10-26T03:17:00Z'))
      expect(create).not.toHaveBeenCalled()
      expect(calls.urls).toEqual([])
    })

    it('NIGHTLY_BACKUP on: the cron entry starts one workflow instance per date', async () => {
      const create = vi.fn(async () => ({ id: 'x' }))
      await startNightlyBackup(envOf({ BACKUP_WORKFLOW: { create, get: vi.fn() } }), new Date('2026-10-26T03:17:00Z'))
      expect(create).toHaveBeenCalledWith({ id: 'd1-backup-2026-10-26', params: { runDate: '2026-10-26' } })
    })

    it('NIGHTLY_BACKUP on but no workflow binding: alerts instead of staying silent', async () => {
      const calls = stubFetch([])
      await startNightlyBackup(envOf(), new Date('2026-10-26T03:17:00Z'))
      expect(calls.telegram).toHaveLength(1)
      expect(calls.telegram[0]).toContain('BACKUP_WORKFLOW')
    })
  })
})
