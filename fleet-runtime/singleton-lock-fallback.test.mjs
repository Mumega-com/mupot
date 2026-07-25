import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

// Regressions for the third BLOCK on PR #540 (head 9ef1dfb).
//
// The Linux path binds an abstract-namespace name, so the kernel arbitrates and
// the probe is advisory. The FILESYSTEM-socket fallback is different: a leftover
// node blocks bind, so the code must decide whether to clear it — and that
// decision was inferring death from silence. A live-but-unresponsive owner
// (suspended, busy, slow) answered nothing, was read as dead, had its socket
// unlinked while it kept serving on the orphaned inode, and a second owner
// bound. Two live consumers, which is the exact state this lock prevents.
//
// These drive the fallback directly rather than through platform detection, so
// the path is covered on Linux CI where it would otherwise never execute.
import { acquireSingletonLock } from './singleton-lock.mjs'

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'mupot-lock-fb-'))
}

/** A server that binds the path socket but never answers a probe. */
function silentOwner(sockPath) {
  return new Promise((resolve, reject) => {
    const server = net.createServer(() => {
      // accept the connection, then say nothing — the suspended-owner shape
    })
    server.once('error', reject)
    server.listen(sockPath, () => resolve(server))
  })
}

test('a live-but-silent owner on the fallback path is NOT reclaimed', async () => {
  const dir = tmpDir()
  const lockPath = join(dir, 'watch.lock')
  const sockPath = `${lockPath}.sock`
  const owner = await silentOwner(sockPath)

  try {
    const result = await acquireSingletonLock({ path: lockPath, forceFilesystemSocket: true })
    assert.equal(result.ok, false, 'silence must never authorize taking the lock')
    assert.equal(result.reason, 'already_running')
    // The owner must still be listening — its socket must not have been removed.
    assert.equal(existsSync(sockPath), true, 'live owner socket was unlinked')
    assert.equal(owner.listening, true, 'owner stopped listening')
  } finally {
    owner.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a genuinely dead socket node on the fallback path IS reclaimed', async () => {
  const dir = tmpDir()
  const lockPath = join(dir, 'watch.lock')
  const sockPath = `${lockPath}.sock`

  // Bind then close: the node is left behind with nothing listening, so a
  // connect gets ECONNREFUSED — a fact from the kernel, not an inference.
  const dead = await silentOwner(sockPath)
  await new Promise((resolve) => dead.close(resolve))

  try {
    const result = await acquireSingletonLock({ path: lockPath, forceFilesystemSocket: true })
    assert.equal(result.ok, true, 'a refused connect means the node is dead and reclaimable')
    assert.equal(result.reason, 'lock_acquired')
    result.release()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a CRASH-stale socket node (SIGKILL, node left orphaned on disk) IS reclaimed', async () => {
  // Required by adversarial review of f2cfcc6: the test above closes its
  // owner gracefully, and Node unlinks the Unix-socket pathname on close — so
  // it exercises a free initial bind, never `EADDRINUSE -> probe refused ->
  // reclaim`. A killed process runs no close/unlink path at all, leaving the
  // node genuinely orphaned, which is the actual production shape (a crashed
  // daemon), and the only way to hit `EADDRINUSE` here first.
  const dir = tmpDir()
  const lockPath = join(dir, 'watch.lock')
  const sockPath = `${lockPath}.sock`
  const CONTENDER = join(dirname(fileURLToPath(import.meta.url)), 'singleton-lock-contender.mjs')

  const owner = spawn(process.execPath, [CONTENDER], {
    env: { ...process.env, LOCK_PATH: lockPath, START_AT_MS: String(Date.now()), FORCE_FS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const ownerResult = await new Promise((resolve, reject) => {
    owner.stdout.once('data', (chunk) => resolve(JSON.parse(String(chunk).trim())))
    owner.on('error', reject)
  })
  assert.equal(ownerResult.ok, true, 'owner must acquire before it can be crash-killed')
  assert.equal(existsSync(sockPath), true, 'owner must actually hold the filesystem node')

  owner.kill('SIGKILL')
  await new Promise((resolve) => owner.on('close', resolve))
  assert.equal(existsSync(sockPath), true, 'a SIGKILL must leave the node behind — no unlink runs on crash')

  try {
    const result = await acquireSingletonLock({ path: lockPath, forceFilesystemSocket: true })
    assert.equal(result.ok, true, 'EADDRINUSE -> probe refused -> reclaim must still succeed for a real crash')
    assert.equal(result.reason, 'lock_acquired')
    result.release()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('acquires when the parent directory does not exist yet', async () => {
  // Second finding on 9ef1dfb: the socket rewrite dropped the mkdir, so a first
  // run on a clean host (no ~/.fleet/locks) failed with EACCES/lock_unwritable
  // instead of taking a free lock.
  const dir = tmpDir()
  const lockPath = join(dir, 'deep', 'nested', 'watch.lock')
  assert.equal(existsSync(join(dir, 'deep')), false, 'parent must be absent for this test')

  try {
    const result = await acquireSingletonLock({ path: lockPath, forceFilesystemSocket: true })
    assert.equal(result.ok, true, `missing parent must be created, got ${result.reason}`)
    result.release()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('missing parent also works on the default (abstract) path', async () => {
  const dir = tmpDir()
  const lockPath = join(dir, 'deep', 'nested', 'watch.lock')
  try {
    const result = await acquireSingletonLock({ path: lockPath })
    assert.equal(result.ok, true, `got ${result.reason}`)
    result.release()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
