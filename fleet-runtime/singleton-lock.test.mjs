import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { acquireSingletonLock } from './singleton-lock.mjs'

function lockPath(name = 'watch.lock') {
  return join(mkdtempSync(join(tmpdir(), 'mupot-lock-')), 'nested', name)
}

/** Lock records are `<pid> <nonce>`; the nonce distinguishes successive claims. */
function heldPid(path) {
  return Number(readFileSync(path, 'utf8').trim().split(/\s+/)[0])
}

test('acquires a free lock and records the holder pid', () => {
  const path = lockPath()
  const lock = acquireSingletonLock({ path, pid: 4242, nonce: 'n1', isAlive: () => true })
  assert.equal(lock.ok, true)
  assert.equal(lock.reason, 'lock_acquired')
  assert.equal(lock.holder_pid, 4242)
  assert.equal(readFileSync(path, 'utf8').trim(), '4242 n1')
  assert.equal(lock.release(), true)
  assert.equal(existsSync(path), false)
})

test('never leaves the temp or reclaim artefacts behind', () => {
  const path = lockPath()
  const lock = acquireSingletonLock({ path, pid: 4242, nonce: 'n1', isAlive: () => true })
  assert.equal(lock.ok, true)
  assert.equal(existsSync(`${path}.tmp.4242.n1`), false)
  assert.equal(existsSync(`${path}.reclaim`), false)
})

test('refuses when a live holder owns the lock — the #534 precondition', () => {
  const path = lockPath()
  const first = acquireSingletonLock({ path, pid: 100, nonce: 'a', isAlive: () => true })
  assert.equal(first.ok, true)

  const second = acquireSingletonLock({ path, pid: 200, nonce: 'b', isAlive: (pid) => pid === 100 })
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'already_running')
  assert.equal(second.holder_pid, 100)
  // The live holder's lock must survive a refused acquisition.
  assert.equal(heldPid(path), 100)
})

test('reclaims a stale lock whose holder is gone (crash must not wedge the watcher)', () => {
  const path = lockPath()
  const dead = acquireSingletonLock({ path, pid: 100, nonce: 'a', isAlive: () => true })
  assert.equal(dead.ok, true)

  const next = acquireSingletonLock({ path, pid: 200, nonce: 'b', isAlive: () => false })
  assert.equal(next.ok, true)
  assert.equal(next.reason, 'lock_acquired')
  assert.equal(heldPid(path), 200)
})

test('reclaims a lock file that is corrupt or empty', () => {
  const path = lockPath()
  acquireSingletonLock({ path, pid: 1, nonce: 'a', isAlive: () => false }).release()
  writeFileSync(path, 'not-a-pid\n')

  const lock = acquireSingletonLock({ path, pid: 777, nonce: 'b', isAlive: () => true })
  assert.equal(lock.ok, true)
  assert.equal(heldPid(path), 777)
})

test('release does not delete a lock reclaimed by another holder', () => {
  const path = lockPath()
  const first = acquireSingletonLock({ path, pid: 100, nonce: 'a', isAlive: () => true })
  const second = acquireSingletonLock({ path, pid: 200, nonce: 'b', isAlive: () => false })
  assert.equal(second.ok, true)

  // The original holder returning late must not drop the new owner's lock.
  assert.equal(first.release(), false)
  assert.equal(existsSync(path), true)
  assert.equal(heldPid(path), 200)
})

test('release does not delete a lock retaken by the SAME pid (nonce guards reuse)', () => {
  const path = lockPath()
  const first = acquireSingletonLock({ path, pid: 100, nonce: 'a', isAlive: () => true })
  assert.equal(first.ok, true)
  const second = acquireSingletonLock({ path, pid: 100, nonce: 'b', isAlive: () => false })
  assert.equal(second.ok, true)

  // Same pid, different claim — the stale handle must not release the live one.
  assert.equal(first.release(), false)
  assert.equal(existsSync(path), true)
  assert.equal(second.release(), true)
})

test('refuses while another reclaimer holds the reclaim token', () => {
  const path = lockPath()
  acquireSingletonLock({ path, pid: 100, nonce: 'a', isAlive: () => false }).release()
  writeFileSync(path, '100 stale\n')
  // Simulate a reclaimer mid-flight: the token exists and is fresh.
  writeFileSync(`${path}.reclaim`, '555\n')

  const lock = acquireSingletonLock({ path, pid: 200, nonce: 'b', isAlive: () => false })
  assert.equal(lock.ok, false)
  assert.equal(lock.reason, 'lock_contended')
  // The stale lock must be left for the in-flight reclaimer to resolve.
  assert.equal(heldPid(path), 100)
})

test('refuses without a lock path instead of running unlocked', () => {
  const missing = acquireSingletonLock({ pid: 1 })
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, 'lock_path_required')
})
