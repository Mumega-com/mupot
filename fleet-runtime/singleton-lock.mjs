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
import { unlinkSync } from 'node:fs'

/** Abstract-namespace names are capped near 108 bytes; hash to stay well under. */
function lockAddress(path) {
  const digest = createHash('sha256').update(path).digest('hex').slice(0, 32)
  return process.platform === 'linux'
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

/** Ask the current owner for its pid. Resolves null if nothing is listening. */
function probe(address) {
  return new Promise((resolve) => {
    const socket = net.connect(address)
    let data = ''
    const done = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(1000, () => done(null))
    socket.on('data', (chunk) => {
      data += chunk
      done(Number(data.trim()) || 0)
    })
    socket.on('error', () => resolve(null)) // ECONNREFUSED/ENOENT → no live owner
    socket.on('close', () => resolve(data ? Number(data.trim()) || 0 : null))
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
  const address = lockAddress(path)

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
      if (process.platform !== 'linux') {
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
  // owner does, so there is nothing stale to consider.
  const holder = await probe(address)
  if (process.platform === 'linux') {
    return { ok: false, reason: 'already_running', holder_pid: holder ?? null }
  }
  if (holder !== null) {
    return { ok: false, reason: 'already_running', holder_pid: holder }
  }

  // Filesystem socket with no listener: the node is dead, not merely idle.
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
    return { ok: false, reason: 'lock_contended', holder_pid: await probe(address) }
  }
}
