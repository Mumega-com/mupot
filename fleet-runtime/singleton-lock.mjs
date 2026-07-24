#!/usr/bin/env node
// Advisory single-instance lock for inbox consumers.
//
// Two watchers against one agent token interleave their peek/consume cycles.
// Because `inbox` consumes by limit rather than by id, that interleaving lets
// one instance consume rows the other peeked and delivered — the queue loses a
// message nobody ever saw. This lock removes that precondition; the batch
// verification in claude-code-inbox-adapter.mjs only detects the loss after the
// rows are gone, so the lock has to actually hold.
//
// WHY A SOCKET AND NOT A PID FILE
//
// Two earlier PID-file versions were broken by adversarial review, both by the
// same shape: a process unlinks a path based on an observation taken before
// someone else claimed it, destroying a live claim. Fixing that for the lock
// file reintroduced it for the reclaim token that was fencing the lock file —
// a fence needing its own fence.
//
// The root problem is that a PID file needs liveness inferred (is that pid
// still alive? is this file abandoned?) and every inference has a window. A
// bound socket needs no inference: the kernel arbitrates the bind, and the name
// is released by the kernel when the owning process dies, however it dies.
// There is no stale state to detect, no TTL, no reclaim path, and therefore no
// window — the entire bug class is gone rather than fenced.
//
// On Linux the abstract namespace ("\0name") leaves nothing on disk at all.
// Elsewhere a filesystem socket is used, where a leftover node can block bind;
// there a connect probe distinguishes a live owner (connect succeeds) from a
// dead one (ECONNREFUSED — nothing is listening, so the node is genuinely
// dead), which is the standard resolution and far narrower than pid inference.
//
// Deliberately advisory: it stops the accident (a second systemd unit, a
// hand-run `--once` beside the loop), not a determined caller.

import net from 'node:net'
import { createHash } from 'node:crypto'
import { mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Abstract-namespace names are capped near 108 bytes; hash to stay well under.
 *
 * `forceFilesystemSocket` exists so the fallback path is reachable on Linux. It
 * is not a production switch — it is here because the fallback's only real bug
 * was found by forcing it manually, which means CI was never executing the
 * branch at all. An untested branch in a mutual-exclusion primitive is the one
 * place that is least acceptable.
 */
function useAbstractNamespace(options) {
  return process.platform === 'linux' && options?.forceFilesystemSocket !== true
}

function lockAddress(path, options) {
  const digest = createHash('sha256').update(path).digest('hex').slice(0, 32)
  return useAbstractNamespace(options)
    ? `\0mupot-singleton-${digest}`
    : `${path}.sock`
}

function listen(server, address) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(address)
  })
}

/**
 * Probe the socket. Returns one of:
 *   { state: 'refused' }            nothing is listening — the node is genuinely dead
 *   { state: 'alive', pid }         an owner answered
 *   { state: 'silent' }             connected, but no answer before the deadline
 *
 * The distinction between 'refused' and 'silent' is load-bearing. A refusal is a
 * FACT from the kernel: no listener. Silence is not — a suspended, busy, or slow
 * owner is still listening and still owns the lock. Collapsing silence into
 * "dead" is how a live-but-unresponsive owner gets its socket unlinked out from
 * under it while it keeps serving on the orphaned inode, producing exactly the
 * two-owner state this lock exists to prevent.
 */
function probe(address) {
  return new Promise((resolve) => {
    const socket = net.connect(address)
    let data = ''
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(1000, () => done({ state: 'silent' }))
    socket.on('data', (chunk) => {
      data += chunk
      done({ state: 'alive', pid: Number(String(data).trim()) || null })
    })
    socket.on('error', (error) => {
      // ECONNREFUSED / ENOENT mean no listener. Anything else is unexplained,
      // and unexplained must not be read as permission to take the lock.
      const refused = error?.code === 'ECONNREFUSED' || error?.code === 'ENOENT'
      done({ state: refused ? 'refused' : 'silent' })
    })
    socket.on('close', () => {
      done(data ? { state: 'alive', pid: Number(String(data).trim()) || null } : { state: 'silent' })
    })
  })
}

/**
 * Acquire the lock, or refuse.
 *
 * Returns { ok: true, reason, holder_pid, release() }
 *      |  { ok: false, reason, holder_pid }.
 * Never throws for the contended case — the caller logs and exits cleanly.
 */
export async function acquireSingletonLock(options) {
  const path = options?.path
  if (typeof path !== 'string' || !path) {
    return { ok: false, reason: 'lock_path_required', holder_pid: null }
  }
  const pid = Number.isInteger(options?.pid) ? options.pid : process.pid
  const address = lockAddress(path, options)

  // A filesystem socket needs its parent to exist. The abstract namespace does
  // not, but creating the directory anyway keeps both platforms on one path and
  // costs nothing — a first run on a clean host must not fail to take a lock
  // merely because ~/.fleet/locks has never been created.
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch (error) {
    return { ok: false, reason: 'lock_dir_unwritable', holder_pid: null, detail: String(error?.message ?? error) }
  }

  // Announce our pid to anyone probing, so a refusal can name the holder.
  const server = net.createServer((socket) => {
    socket.end(`${pid}\n`)
  })
  server.unref() // never hold the event loop open on the lock alone

  const owned = () => ({
    ok: true,
    reason: 'lock_acquired',
    holder_pid: pid,
    release() {
      try {
        server.close()
      } catch {
        return false
      }
      if (!useAbstractNamespace(options)) {
        try {
          unlinkSync(address)
        } catch {
          // already gone
        }
      }
      return true
    },
  })

  try {
    await listen(server, address)
    return owned()
  } catch (error) {
    if (error?.code !== 'EADDRINUSE') {
      return { ok: false, reason: 'lock_unwritable', holder_pid: null, detail: String(error?.message ?? error) }
    }
  }

  // In use. On Linux that is conclusive: abstract names exist only while their
  // owner does, so there is nothing stale to consider and the probe is advisory.
  const holder = await probe(address)
  if (useAbstractNamespace(options)) {
    return { ok: false, reason: 'already_running', holder_pid: holder.pid ?? null }
  }

  if (holder.state === 'alive') {
    return { ok: false, reason: 'already_running', holder_pid: holder.pid ?? null }
  }
  if (holder.state === 'silent') {
    // Connected but unanswered. The owner may be suspended, busy, or slow — it
    // is still listening and still owns this lock. Unlinking here would orphan
    // its inode while it keeps serving, and the bind below would hand us a
    // second, parallel owner. Refuse; a wedged lock is recoverable, two live
    // consumers silently eating each other's messages is not.
    return { ok: false, reason: 'already_running', holder_pid: null }
  }

  // holder.state === 'refused': the kernel says nothing is listening. That is a
  // fact, not an inference, so the node is genuinely dead and safe to clear.
  try {
    unlinkSync(address)
  } catch {
    // someone else cleared it first
  }
  try {
    await listen(server, address)
    return owned()
  } catch {
    // Another contender bound it in between. Fail closed; never loop.
    const after = await probe(address)
    return { ok: false, reason: 'lock_contended', holder_pid: after.pid ?? null }
  }
}
