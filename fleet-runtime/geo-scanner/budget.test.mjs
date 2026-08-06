import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { claimGroundedQuery } from './budget.mjs'

async function withTempState(run) {
  const dir = await mkdtemp(join(tmpdir(), 'mupot-geo-budget-'))
  try {
    await run(join(dir, 'nested', 'state.json'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('persists all 25 claims and refuses query 26 on the same UTC day', async () => {
  await withTempState(async (stateFile) => {
    for (let index = 1; index <= 25; index++) {
      const result = await claimGroundedQuery({
        stateFile,
        dailyQueryCap: 25,
        now: '2026-07-25T12:00:00.000Z',
      })
      assert.deepEqual(result, {
        ok: true,
        day: '2026-07-25',
        used: index,
        remaining: 25 - index,
      })
    }

    assert.deepEqual(await claimGroundedQuery({
      stateFile,
      dailyQueryCap: 25,
      now: '2026-07-25T23:59:59.999Z',
    }), {
      ok: false,
      reason: 'daily_query_cap_reached',
      day: '2026-07-25',
      used: 25,
      remaining: 0,
    })

    assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), {
      schema: 'dme.geo-query-budget/v1',
      day: '2026-07-25',
      used: 25,
    })
  })
})

test('a later invocation observes persisted usage and a new UTC day resets it', async () => {
  await withTempState(async (stateFile) => {
    assert.equal((await claimGroundedQuery({
      stateFile,
      dailyQueryCap: 3,
      now: '2026-07-25T20:00:00.000Z',
    })).used, 1)
    assert.equal((await claimGroundedQuery({
      stateFile,
      dailyQueryCap: 3,
      now: new Date('2026-07-25T21:00:00.000Z'),
    })).used, 2)

    assert.deepEqual(await claimGroundedQuery({
      stateFile,
      dailyQueryCap: 3,
      now: '2026-07-26T00:00:00.000Z',
    }), {
      ok: true,
      day: '2026-07-26',
      used: 1,
      remaining: 2,
    })
  })
})

test('malformed budget state fails closed without overwriting evidence', async () => {
  await withTempState(async (stateFile) => {
    await mkdir(join(stateFile, '..'), { recursive: true })
    await writeFile(stateFile, '{"day":"not-a-day","used":-1}\n', { mode: 0o600 })

    await assert.rejects(
      claimGroundedQuery({
        stateFile,
        dailyQueryCap: 3,
        now: '2026-07-25T20:00:00.000Z',
      }),
      /budget_state_invalid/,
    )
    assert.equal(await readFile(stateFile, 'utf8'), '{"day":"not-a-day","used":-1}\n')
  })
})

test('an existing lock fails closed and does not make a billable claim', async () => {
  await withTempState(async (stateFile) => {
    await mkdir(join(stateFile, '..'), { recursive: true })
    await writeFile(`${stateFile}.lock`, 'operator inspection required\n', { mode: 0o600 })

    await assert.rejects(
      claimGroundedQuery({
        stateFile,
        dailyQueryCap: 3,
        now: '2026-07-25T20:00:00.000Z',
      }),
      /budget_state_locked/,
    )
    await assert.rejects(readFile(stateFile, 'utf8'), /ENOENT/)
  })
})

test('invalid date and cap fail before touching the budget state', async () => {
  await withTempState(async (stateFile) => {
    await assert.rejects(claimGroundedQuery({
      stateFile,
      dailyQueryCap: 0,
      now: '2026-07-25T20:00:00.000Z',
    }), /invalid_daily_query_cap/)
    await assert.rejects(claimGroundedQuery({
      stateFile,
      dailyQueryCap: 3,
      now: 'today',
    }), /invalid_budget_time/)
    await assert.rejects(readFile(stateFile, 'utf8'), /ENOENT/)
  })
})
