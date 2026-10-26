// mupot -- nightly off-site backup of the D1 database to R2 (Cloudflare-native; no dependency on any host).
//
// Shape: a Cron trigger (BACKUP_CRON, see src/index.ts) starts the BackupWorkflow (src/workflows/task-workflow.ts (BackupWorkflow)), which
// calls runNightlyBackup() below. All logic lives here, behind a StepLike seam, so it is unit-testable without the Workers
// runtime (same split as src/workflows/pipeline.ts).
//
// EXPORT FLOW (D1 REST API, verified 2026-10-26 against the Cloudflare API schema and
// https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/ ):
//   1. POST /accounts/{account}/d1/database/{db}/export  body {"output_format":"polling"}
//      -> result {status, at_bookmark, messages, result?: {filename, signed_url}, error?}
//   2. while status is not complete/error: POST the same URL with {"output_format":"polling","current_bookmark":<at_bookmark>}
//      (an in-progress export that is not polled is cancelled by Cloudflare, so we poll every EXPORT_POLL_SECONDS)
//   3. on status "complete": GET result.signed_url (valid one hour; NO Authorization header on that request).
//   at_bookmark is the D1 Time Travel bookmark the dump is consistent with; it is recorded in the manifest.
//   A running export blocks other queries on the database, so the dump is taken at a quiet hour (03:17 UTC).
//
// GUARANTEES (each has a test in tests/nightly-backup.test.ts):
//   - flag off (NIGHTLY_BACKUP != "1") => nothing runs, nothing is written.
//   - missing credential/config => a backup_runs row 'skipped:no_credential' AND one alert. Never silent.
//   - any failure => one alert, then a 'failed' row. The alert goes out BEFORE the D1 write: D1 is the thing being exported.
//   - retention deletes ONLY after the new dump is verified (size > 0 and the sha256 of the bytes now in R2 equals the
//     manifest stored next to it). A failed verification deletes nothing.

import type { Env } from '../types'
import { notifyHadi } from '../telegram-bridge/bus_notify'

export const BACKUP_CRON = '17 3 * * *'
export const KEY_PREFIX = 'd1/mupot/'
export const DAILY_KEEP = 30
export const MONTHLY_KEEP = 12
export const EXPORT_POLL_SECONDS = 5
export const EXPORT_MAX_POLLS = 120 // ten minutes
const PART_BYTES = 8 * 1024 * 1024 // R2 multipart: every part but the last must be >= 5 MiB
const STALE_RUNNING_HOURS = 2

export interface BackupParams {
  /** UTC date, YYYY-MM-DD, the dump is filed under. */
  runDate: string
}

export type BackupStatus = 'ok' | 'failed' | 'skipped:no_credential' | 'disabled'
export interface BackupOutcome {
  status: BackupStatus
  key?: string
  sha256?: string
  sizeBytes?: number
  error?: string
  deleted?: string[]
}

/** The subset of the Workflows `step` the backup uses. WorkflowStep satisfies it. */
export interface BackupStep {
  do<T>(name: string, cb: () => Promise<T>): Promise<T>
  do<T>(name: string, config: { retries?: { limit: number; delay: string | number; backoff?: 'linear' | 'constant' | 'exponential' }; timeout?: string }, cb: () => Promise<T>): Promise<T>
  sleep(name: string, duration: string | number): Promise<void>
}

export interface Manifest {
  version: 1
  key: string
  sha256: string
  size_bytes: number
  raw_bytes: number
  bookmark: string | null
  started_at: string
  finished_at: string
}

export const backupKey = (date: string): string => `${KEY_PREFIX}${date}.sql.gz`
export const manifestKey = (date: string): string => `${KEY_PREFIX}${date}.manifest.json`

const DATE_KEY = /^d1\/mupot\/(\d{4}-\d{2}-\d{2})\.(sql\.gz|manifest\.json)$/

// ── retention (pure) ─────────────────────────────────────────────────────────

/**
 * Which dates to keep: the newest DAILY_KEEP distinct dates, plus the newest MONTHLY_KEEP dates that fall on the 1st
 * of a month. `protect` (today's freshly verified dump) is always kept. Returns the dates to delete.
 */
export function selectRetention(dates: readonly string[], protect: string): { keep: string[]; remove: string[] } {
  const unique = [...new Set(dates)].sort().reverse()
  const keep = new Set<string>([protect])
  for (const d of unique.slice(0, DAILY_KEEP)) keep.add(d)
  for (const d of unique.filter((x) => x.endsWith('-01')).slice(0, MONTHLY_KEEP)) keep.add(d)
  return { keep: unique.filter((d) => keep.has(d)), remove: unique.filter((d) => !keep.has(d)) }
}

