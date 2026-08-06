import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { MAX_DAILY_GROUNDED_QUERIES } from './contract.mjs'

const BUDGET_SCHEMA = 'dme.geo-query-budget/v1'
const UTC_DAY_RE = /^\d{4}-\d{2}-\d{2}$/

function utcDay(now) {
  const date = now instanceof Date ? new Date(now.getTime()) : new Date(now)
  if (!Number.isFinite(date.getTime())) throw new Error('invalid_budget_time')
  return date.toISOString().slice(0, 10)
}

function parseState(raw) {
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('budget_state_invalid')
  }
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'day,schema,used'
    || value.schema !== BUDGET_SCHEMA
    || typeof value.day !== 'string'
    || !UTC_DAY_RE.test(value.day)
    || !Number.isInteger(value.used)
    || value.used < 0
    || value.used > MAX_DAILY_GROUNDED_QUERIES
  ) throw new Error('budget_state_invalid')
  return value
}

async function readState(stateFile) {
  try {
    return parseState(await readFile(stateFile, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export async function claimGroundedQuery({ stateFile, dailyQueryCap, now }) {
  if (
    !Number.isInteger(dailyQueryCap)
    || dailyQueryCap < 1
    || dailyQueryCap > MAX_DAILY_GROUNDED_QUERIES
  ) throw new Error('invalid_daily_query_cap')
  if (typeof stateFile !== 'string' || !stateFile) throw new Error('invalid_state_file')
  const day = utcDay(now)
  const stateDir = dirname(stateFile)
  const lockFile = `${stateFile}.lock`
  const tempFile = `${stateFile}.tmp-${process.pid}-${Date.now()}`
  await mkdir(stateDir, { recursive: true, mode: 0o700 })

  let lock
  try {
    lock = await open(lockFile, 'wx', 0o600)
    await lock.writeFile(`${process.pid}\n`)
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('budget_state_locked')
    throw new Error('budget_state_lock_failed')
  }

  try {
    const stored = await readState(stateFile)
    const used = stored?.day === day ? stored.used : 0
    if (used >= dailyQueryCap) {
      return {
        ok: false,
        reason: 'daily_query_cap_reached',
        day,
        used,
        remaining: 0,
      }
    }
    const nextUsed = used + 1
    const next = {
      schema: BUDGET_SCHEMA,
      day,
      used: nextUsed,
    }
    await writeFile(tempFile, `${JSON.stringify(next)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(tempFile, stateFile)
    return {
      ok: true,
      day,
      used: nextUsed,
      remaining: dailyQueryCap - nextUsed,
    }
  } finally {
    try {
      await unlink(tempFile)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await lock.close()
    await unlink(lockFile)
  }
}
