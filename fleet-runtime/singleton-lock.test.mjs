import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { acquireSingletonLock } from './singleton-lock.mjs'

function lockPath(name = 'watch.lock') {
  return join(mkdtempSync(join(tmpdir(), 'mupot-lock-')), name)
}

test('acquires a free lock', async () => {
  const lock = await acquireSingletonLock({ path: lockPath() })
  assert.equal(lock.ok, true)
  assert.equal(lock.reason, 'lock_acquired')
  assert.equal(lock.holder_pid, process.pid)
  assert.equal(lock.release(), true)
})

test('a second acquisition on the same path refuses while the first is held', async () => {
  const path = lockPath()
  const first = await acquireSingletonLock({ path })
  assert.equal(first.ok, true)

  const second = await acquireSingletonLock({ path })
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'already_running')
  assert.equal(second.holder_pid, process.pid)

  first.release()
})

test('release frees the name for the next acquirer', async () => {
  const path = lockPath()
  const first = await acquireSingletonLock({ path })
  assert.equal(first.ok, true)
  assert.equal(first.release(), true)

  const second = await acquireSingletonLock({ path })
  assert.equal(second.ok, true, 'released lock must be reacquirable')
  second.release()
})

test('distinct paths do not contend', async () => {
  const a = await acquireSingletonLock({ path: lockPath('a.lock') })
  const b = await acquireSingletonLock({ path: lockPath('b.lock') })
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  a.release()
  b.release()
})

test('refuses without a lock path instead of running unlocked', async () => {
  const missing = await acquireSingletonLock({})
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, 'lock_path_required')
})