async function listDatedKeys(bucket: R2Bucket): Promise<Map<string, string[]>> {
  const byDate = new Map<string, string[]>()
  let cursor: string | undefined
  for (;;) {
    const page = await bucket.list({ prefix: KEY_PREFIX, cursor })
    for (const o of page.objects) {
      const m = DATE_KEY.exec(o.key)
      if (!m) continue // never touch anything that is not one of our dated dump/manifest keys
      byDate.set(m[1], [...(byDate.get(m[1]) ?? []), o.key])
    }
    if (!page.truncated) return byDate
    cursor = page.cursor
  }
}

// ── hashing ──────────────────────────────────────────────────────────────────

const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

interface Sha256Sink {
  write(chunk: Uint8Array): Promise<void>
  hex(): Promise<string>
}

// Workers expose crypto.DigestStream (incremental, constant memory). Node (the test runtime) does not, so the fallback
// buffers and uses subtle.digest. DigestStream is not in the DOM lib typings, hence the narrow structural type below.
interface DigestStreamCtor { new (algorithm: string): WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> } }
function newSha256Sink(): Sha256Sink {
  // as: DigestStream exists only in the Workers runtime and is absent from the TS lib; guarded by the typeof check.
  const Ctor = (crypto as unknown as { DigestStream?: DigestStreamCtor }).DigestStream
  if (Ctor) {
    const ds = new Ctor('SHA-256')
    const writer = ds.getWriter()
    return {
      write: (c) => writer.write(c),
      hex: async () => {
        await writer.close()
        return hex(await ds.digest)
      },
    }
  }
  const chunks: Uint8Array[] = []
  return {
    write: async (c) => { chunks.push(c) },
    hex: async () => {
      const all = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
      let off = 0
      for (const c of chunks) { all.set(c, off); off += c.byteLength }
      return hex(await crypto.subtle.digest('SHA-256', all))
    },
  }
}

/** Stream a readable through the sha256 sink; returns the digest and the byte count. */
async function digestStream(body: ReadableStream<Uint8Array>): Promise<{ sha256: string; size: number }> {
  const sink = newSha256Sink()
  const reader = body.getReader()
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    await sink.write(value)
  }
  return { sha256: await sink.hex(), size }
}

// ── export (Cloudflare REST) ─────────────────────────────────────────────────

interface ExportState { status: 'active' | 'complete' | 'error'; bookmark: string | null; signedUrl?: string; error?: string }

interface ExportEnvelope {
  success?: boolean
  errors?: Array<{ message?: string }>
  result?: { status?: string; at_bookmark?: string; error?: string; result?: { signed_url?: string } }
}

