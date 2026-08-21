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
// CI-run measurement against the OFFICIAL LOCAL workerd/Miniflare D1 SIMULATOR — explicitly
// NOT remote, deployed D1. It runs inside actual workerd via @cloudflare/vitest-pool-workers,
// whose D1 binding is Miniflare's own implementation of the D1 API — the same code Wrangler
// ships locally, and materially better than this repo's tests/helpers/sqlite-d1.ts stand-in
// (which the #916 investigation showed is MORE transactional than production, i.e. the wrong
// direction of error to trust). "Local simulator" is the whole claim; see the gap note below.
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

  it('a later aggregate SELECT sees an UPDATE an earlier statement in the SAME batch just made', async () => {
    // Mirrors src/mcp/routines.ts's report_run_usage: statement 0 UPDATEs a value,
    // statement 1 SUMs/reads it back, in the same batch. (Gate correction: this is an
    // UPDATE, not an INSERT — the old title said INSERT and the code never performed one.)
    const [, sumResult] = await db.batch([
      db.prepare(`UPDATE probe SET val = 42 WHERE id = 1`).bind(),
      db.prepare(`SELECT SUM(val) AS total FROM probe`).bind(),
    ])

    expect(sumResult.results?.[0]).toMatchObject({ total: 42 })
  })

  // SEED SANITY CHECK — deliberately NOT a control, and the rename matters.
  //
  // It was originally titled as a control that "rules out the batch trivially returning
  // stale/cached results." IT DOES NOT, AND CANNOT. It batches a single SELECT against the
  // pre-seeded 'pending' row with nothing earlier in the batch to depend on — so a
  // pre-batch-snapshot implementation returns exactly the same 'pending' row. IT PASSES
  // UNDER BOTH COMPETING HYPOTHESES, which makes it incapable of discriminating between
  // them: a vacuous check wearing a control's name.
  //
  // Caught by the correctness gate on this PR (Athena, 2026-08-16), and the irony is the
  // point: a PR whose subject is "#919 overclaimed" shipped an overclaiming test. Same
  // shape as mupot#1076's can_verdict — true on every reachable path, therefore proving
  // nothing. Kept, honestly renamed, because the seed assertion is still worth having: if
  // it fails, the fixture is broken and the two real tests above mean nothing.
  it('seed sanity: the probe row exists and reads back as seeded (NOT a stale-result control)', async () => {
    const [result] = await db.batch([
      db.prepare(`SELECT status FROM probe WHERE id = 1`),
    ])
    expect(result.results?.[0]).toMatchObject({ status: 'pending' })
  })
})
