import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { acquireSingletonLock } from './singleton-lock.mjs'

function lockPath(name = 'watch.lock') {
  return join(mkdtempSync(join(tmpdir(), 'mupot-lock-')), 'nested', name)
}

test('acquires a free lock and records the holder pid', () => {
  const path = lockPath()
  const lock = acquireSingletonLock({ path, pid: 4242, isAlive: () => true })
  assert.equal(lock.ok, true)
  assert.equal(lock.reason, 'lock_acquired')
  assert.equal(existsSync(path), true)
  assert.equal(readFileSync(path, 'utf8').trim(), '4242')
  assert.equal(lock.release(), true)
  assert.equal(existsSync(path), false)
})

test('refuses when a live holder owns the lock — the #534 precondition', () => {
  const path = lockPath()
  const first = acquireSingletonLock({ path, pid: 100, isAlive: () => true })
  assert.equal(first.ok, true)

  const second = acquireSingletonLock({ path, pid: 200, isAlive: (pid) => pid === 100 })
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'already_running')
  assert.equal(second.holder_pid, 100)
  // The live holder's lock must survive a refused acquisition.
  assert.equal(readFileSync(path, 'utf8').trim(), '100')
})

test('reclaims a stale lock whose holder is gone (crash must not wedge the watcher)', () => {
  const path = lockPath()
  const dead = acquireSingletonLock({ path, pid: 100, isAlive: () => true })
  assert.equal(dead.ok, true)

  const next = acquireSingletonLock({ path, pid: 200, isAlive: () => false })
  assert.equal(next.ok, true)
  assert.equal(next.reason, 'lock_acquired')
  assert.equal(readFileSync(path, 'utf8').trim(), '200')
})

test('reclaims a lock file that is corrupt or empty', () => {
  const path = lockPath()
  acquireSingletonLock({ path, pid: 1, isAlive: () => false }).release()
  writeFileSync(path, 'not-a-pid\n')

  const lock = acquireSingletonLock({ path, pid: 777, isAlive: () => true })
  assert.equal(lock.ok, true)
  assert.equal(readFileSync(path, 'utf8').trim(), '777')
})

test('release does not delete a lock reclaimed by another holder', () => {
  const path = lockPath()
  const first = acquireSingletonLock({ path, pid: 100, isAlive: () => true })
  const second = acquireSingletonLock({ path, pid: 200, isAlive: () => false })
  assert.equal(second.ok, true)

  // The original holder returning late must not drop the new owner's lock.
  assert.equal(first.release(), false)
  assert.equal(existsSync(path), true)
  assert.equal(readFileSync(path, 'utf8').trim(), '200')
})

test('refuses without a lock path instead of running unlocked', () => {
  const missing = acquireSingletonLock({ pid: 1 })
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, 'lock_path_required')
})
