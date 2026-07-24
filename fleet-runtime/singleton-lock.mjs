#!/usr/bin/env node
// Advisory single-instance lock for inbox consumers.
//
// Two watchers against one agent token interleave their peek/consume cycles.
// Because `inbox` consumes by limit rather than by id, that interleaving lets
// one instance consume rows the other peeked and delivered — the queue loses a
// message nobody ever saw. This lock removes that precondition; the batch
// verification in claude-code-inbox-adapter.mjs catches it if it happens anyway.
//
// PID-file based and deliberately advisory: it stops the accident (a second
// systemd unit, a hand-run `--once` beside the loop), not a determined caller.
// A lock whose owning process is gone is stale and gets reclaimed, so a crash
// or SIGKILL never wedges the watcher permanently.

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

/** Is a pid live? EPERM means it exists under another uid — still live. */
function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function readHolder(path) {
  try {
    const raw = readFileSync(path, 'utf8').trim()
    const pid = Number(raw.split(/\s+/)[0])
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null // unreadable/vanished → treat as stale, the O_EXCL retry decides
  }
}

/**
 * Acquire the lock, or refuse.
 *
 * Returns { ok: true, release() } | { ok: false, reason, holder_pid }.
 * Never throws for the contended case — the caller logs and exits cleanly.
 */
export function acquireSingletonLock(options) {
  const path = options?.path
  if (typeof path !== 'string' || !path) {
    return { ok: false, reason: 'lock_path_required', holder_pid: null }
  }
  const pid = Number.isInteger(options?.pid) ? options.pid : process.pid
  const isAlive = typeof options?.isAlive === 'function' ? options.isAlive : defaultIsAlive

  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch (error) {
    return { ok: false, reason: 'lock_dir_unwritable', holder_pid: null, detail: String(error?.message ?? error) }
  }

  // Two attempts: the first claims a free lock, the second claims one we just
  // proved stale. A live holder short-circuits before any reclaim.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx') // O_CREAT|O_EXCL — atomic claim
      try {
        writeSync(fd, `${pid}\n`)
      } finally {
        closeSync(fd)
      }
      return {
        ok: true,
        reason: 'lock_acquired',
        holder_pid: pid,
        release() {
          // Only drop a lock we still own, so a reclaimer's file survives.
          if (readHolder(path) !== pid) return false
          try {
            unlinkSync(path)
            return true
          } catch {
            return false
          }
        },
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        return { ok: false, reason: 'lock_unwritable', holder_pid: null, detail: String(error?.message ?? error) }
      }
      const holder = readHolder(path)
      if (holder !== null && holder !== pid && isAlive(holder)) {
        return { ok: false, reason: 'already_running', holder_pid: holder }
      }
      if (holder === pid) {
        // Our own lock from an earlier run in this process — reuse it.
        return { ok: true, reason: 'lock_reentrant', holder_pid: pid, release: () => false }
      }
      try {
        unlinkSync(path) // stale: holder dead or unreadable
      } catch {
        // someone else reclaimed it first; the next attempt will see their lock
      }
    }
  }
  return { ok: false, reason: 'lock_contended', holder_pid: readHolder(path) }
}
