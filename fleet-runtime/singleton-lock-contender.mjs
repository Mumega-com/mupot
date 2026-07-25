#!/usr/bin/env node
// Child process for the multi-process singleton-lock regression.
//
// Busy-waits to a shared wall-clock start so N contenders hit the lock inside
// the same few milliseconds, then prints one JSON line with the outcome. A
// winner holds the lock until killed, so losers cannot be explained away by the
// winner having already exited.

import { acquireSingletonLock } from './singleton-lock.mjs'

const path = process.env.LOCK_PATH
const startAt = Number(process.env.START_AT_MS)
const forceFilesystemSocket = process.env.FORCE_FS === '1'

while (Date.now() < startAt) {
  // spin — setTimeout granularity is too coarse to synchronize the contenders
}

const lock = await acquireSingletonLock({ path, forceFilesystemSocket })
process.stdout.write(`${JSON.stringify({ ok: lock.ok, reason: lock.reason, pid: process.pid })}\n`)

if (lock.ok) {
  // Stay alive so every loser observes a live holder, not a vanished one.
  setTimeout(() => {
    lock.release()
    process.exit(0)
  }, 3000)
} else {
  process.exit(0)
}
