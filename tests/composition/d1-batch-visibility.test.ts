// tests/composition/d1-batch-visibility.test.ts — mupot#919.
//
// #919 claimed 24 of 46 env.DB.batch() call sites are defective because "on production D1
// [a later statement in the batch] does not observe [an earlier statement's write]". That
// claim was never proven for a plain UPDATE/SELECT — only for a trigger's WHEN clause
// (PR#927, closing comment) — and #916, the founding example, turned out to have both
// receipts written and delivered in production all along (PR#943). #927 was closed WITHOUT
// merging its 24-site fix; #919 itself was never updated or closed to say so.
//
// This file is this flight's (FLIGHT-009B) contribution to that record: a permanent,
// CI-run measurement against the REAL platform implementation, not a claim in a comment or
// an issue body. It runs inside actual workerd via @cloudflare/vitest-pool-workers, whose D1
// binding is Miniflare's own implementation of the D1 API — the same code Wrangler ships,
// not this repo's tests/helpers/sqlite-d1.ts stand-in (which the #916 investigation already
// showed is MORE transactional than production, i.e. the wrong direction of error to trust).
//
// What this does NOT prove: it cannot reach Cloudflare's remote, deployed D1 (this run had
// no live CF credentials). So it settles the LOCAL half of "verify against a real local run"
// from FLIGHT-009B's brief, and is offered as corroborating, not conclusive, evidence for
// the remote case. See the PR body for the full chain, including the one data point that IS
// from production: PR#927's closing comment observed a BEFORE INSERT trigger's WHEN clause
// reading a same-batch write on live D1 (migration 0071, member_tokens_agent_binding_insert)
// — i.e. the one production data point that exists points the SAME direction as this test,
// not the direction #919 assumed.
import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'

// `cloudflare:test`'s `env` is typed from the project's own wrangler config, which does not
// declare D1_BATCH_PROBE (it is injected ad hoc in vitest.composition.config.ts for this
// file only — see the comment there). Casting through `unknown` is the accepted escape hatch
// for a binding intentionally absent from the real Env type; no other `as` in this file.
const db = (env as unknown as { D1_BATCH_PROBE: D1Database }).D1_BATCH_PROBE

beforeEach(async () => {
  await db.exec('DROP TABLE IF EXISTS probe')
  await db.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, status TEXT, val INTEGER)')
  await db.exec("INSERT INTO probe (id, status, val) VALUES (1, 'pending', 0)")
})

describe('#919 — D1Database.batch() intra-batch read visibility (real workerd D1)', () => {
  it('a later statement sees an UPDATE an earlier statement in the SAME batch just made', async () => {
    // Mirrors the shape #919 called the "keystone": src/routines/scheduler.ts's
    // claimRoutineRun batches `UPDATE routine_runs SET status='leased' ...` with an
    // `INSERT ... SELECT ... FROM routine_runs WHERE status='leased' ...` reading back
    // exactly what the UPDATE just set, in one env.DB.batch() call.
    const [updateResult, selectResult] = await db.batch([
      db.prepare(`UPDATE probe SET status = ? WHERE id = 1`).bind('leased'),
      db.prepare(`SELECT * FROM probe WHERE status = ?`).bind('leased'),
    ])

    expect(updateResult.meta?.changes).toBe(1)
    // If #919's premise held, this SELECT would see the pre-batch snapshot (status='pending')
    // and return zero rows — exactly the "silent zero rows" failure mode #919 describes.
    expect(selectResult.results).toHaveLength(1)
    expect(selectResult.results?.[0]).toMatchObject({ status: 'leased' })
  })

  it('a later statement sees an INSERT an earlier statement in the SAME batch just made', async () => {
    // Mirrors src/mcp/routines.ts's report_run_usage: statement 0 UPDATEs a value,
    // statement 1 SUMs/reads it back, in the same batch.
    const [, sumResult] = await db.batch([
      db.prepare(`UPDATE probe SET val = 42 WHERE id = 1`).bind(),
      db.prepare(`SELECT SUM(val) AS total FROM probe`).bind(),
    ])

    expect(sumResult.results?.[0]).toMatchObject({ total: 42 })
  })

  it('the effect is NOT explained by an implicit whole-batch transaction masking a real gap', async () => {
    // Control: a batch statement that depends on NOTHING earlier in the batch still reads
    // the pre-existing 'pending' row correctly — rules out the batch trivially returning
    // stale/cached results regardless of what happened before it.
    const [result] = await db.batch([
      db.prepare(`SELECT status FROM probe WHERE id = 1`),
    ])
    expect(result.results?.[0]).toMatchObject({ status: 'pending' })
  })
})
