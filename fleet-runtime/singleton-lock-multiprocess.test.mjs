import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The regression Codex required on d9b9076: from ONE stale lock, N synchronized
// contenders must produce exactly one winner. The previous implementation
// unlinked the lock path from a stale observation, so a late contender deleted
// an earlier winner's live lock — 16 contenders produced 2-3 simultaneous
// owners in 3 of 10 rounds. Set ROUNDS higher when investigating a suspected
// race; 4 is the routine-CI cost/signal balance.
const CONTENDER = join(dirname(fileURLToPath(import.meta.url)), 'singleton-lock-contender.mjs')
const CONTENDERS = 16
const ROUNDS = 4

/** A pid that is definitely not running, so the lock reads as stale. */
function deadPid() {
  const child = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    encoding: 'utf8',
  })
  return Number(child) // exited by the time execFileSync returns
}

function runRound(lockPath) {
  const startAt = Date.now() + 400 // leave room for all children to reach the spin
  const children = Array.from({ length: CONTENDERS }, () =>
    spawn(process.execPath, [CONTENDER], {
      env: { ...process.env, LOCK_PATH: lockPath, START_AT_MS: String(startAt) },
      stdio: ['ignore', 'pipe', 'pipe'],
    }))

  return Promise.all(children.map((child) => new Promise((resolve, reject) => {
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
    // The winner sleeps 3s holding the lock; do not let a hang wedge the suite.
    setTimeout(() => child.kill('SIGKILL'), 15_000).unref()
  })))
}

test('N synchronized contenders on a stale lock produce exactly one winner', async (t) => {
  t.diagnostic(`${CONTENDERS} contenders x ${ROUNDS} rounds`)
  for (let round = 0; round < ROUNDS; round += 1) {
    const lockPath = join(mkdtempSync(join(tmpdir(), 'mupot-lock-mp-')), 'watch.lock')
    // Seed exactly the failing precondition: one lock held by a dead pid.
    writeFileSync(lockPath, `${deadPid()} seeded\n`)

    const results = await runRound(lockPath)
    const winners = results.filter((r) => r.ok)
    assert.equal(
      winners.length,
      1,
      `round ${round}: expected exactly 1 winner, got ${winners.length} `
        + `(${JSON.stringify(results.map((r) => r.reason))})`,
    )
    // Every loser must refuse for a lock reason, not crash or fall through.
    for (const loser of results.filter((r) => !r.ok)) {
      assert.ok(
        ['already_running', 'lock_contended'].includes(loser.reason),
        `round ${round}: unexpected loser reason ${loser.reason}`,
      )
    }
  }
})

test('contenders on a lock held by a LIVE process all refuse', async () => {
  const lockPath = join(mkdtempSync(join(tmpdir(), 'mupot-lock-live-')), 'watch.lock')
  // process.pid is this test runner — definitively alive.
  writeFileSync(lockPath, `${process.pid} live-holder\n`)

  const results = await runRound(lockPath)
  assert.equal(results.filter((r) => r.ok).length, 0)
  for (const loser of results) {
    assert.equal(loser.reason, 'already_running')
  }
})
