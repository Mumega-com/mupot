#!/usr/bin/env node
// Advisory single-instance lock for inbox consumers.
//
// Two watchers against one agent token interleave their peek/consume cycles.
// Because `inbox` consumes by limit rather than by id, that interleaving lets
// one instance consume rows the other peeked and delivered — the queue loses a
// message nobody ever saw. This lock removes that precondition; the batch
// verification in claude-code-inbox-adapter.mjs only detects the loss after the
// rows are already gone, so the lock has to actually hold.
//
// Correctness rests on three rules, each covering a way the naive version broke:
//
//  1. Claim by link(), never by "unlink then create". A fully-written temp file
//     is linked into place atomically, so a claim is never observable as an
//     empty or half-written file.
//  2. Never unlink based on a stale observation. Reclaiming a dead holder's
//     lock happens under an exclusive reclaim token, and the holder is re-read
//     AFTER taking that token — the earlier observation only decides whether to
//     try, never what to delete.
//  3. Verify after claiming. Every acquisition re-reads the file and confirms
//     both pid and nonce are ours before reporting success, so a lock deleted
//     and replaced underneath us reads as a loss rather than a second owner.
//
// Deliberately advisory: it stops the accident (a second systemd unit, a
// hand-run `--once` beside the loop), not a determined caller.

import { closeSync, linkSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'

/** A reclaim token older than this is treated as abandoned by a crashed reclaimer. */
const RECLAIM_TOKEN_TTL_MS = 30_000

/** Is a pid live? EPERM means it exists under another uid — still live. */
function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** `<pid> <nonce>` — nonce distinguishes our claim from a same-pid predecessor. */
function readRecord(path) {
  try {
    const [pidRaw, nonce] = readFileSync(path, 'utf8').trim().split(/\s+/)
    const pid = Number(pidRaw)
    if (!Number.isInteger(pid) || pid <= 0) return null
    return { pid, nonce: nonce ?? '' }
  } catch {
    return null
  }
}

/**
 * Write the record to a unique temp path, then link it into place.
 * link() fails with EEXIST if the lock path is taken — atomic, and the file is
 * complete before it is ever visible under the lock name.
 */
function tryClaim(path, pid, nonce) {
  const tmp = `${path}.tmp.${pid}.${nonce}`
  try {
    const fd = openSync(tmp, 'wx')
    try {
      writeSync(fd, `${pid} ${nonce}\n`)
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    return { ok: false, reason: 'lock_unwritable', detail: String(error?.message ?? error) }
  }
  try {
    // rename() would clobber an existing lock; link() refuses to, which is the
    // atomicity this depends on.
    linkSync(tmp, path)
  } catch (error) {
    safeUnlink(tmp)
    if (error?.code === 'EEXIST') return { ok: false, reason: 'taken' }
    return { ok: false, reason: 'lock_unwritable', detail: String(error?.message ?? error) }
  }
  safeUnlink(tmp)
  // Rule 3: confirm the file under the lock name is still the one we linked.
  const held = readRecord(path)
  if (!held || held.pid !== pid || held.nonce !== nonce) return { ok: false, reason: 'taken' }
  return { ok: true }
}

function safeUnlink(path) {
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

function tokenAgeMs(path) {
  try {
    return Date.now() - statSync(path).mtimeMs
  } catch {
    return null
  }
}

/**
 * Acquire the lock, or refuse.
 *
 * Returns { ok: true, reason, holder_pid, release() }
 *      |  { ok: false, reason, holder_pid }.
 * Never throws for the contended case — the caller logs and exits cleanly.
 */
export function acquireSingletonLock(options) {
  const path = options?.path
  if (typeof path !== 'string' || !path) {
    return { ok: false, reason: 'lock_path_required', holder_pid: null }
  }
  const pid = Number.isInteger(options?.pid) ? options.pid : process.pid
  const isAlive = typeof options?.isAlive === 'function' ? options.isAlive : defaultIsAlive
  const nonce = typeof options?.nonce === 'string' && options.nonce
    ? options.nonce
    : randomBytes(8).toString('hex')

  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch (error) {
    return { ok: false, reason: 'lock_dir_unwritable', holder_pid: null, detail: String(error?.message ?? error) }
  }

  const owned = () => ({
    ok: true,
    reason: 'lock_acquired',
    holder_pid: pid,
    release() {
      // Only drop a lock still carrying our exact claim.
      const held = readRecord(path)
      if (!held || held.pid !== pid || held.nonce !== nonce) return false
      return safeUnlink(path)
    },
  })

  // Fast path: the lock is free.
  const first = tryClaim(path, pid, nonce)
  if (first.ok) return owned()
  if (first.reason !== 'taken') {
    return { ok: false, reason: first.reason, holder_pid: null, detail: first.detail }
  }

  // Taken. A live holder settles it immediately.
  const observed = readRecord(path)
  if (observed && isAlive(observed.pid)) {
    return { ok: false, reason: 'already_running', holder_pid: observed.pid }
  }

  // Possibly stale. Rule 2: serialize reclamation, and decide on a FRESH read
  // taken under the token — the observation above only got us this far.
  const tokenPath = `${path}.reclaim`
  let tokenFd
  try {
    tokenFd = openSync(tokenPath, 'wx')
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      return { ok: false, reason: 'lock_unwritable', holder_pid: null, detail: String(error?.message ?? error) }
    }
    const age = tokenAgeMs(tokenPath)
    if (age !== null && age > RECLAIM_TOKEN_TTL_MS) {
      safeUnlink(tokenPath) // abandoned by a crashed reclaimer
    }
    // Another reclaimer is mid-flight; refuse rather than race it.
    return { ok: false, reason: 'lock_contended', holder_pid: observed?.pid ?? null }
  }

  try {
    writeSync(tokenFd, `${pid}\n`)
  } catch {
    // token content is diagnostic only
  } finally {
    closeSync(tokenFd)
  }

  try {
    const fresh = readRecord(path)
    if (fresh !== null && isAlive(fresh.pid)) {
      // Someone claimed it between our first read and the token.
      return { ok: false, reason: 'already_running', holder_pid: fresh.pid }
    }
    // Not live, on a read taken under the token: either the holder is dead, the
    // file is unparseable, or it vanished. All three are safe to clear here —
    // this unlink cannot target a live claim, and a no-op on an absent path.
    safeUnlink(path)
    const claimed = tryClaim(path, pid, nonce)
    if (claimed.ok) return owned()
    // Someone slipped in between unlink and link. Fail closed, never retry.
    return { ok: false, reason: 'lock_contended', holder_pid: readRecord(path)?.pid ?? null }
  } finally {
    safeUnlink(tokenPath)
  }
}
