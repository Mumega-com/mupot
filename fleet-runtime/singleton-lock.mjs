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
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, unlinkSync, linkSync, statSync } from 'node:fs'
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

  if (useAbstractNamespace(options)) {
    // Abstract names exist only while their owner does — bind() is the whole
    // arbitration, there is nothing stale to reclaim, and the probe below is
    // purely advisory (to name the holder in the refusal).
    try {
      await listen(server, address)
      return {
        ok: true,
        reason: 'lock_acquired',
        holder_pid: pid,
        release() {
          try {
            server.close()
          } catch {
            return false
          }
          return true
        },
      }
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') {
        return { ok: false, reason: 'lock_unwritable', holder_pid: null, detail: String(error?.message ?? error) }
      }
      const holder = await probe(address)
      return { ok: false, reason: 'already_running', holder_pid: holder.pid ?? null }
    }
  }

  // Filesystem-socket fallback. A leftover node can block bind(), so — unlike
  // the abstract path — ownership here can never be granted by bind()/listen()
  // directly: a bind-after-unlink sequence is two non-atomic steps, and a
  // second contender's own (also probe-authorized) unlink can land between
  // them, deleting the FIRST contender's freshly live pathname and admitting a
  // second owner. That is the exact two-owner bug adversarial review found
  // against a crash (SIGKILL-created) stale node under 24 synchronized
  // contenders — the identical "observation taken before someone else claimed
  // it" shape this file's header already names, re-manifesting one step later
  // because probe()+unlink() authorized a bind() that itself raced.
  //
  // Fix: a process is only ever granted `address` by a successful `linkSync`
  // (hardlink) into it — link() is a true kernel-atomic compare-and-create
  // that FAILS LOUDLY (EEXIST) on any race, unlike unlink+bind which can
  // succeed silently for two callers in sequence. Ownership is therefore never
  // assumed from "I unlinked it" — only ever proven by "my link() call itself
  // returned success."
  const tmpAddress = `${address}.claim-${pid}-${randomBytes(4).toString('hex')}`

  try {
    await listen(server, tmpAddress)
  } catch (error) {
    return { ok: false, reason: 'lock_unwritable', holder_pid: null, detail: String(error?.message ?? error) }
  }

  const abandon = () => {
    try {
      server.close()
    } catch {
      // already closed
    }
    try {
      unlinkSync(tmpAddress)
    } catch {
      // already gone
    }
  }

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
      try {
        unlinkSync(address)
      } catch {
        // already gone
      }
      return true
    },
  })

  const MAX_ATTEMPTS = 20
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      linkSync(tmpAddress, address)
      try {
        unlinkSync(tmpAddress) // drop the claim name; `address` now IS our socket
      } catch {
        // harmless — a second name to the same inode, cleaned up on release
      }
      return owned()
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        abandon()
        return { ok: false, reason: 'lock_unwritable', holder_pid: null, detail: String(error?.message ?? error) }
      }
    }

    // Our link() lost the name to something already there. Identify it BEFORE
    // probing — `probe()` is async and takes real wall-clock time (up to its
    // 1s silence timeout), and a fresh winner can appear and vanish-from-view
    // entirely within that gap. Capturing identity only AFTER the probe
    // returned (the earlier version of this fix) let a probe result for the
    // OLD corpse get attributed to whatever NEW entity happened to occupy the
    // name by the time the post-probe stat ran — reaping a live winner
    // because the "refused" verdict belonged to something that no longer
    // existed. So identity is sandwiched around the probe and re-checked
    // again immediately before the unlink: the verdict is only ever trusted
    // for the EXACT (dev,ino) it was actually taken against.
    let before
    try {
      before = statSync(address)
    } catch {
      continue // already gone — retry the link fresh
    }
    const holder = await probe(address)
    let after
    try {
      after = statSync(address)
    } catch {
      continue // gone by the time the probe returned — retry fresh
    }
    if (before.dev !== after.dev || before.ino !== after.ino) {
      // The name changed identity mid-probe. The verdict we just got is
      // about neither reliably-known state — trust nothing, retry fresh.
      continue
    }

    if (holder.state === 'alive' || holder.state === 'silent') {
      // Silence is not death (see probe()'s doc comment) — a suspended/busy/
      // slow owner still holds the name. Refuse either way.
      abandon()
      return { ok: false, reason: 'already_running', holder_pid: holder.pid ?? null }
    }

    // holder.state === 'refused', PROVEN to be about this exact (dev,ino) —
    // but WHICH contender gets to clear it must itself be kernel-arbitrated.
    // Two contenders can both observe 'refused' against the SAME stale node
    // and act on that observation at different real times; if either unlinks
    // unconditionally, a straggler's unlink — authorized by a probe taken
    // before a winner claimed the name — can delete the WINNER's fresh
    // pathname. That is the exact two-owner bug adversarial review found on
    // `f2cfcc6` (24 synchronized contenders, a SIGKILL-created stale node, 2
    // winners). So the unlink itself is gated behind a second `link()` CAS,
    // scoped to this SPECIFIC dead (dev,ino): only the contender that
    // atomically wins the right to reap THIS corpse may ever unlink it. A
    // crash mid-reap permanently poisons only that one corpse's ticket name
    // (harmless disk litter, never looked up again) — the next stale
    // generation has a different inode and therefore a fresh ticket name, so
    // nothing can wedge.
    const reapTicket = `${address}.reap-${before.dev}-${before.ino}`
    try {
      linkSync(tmpAddress, reapTicket)
    } catch (error) {
      if (error?.code === 'EEXIST') {
        continue // someone else is (or already did) reaping this exact corpse
      }
      abandon()
      return { ok: false, reason: 'lock_unwritable', holder_pid: null, detail: String(error?.message ?? error) }
    }

    try {
      let current
      try {
        current = statSync(address)
      } catch {
        current = null // already gone
      }
      if (current && current.dev === before.dev && current.ino === before.ino) {
        try {
          unlinkSync(address)
        } catch {
          // already gone
        }
      }
      // else: address changed under us since we won the reap ticket — a
      // fresh claimant's own `link()` won it validly in the meantime. Leave
      // it; fall through to retry, where our next link() correctly EEXISTs
      // against THEM.
    } finally {
      try {
        unlinkSync(reapTicket)
      } catch {
        // best-effort — a name nothing will ever look up again
      }
    }
  }

  abandon()
  const after = await probe(address)
  return { ok: false, reason: 'lock_contended', holder_pid: after.pid ?? null }
}