async function callExport(env: Env, body: Record<string, unknown>): Promise<ExportState> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.BACKUP_ACCOUNT_ID}/d1/database/${env.BACKUP_D1_ID}/export`
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.BACKUP_CF_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as ExportEnvelope
  if (!res.ok || json.success === false) {
    const why = json.errors?.map((e) => e.message).filter(Boolean).join('; ') ?? ''
    throw new Error(`d1_export_http_${res.status}${why ? `: ${why}` : ''}`)
  }
  const r = json.result
  const bookmark = r?.at_bookmark ?? null
  if (r?.status === 'complete') {
    const signedUrl = r.result?.signed_url
    if (!signedUrl) throw new Error('d1_export_complete_without_signed_url')
    return { status: 'complete', bookmark, signedUrl }
  }
  if (r?.status === 'error') return { status: 'error', bookmark, error: r.error ?? 'unknown export error' }
  return { status: 'active', bookmark }
}

// ── store: download -> gzip -> R2 multipart (constant memory) ────────────────

async function storeDump(bucket: R2Bucket, signedUrl: string, key: string): Promise<{ sha256: string; size: number; raw: number }> {
  const res = await fetch(signedUrl) // signed URL: deliberately NO Authorization header
  if (!res.ok || !res.body) throw new Error(`dump_download_http_${res.status}`)
  let raw = 0
  let sawContent = false // any byte that is not ASCII whitespace
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      raw += chunk.byteLength
      if (!sawContent) sawContent = chunk.some((b) => b !== 0x20 && (b < 0x09 || b > 0x0d))
      controller.enqueue(chunk)
    },
  })
  const gz = res.body.pipeThrough(counter).pipeThrough(new CompressionStream('gzip'))

  const upload = await bucket.createMultipartUpload(key)
  try {
    const sink = newSha256Sink()
    const parts: R2UploadedPart[] = []
    let buf: Uint8Array[] = []
    let buffered = 0
    let size = 0
    const flush = async (): Promise<void> => {
      if (buffered === 0) return
      const part = new Uint8Array(buffered)
      let off = 0
      for (const c of buf) { part.set(c, off); off += c.byteLength }
      parts.push(await upload.uploadPart(parts.length + 1, part))
      buf = []
      buffered = 0
    }
    const reader = gz.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      await sink.write(value)
      size += value.byteLength
      buf.push(value)
      buffered += value.byteLength
      if (buffered >= PART_BYTES) await flush()
    }
    // An empty / whitespace-only export gzips to ~20 bytes and would pass the size check; refuse it before it is
    // completed in R2 (the multipart upload is aborted below, so nothing is stored).
    if (!sawContent) throw new Error('dump_empty_sql')
    await flush()
    if (size === 0) throw new Error('dump_empty')
    await upload.complete(parts)
    return { sha256: await sink.hex(), size, raw }
  } catch (err) {
    await upload.abort().catch(() => undefined)
    throw err
  }
}

// ── verify: the bytes now in R2 against the manifest stored next to them ─────

export async function verifyDump(bucket: R2Bucket, date: string): Promise<{ ok: boolean; reason?: string }> {
  const mObj = await bucket.get(manifestKey(date))
  if (!mObj) return { ok: false, reason: 'manifest_missing' }
  const manifest = (await mObj.json()) as Partial<Manifest>
  const dump = await bucket.get(backupKey(date))
  if (!dump) return { ok: false, reason: 'dump_missing' }
  const { sha256, size } = await digestStream(dump.body)
  if (size <= 0) return { ok: false, reason: 'dump_empty' }
  if (size !== manifest.size_bytes) return { ok: false, reason: 'size_mismatch' }
  if (sha256 !== manifest.sha256) return { ok: false, reason: 'sha256_mismatch' }
  return { ok: true }
}

// ── alerting (the existing Telegram notify path; no new channel) ─────────────

const redact = (s: string): string => s.replace(/https?:\/\/\S+/g, '<url>').slice(0, 500)

async function alert(env: Env, kind: 'failed' | 'skipped', date: string, message: string): Promise<boolean> {
  try {
    const r = await notifyHadi(env, { type: `backup.${kind}`, title: `D1 nightly backup ${date}`, message })
    return r.delivered
  } catch (err) {
    console.error('[backup] alert threw', redact(String(err)))
    return false
  }
}

async function record(env: Env, sql: string, ...binds: unknown[]): Promise<void> {
  await env.DB.prepare(sql).bind(...binds).run()
}

// ── orchestration ────────────────────────────────────────────────────────────

export async function runNightlyBackup(env: Env, params: BackupParams, step: BackupStep): Promise<BackupOutcome> {
  if (env.NIGHTLY_BACKUP !== '1') return { status: 'disabled' }
  const date = params.runDate

  interface Begin { id: string; startedAt: string; skip: string | null }
  let begin: Begin
  try {
    begin = await step.do('begin', async (): Promise<Begin> => {
    const missing = [
      !env.BACKUP_CF_API_TOKEN && 'BACKUP_CF_API_TOKEN',
      !env.BACKUP_ACCOUNT_ID && 'BACKUP_ACCOUNT_ID',
      !env.BACKUP_D1_ID && 'BACKUP_D1_ID',
      !env.BACKUPS && 'BACKUPS (R2 binding)',
    ].filter(Boolean)
    const id = `bk-${date}-${crypto.randomUUID().slice(0, 8)}`
    const startedAt = new Date().toISOString()
    if (missing.length > 0) {
      const msg = `skipped:no_credential, missing ${missing.join(', ')}`
      const alerted = await alert(env, 'skipped', date, msg)
      await record(
        env,
        `INSERT INTO backup_runs (id, run_date, status, error, alerted, started_at, finished_at) VALUES (?, ?, 'skipped:no_credential', ?, ?, ?, ?)`,
        id, date, msg, alerted ? 1 : 0, startedAt, startedAt,
      ).catch((e) => console.error('[backup] skip row not written', redact(String(e))))
      return { id, startedAt, skip: msg }
    }
    // A run that died mid-flight leaves 'running' forever; close those out so the table never lies.
    await record(
      env,
      `UPDATE backup_runs SET status = 'failed', error = 'abandoned (run never finished)', finished_at = ?
         WHERE status = 'running' AND started_at < ?`,
      startedAt, new Date(Date.now() - STALE_RUNNING_HOURS * 3_600_000).toISOString(),
    )
    await record(env, `INSERT INTO backup_runs (id, run_date, status, started_at) VALUES (?, ?, 'running', ?)`, id, date, startedAt)
    return { id, startedAt, skip: null }
  })
  } catch (err) {
    // Initialization (D1 unavailable, init writes) must reach the same failure path: alert first, then best-effort row.
    const message = redact(err instanceof Error ? err.message : String(err))
    const alerted = await alert(env, 'failed', date, `begin failed: ${message}`)
    const now = new Date().toISOString()
    await record(
      env,
      `INSERT INTO backup_runs (id, run_date, status, error, alerted, started_at, finished_at) VALUES (?, ?, 'failed', ?, ?, ?, ?)`,
      `bk-${date}-${crypto.randomUUID().slice(0, 8)}`, date, `begin failed: ${message}`, alerted ? 1 : 0, now, now,
    ).catch((e) => console.error('[backup] failure row not written', redact(String(e))))
    return { status: 'failed', error: `begin failed: ${message}` }
  }
  if (begin.skip) return { status: 'skipped:no_credential', error: begin.skip }

  // as: begin.skip === null proved BACKUPS is set above (the missing-list check); narrowing does not cross the step.
  const bucket = env.BACKUPS as R2Bucket
  const key = backupKey(date)
  try {
    let state = await step.do('export-start', { retries: { limit: 1, delay: '30 seconds' } }, () =>
      callExport(env, { output_format: 'polling' }))
    for (let i = 0; state.status === 'active'; i++) {
      if (i >= EXPORT_MAX_POLLS) throw new Error('d1_export_timeout')
      await step.sleep(`export-wait-${i}`, `${EXPORT_POLL_SECONDS} seconds`)
      const current = state
      state = await step.do(`export-poll-${i}`, { retries: { limit: 2, delay: '10 seconds' } }, async () => {
        const next = await callExport(env, { output_format: 'polling', current_bookmark: current.bookmark })
        return { ...next, bookmark: next.bookmark ?? current.bookmark }
      })
    }
    if (state.status === 'error' || !state.signedUrl) throw new Error(`d1_export_failed: ${state.error ?? 'no url'}`)
    const { signedUrl, bookmark } = state

    const stored = await step.do('store', { retries: { limit: 2, delay: '1 minute' }, timeout: '30 minutes' }, () =>
      storeDump(bucket, signedUrl, key))

    const finishedAt = await step.do('manifest', async () => {
      const finished = new Date().toISOString()
      const manifest: Manifest = {
        version: 1, key, sha256: stored.sha256, size_bytes: stored.size, raw_bytes: stored.raw,
        bookmark, started_at: begin.startedAt, finished_at: finished,
      }
      await bucket.put(manifestKey(date), JSON.stringify(manifest, null, 2), { httpMetadata: { contentType: 'application/json' } })
      return finished
    })

    const verdict = await step.do('verify', () => verifyDump(bucket, date))
    if (!verdict.ok) throw new Error(`verify_failed: ${verdict.reason}`)

    // Only past this line, with a verified dump, may anything old be deleted.
    const deleted = await step.do('retention', async () => {
      const byDate = await listDatedKeys(bucket)
      // Only dates with BOTH a dump and its manifest count as backups; orphans from failed runs neither occupy a
      // retention slot nor get deleted here (they may be the only copy of something).
      const complete = [...byDate.entries()]
        .filter(([d, ks]) => ks.includes(backupKey(d)) && ks.includes(manifestKey(d)))
        .map(([d]) => d)
      const { remove } = selectRetention(complete, date)
      const keys = remove.flatMap((d) => byDate.get(d) ?? [])
      if (keys.length > 0) await bucket.delete(keys)
      return keys
    })

    await step.do('finish', () =>
      record(
        env,
        `UPDATE backup_runs SET status = 'ok', r2_key = ?, sha256 = ?, size_bytes = ?, bookmark = ?, finished_at = ? WHERE id = ?`,
        key, stored.sha256, stored.size, bookmark, finishedAt, begin.id,
      ))
    return { status: 'ok', key, sha256: stored.sha256, sizeBytes: stored.size, deleted }
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err))
    const alerted = await step.do('alert-failure', () => alert(env, 'failed', date, message))
    await step
      .do('record-failure', () =>
        record(env, `UPDATE backup_runs SET status = 'failed', error = ?, alerted = ?, finished_at = ? WHERE id = ?`,
          message, alerted ? 1 : 0, new Date().toISOString(), begin.id))
      .catch((e) => console.error('[backup] failure row not written', redact(String(e))))
    return { status: 'failed', error: message }
  }
}

/** Cron entry: start the Workflow. Idempotent per date (the instance id is the date). Never silent on misconfiguration. */
export async function startNightlyBackup(env: Env, scheduledAt: Date): Promise<void> {
  if (env.NIGHTLY_BACKUP !== '1') return
  const runDate = scheduledAt.toISOString().slice(0, 10)
  if (!env.BACKUP_WORKFLOW) {
    const msg = 'NIGHTLY_BACKUP=1 but the BACKUP_WORKFLOW binding is not deployed'
    console.error('[backup]', msg)
    await alert(env, 'failed', runDate, msg)
    return
  }
  try {
    await env.BACKUP_WORKFLOW.create({ id: `d1-backup-${runDate}`, params: { runDate } })
  } catch (err) {
    const msg = `could not start the backup workflow: ${redact(String(err))}`
    console.error('[backup]', msg)
    await alert(env, 'failed', runDate, msg)
  }
}
