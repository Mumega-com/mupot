import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The regressions required by adversarial review of PRs d9b9076 and 67a2d7a.
//
// d9b9076 admitted 2-3 simultaneous owners from 16 synchronized contenders: a
// contender unlinked the lock path using an observation taken before another
// had claimed it. 67a2d7a fixed that but reproduced the same shape one level
// up — an expired reclaim-token holder could resume and delete its successor's
// token, letting two more contenders both win.
//
// Both are structurally impossible against a kernel-arbitrated socket bind, so
// these tests assert the invariant rather than the mechanism: whatever the
// implementation, exactly one process may own the lock at a time.
const CONTENDER = join(dirname(fileURLToPath(import.meta.url)), 'singleton-lock-contender.mjs')
const CONTENDERS = 16
const ROUNDS = 4

function freshLockPath() {
  return join(mkdtempSync(join(tmpdir(), 'mupot-lock-mp-')), 'watch.lock')
}

function spawnContender(lockPath, startAt, { forceFs = false } = {}) {
  return spawn(process.execPath, [CONTENDER], {
    env: {
      ...process.env,
      LOCK_PATH: lockPath,
      START_AT_MS: String(startAt),
      FORCE_FS: forceFs ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function collect(child) {
  return new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('error', reject)
    child.on('close', () => {
      const line = out.trim().split('\n').filter(Boolean).pop()
      if (!line) return reject(new Error(`contender produced no result: ${err}`))
      resolve(JSON.parse(line))
    })
    setTimeout(() => child.kill('SIGKILL'), 15_000).unref()
  })
}

function runRound(lockPath, opts) {
  const startAt = Date.now() + 400 // room for every child to reach the spin
  const children = Array.from({ length: CONTENDERS }, () => spawnContender(lockPath, startAt, opts))
  return Promise.all(children.map(collect))
}

test('N synchronized contenders produce exactly one winner', async (t) => {
  t.diagnostic(`${CONTENDERS} contenders x ${ROUNDS} rounds`)
  for (let round = 0; round < ROUNDS; round += 1) {
    const results = await runRound(freshLockPath())
    const winners = results.filter((r) => r.ok)
    assert.equal(
      winners.length,
      1,
      `round ${round}: expected exactly 1 winner, got ${winners.length} `
        + `(${JSON.stringify(results.map((r) => r.reason))})`,
    )
    for (const loser of results.filter((r) => !r.ok)) {
      assert.ok(
        ['already_running', 'lock_contended'].includes(loser.reason),
        `round ${round}: unexpected loser reason ${loser.reason}`,
      )
    }
  }
})

test('contenders refuse while an owner holds the lock', async () => {
  const lockPath = freshLockPath()
  const owner = spawnContender(lockPath, Date.now())
  const ownerResult = await new Promise((resolve, reject) => {
    owner.stdout.once('data', (chunk) => resolve(JSON.parse(String(chunk).trim())))
    owner.on('error', reject)
  })
  assert.equal(ownerResult.ok, true, 'owner must acquire first')

  try {
    const results = await runRound(lockPath)
    assert.equal(results.filter((r) => r.ok).length, 0, 'no contender may join a held lock')
    for (const loser of results) {
      assert.ok(['already_running', 'lock_contended'].includes(loser.reason))
    }
  } finally {
    owner.kill('SIGKILL')
  }
})

test('a SUSPENDED owner still holds the lock — contenders must refuse', async () => {
  // Required by the 67a2d7a review. A stopped process is not dead, but it also
  // cannot answer a probe. Any scheme that infers liveness from a reply will
  // wrongly treat it as abandoned and admit a second consumer.
  const lockPath = freshLockPath()
  const owner = spawnContender(lockPath, Date.now())
  const ownerResult = await new Promise((resolve, reject) => {
    owner.stdout.once('data', (chunk) => resolve(JSON.parse(String(chunk).trim())))
    owner.on('error', reject)
  })
  assert.equal(ownerResult.ok, true, 'owner must acquire first')

  owner.kill('SIGSTOP') // holds the bind, answers nothing
  try {
    const results = await runRound(lockPath)
    assert.equal(
      results.filter((r) => r.ok).length,
      0,
      `suspended owner must still exclude contenders, got ${JSON.stringify(results.map((r) => r.reason))}`,
    )
  } finally {
    owner.kill('SIGCONT')
    owner.kill('SIGKILL')
  }
})

test('the lock is released when its owner dies, without manual cleanup', async () => {
  const lockPath = freshLockPath()
  const owner = spawnContender(lockPath, Date.now())
  await new Promise((resolve, reject) => {
    owner.stdout.once('data', (chunk) => resolve(JSON.parse(String(chunk).trim())))
    owner.on('error', reject)
  })
  owner.kill('SIGKILL') // no chance to run any release path
  await new Promise((resolve) => owner.on('close', resolve))

  const results = await runRound(lockPath)
  assert.equal(
    results.filter((r) => r.ok).length,
    1,
    'a dead owner must not wedge the lock forever',
  )
})

test('a CRASH-STALE filesystem-socket node yields exactly one winner among synchronized contenders', async (t) => {
  // Required by adversarial review of f2cfcc6. Graceful `server.close()` (as
  // used by the earlier fallback tests) unlinks the Unix-socket pathname on
  // its own, so it never exercises real crash staleness. SIGKILL does not run
  // any close/unlink path — the node is left genuinely orphaned on disk,
  // exactly like a killed daemon. 24 contenders then race to reclaim it; the
  // bug this regresses let 2 win (unlink-then-bind was not atomic with the
  // probe that authorized it).
  t.diagnostic(`${CONTENDERS} contenders x ${ROUNDS} rounds, forced filesystem-socket path`)
  for (let round = 0; round < ROUNDS; round += 1) {
    const lockPath = freshLockPath()

    const owner = spawnContender(lockPath, Date.now(), { forceFs: true })
    const ownerResult = await new Promise((resolve, reject) => {
      owner.stdout.once('data', (chunk) => resolve(JSON.parse(String(chunk).trim())))
      owner.on('error', reject)
    })
    assert.equal(ownerResult.ok, true, `round ${round}: owner must acquire the forced-fallback lock first`)
    owner.kill('SIGKILL') // crash, not close — no unlink runs; the node is genuinely stale
    await new Promise((resolve) => owner.on('close', resolve))

    const results = await runRound(lockPath, { forceFs: true })
    const winners = results.filter((r) => r.ok)
    assert.equal(
      winners.length,
      1,
      `round ${round}: expected exactly 1 winner reclaiming a crash-stale node, got ${winners.length} `
        + `(${JSON.stringify(results.map((r) => r.reason))})`,
    )
    for (const loser of results.filter((r) => !r.ok)) {
      assert.ok(
        ['already_running', 'lock_contended'].includes(loser.reason),
        `round ${round}: unexpected loser reason ${loser.reason}`,
      )
    }
  }
})

test('repeated crash+reclaim cycles on the SAME path never accumulate a wedge (regresses the reap-ticket design)', async (t) => {
  // Required by adversarial review of 00105de. The reap-ticket design named a
  // reclaim mutex deterministically by (dev,ino) and unlinked `address` as a
  // SEPARATE second step; a contender that died between winning the ticket
  // and unlinking `address` left the ticket permanently claimed while
  // `address` was never cleared — every later contender computed the same
  // ticket name, got EEXIST forever, and the lock was dead for good. The
  // rename-based fix collapses "claim the right to clear" and "actually
  // clear" into one atomic syscall, so there is no window a crash can land in
  // to produce that state. This asserts the OUTCOME rather than the removed
  // mechanism: many crash+reclaim cycles in a row, reusing the identical
  // path (so any accumulating debris would show up), must never fail to
  // produce a winner.
  const CYCLES = 12
  const lockPath = freshLockPath()
  t.diagnostic(`${CYCLES} sequential crash+reclaim cycles on one path, forced filesystem-socket`)

  for (let cycle = 0; cycle < CYCLES; cycle += 1) {
    const owner = spawnContender(lockPath, Date.now(), { forceFs: true })
    const ownerResult = await new Promise((resolve, reject) => {
      owner.stdout.once('data', (chunk) => resolve(JSON.parse(String(chunk).trim())))
      owner.on('error', reject)
    })
    assert.equal(ownerResult.ok, true, `cycle ${cycle}: owner must acquire`)
    owner.kill('SIGKILL')
    await new Promise((resolve) => owner.on('close', resolve))

    const successor = spawnContender(lockPath, Date.now(), { forceFs: true })
    const successorResult = await new Promise((resolve, reject) => {
      successor.stdout.once('data', (chunk) => resolve(JSON.parse(String(chunk).trim())))
      successor.on('error', reject)
    })
    assert.equal(
      successorResult.ok,
      true,
      `cycle ${cycle}: reclaim must still succeed after ${cycle} prior crash+reclaim cycles on this path`,
    )
    successor.kill('SIGKILL') // crash this one too, feeding the next cycle a fresh corpse
    await new Promise((resolve) => successor.on('close', resolve))
  }
})

test('a clean release() racing live contenders yields exactly one new winner, never two', async (t) => {
  // Required by adversarial review of 00105de. release() reordering matters:
  // `server.close()` was bound to the temp claim path, not `address`, so it
  // stops accepting connections immediately while `address` the file still
  // exists — a probe arriving in that gap sees ECONNREFUSED against a name
  // that still has a directory entry, indistinguishable from crash staleness,
  // and can legitimately win the reclaim race for `address` before the
  // releasing owner's own unlink runs. If release() unlinked AFTER close(),
  // that unlink could then delete the new owner's fresh claim. The contender
  // holds its lock for exactly 3s (singleton-lock-contender.mjs) then
  // releases; timing fresh contenders to arrive right around that release
  // point exercises the actual close()/unlink() ordering under real
  // scheduling jitter, not just a synthetic single-process race.
  const CONTENDERS_AT_RELEASE = 12
  t.diagnostic(`owner holds ~3s then releases; ${CONTENDERS_AT_RELEASE} contenders arrive around the release point`)
  const lockPath = freshLockPath()

  const owner = spawnContender(lockPath, Date.now(), { forceFs: true })
  // Attach the close listener NOW, not after awaiting the contenders below —
  // the owner only holds for ~3s and emits 'close' well before that later
  // point, so a listener attached afterward misses the already-fired event
  // and waits forever (a real bug caught while writing this test, not in the
  // lock: the fix is ordering the listener registration correctly).
  const ownerClosed = new Promise((resolve) => owner.on('close', resolve))
  const ownerResult = await new Promise((resolve, reject) => {
    owner.stdout.once('data', (chunk) => resolve(JSON.parse(String(chunk).trim())))
    owner.on('error', reject)
  })
  assert.equal(ownerResult.ok, true, 'owner must acquire before the release race can begin')

  // Spread arrivals across the owner's ~3000ms hold-then-release window so
  // some land well before release (must refuse), some right at it (must not
  // double-win), and some after (must singly succeed).
  const startAt = Date.now() + 2600
  const children = Array.from({ length: CONTENDERS_AT_RELEASE }, (_, i) =>
    spawnContender(lockPath, startAt + i * 60, { forceFs: true }))
  const results = await Promise.all(children.map(collect))
  await ownerClosed

  const winners = results.filter((r) => r.ok)
  assert.equal(
    winners.length,
    1,
    `expected exactly 1 winner around the release point, got ${winners.length} `
      + `(${JSON.stringify(results.map((r) => r.reason))})`,
  )
  for (const loser of results.filter((r) => !r.ok)) {
    assert.ok(
      ['already_running', 'lock_contended'].includes(loser.reason),
      `unexpected loser reason ${loser.reason}`,
    )
  }
})
