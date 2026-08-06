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
import { mkdirSync, unlinkSync, linkSync, renameSync } from 'node:fs'
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

/**
 * A SEPARATE abstract-namespace address used only to serialize reclaim
 * attempts on the filesystem-socket fallback (see the fallback's own
 * comments). Independent of `forceFilesystemSocket`, which only chooses the
 * MAIN lock's address — the abstract namespace is a Linux kernel facility
 * available regardless of which address style the main lock itself uses.
 */
function reclaimMutexAddress(path) {
  const digest = createHash('sha256').update(path).digest('hex').slice(0, 32)
  return `\0mupot-reclaim-${digest}`
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
  const reclaimMutex = reclaimMutexAddress(path)

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
      // Order matters. `server.close()` was bound to `tmpAddress`, not
      // `address` (Node has no idea `address` is hardlinked to the same
      // socket) — so it takes effect (stops accepting) IMMEDIATELY and
      // SYNCHRONOUSLY, well before the actual fd teardown completes, while
      // `address` the FILE still exists on disk. A probe arriving in that gap
      // would see ECONNREFUSED against a name that still has a directory
      // entry — indistinguishable from a genuine crash-stale corpse — and
      // could legitimately win the reclaim race for `address` before we ever
      // reach our own unlink. Then our unconditional unlink would delete
      // THEIR fresh claim: the same successor-unlink bug as the reclaim path,
      // now at release. Unlinking `address` FIRST, while still definitely
      // listening, closes that gap — no observer can ever see "file present,
      // nothing listening" for a name we still hold.
      try {
        unlinkSync(address)
      } catch {
        // already gone
      }
      try {
        server.close()
      } catch {
        return false
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

    // Our link() lost the name to something already there. Two independent
    // ways of trying to resolve this — a `statSync`-based identity sandwich,
    // then a rename-away-and-verify-then-restore dance — both turned out
    // unsound under adversarial review: the sandwich compared (dev,ino)
    // across a time gap, which this filesystem defeats by reusing a freed
    // inode number for a brand-new, unrelated, live claim within
    // microseconds (measured ~100% reuse under this file's own churn
    // pattern); the restore dance let an evicted-but-alive owner keep
    // believing it had already won (it had, by then, already reported
    // success) while a THIRD party legitimately claimed the freed name
    // during the investigation window — minting a second, independent,
    // mutually oblivious winner. Neither problem is closed by resampling or
    // retrying the same shape harder.
    //
    // Fix: stop trying to verify identity or undo a mistake after the fact.
    // Make the whole "confirm dead, then replace" decision happen inside a
    // section only one contender may ever be in at a time, using the ONE
    // kernel-arbitrated, zero-staleness primitive this file already trusts
    // for the main lock itself: an abstract-namespace socket bind. That
    // guarantee (freed instantly on the holder's death, however it dies, no
    // staleness possible) is what a PID-file-style mutex can never give —
    // this is not a new trick, it is reusing the one already proven correct.
    if (process.platform === 'linux') {
      const mutexServer = net.createServer(() => {})
      mutexServer.unref()
      try {
        await listen(mutexServer, reclaimMutex)
      } catch (error) {
        if (error?.code !== 'EADDRINUSE') {
          abandon()
          return { ok: false, reason: 'lock_unwritable', holder_pid: null, detail: String(error?.message ?? error) }
        }
        // Someone else is investigating `address` right now. Don't race
        // them — retry the whole outer loop; by then they will have either
        // claimed `address` (we'll see EEXIST, probe THEM, correctly refuse)
        // or backed off (we'll see it free).
        continue
      }
      try {
        const holder = await probe(address)
        if (holder.state === 'alive' || holder.state === 'silent') {
          // Silence is not death (see probe()'s doc comment).
          abandon()
          return { ok: false, reason: 'already_running', holder_pid: holder.pid ?? null }
        }
        // Confirmed dead — and because we hold the mutex, no other
        // contender can be concurrently reaching or acting on that same
        // conclusion. Replace it with our OWN socket in one atomic step:
        // `renameSync` always succeeds regardless of what currently
        // occupies `address` (no EEXIST check on its destination), so there
        // is no intermediate instant where `address` is absent for an
        // unrelated fresh claimant to slip into — unlike unlink-then-relink,
        // which is two syscalls with a real gap between them for exactly
        // that to happen.
        try {
          renameSync(tmpAddress, address)
          return owned()
        } catch (error) {
          abandon()
          return { ok: false, reason: 'lock_unwritable', holder_pid: null, detail: String(error?.message ?? error) }
        }
      } finally {
        try {
          mutexServer.close()
        } catch {
          // already closed
        }
      }
    }

    // Non-Linux: no abstract namespace, so no zero-staleness mutex is
    // available in pure Node (no flock/fcntl binding either). Best effort —
    // a single probe, then a single atomic replace, no ticket/restore dance
    // (both were shown above to still race under real concurrent
    // contention without a true mutex). This narrows, but does not fully
    // close, the gap between the probe and the replace. Accepted here
    // because this file's own adversarial testing and this codebase's
    // actual deployment target are both Linux (`forceFilesystemSocket`
    // exists to exercise this fallback FROM Linux, not to certify a real
    // non-Linux host) — a genuine non-Linux deployment is untested
    // territory regardless of this specific gap.
    const preCheck = await probe(address)
    if (preCheck.state === 'alive' || preCheck.state === 'silent') {
      abandon()
      return { ok: false, reason: 'already_running', holder_pid: preCheck.pid ?? null }
    }
    try {
      renameSync(tmpAddress, address)
      return owned()
    } catch (error) {
      abandon()
      return { ok: false, reason: 'lock_unwritable', holder_pid: null, detail: String(error?.message ?? error) }
    }
  }

  abandon()
  const after = await probe(address)
  return { ok: false, reason: 'lock_contended', holder_pid: after.pid ?? null }
}
