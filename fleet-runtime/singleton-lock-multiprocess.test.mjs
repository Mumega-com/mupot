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
