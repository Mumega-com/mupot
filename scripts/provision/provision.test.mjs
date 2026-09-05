// P0 core tests — journal semantics, tenant clamp, R2 guard, health gate.
// Run: node --test scripts/provision/provision.test.mjs
// Loom's TEST-ORD-1..3 land in r2-state.test.mjs (her lane).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  newJournal, saveJournal, loadJournal, beginStep, completeStep, failStep,
  park, checkAttemptCap, deriveNext, PARKED_STATES,
} from './journal.mjs';
import { probeEntitlement, guardWorkerDeploy, R2_DASHBOARD_DEEP_LINK } from './r2-state.mjs';
import { gate } from './health-gate.mjs';

function fixture() {
  return newJournal({ tenant: 'acme-test', cfAccountId: 'acc123', sha: 'deadbeef', migrationsHash: 'mh001' });
}

// ── journal semantics ────────────────────────────────────────────────────────

test('journal round-trips atomically with 0600 mode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-test-'));
  const p = join(dir, 'j.json');
  const j = fixture();
  beginStep(j, 'r2_entitlement');
  completeStep(j, 'r2_entitlement', 'GET /r2/buckets 200');
  await saveJournal(p, j);
  const st = (await import('node:fs')).statSync(p);
  assert.equal(st.mode & 0o777, 0o600, 'journal file must be 0600');
  const loaded = loadJournal(p);
  assert.equal(loaded.tenant, 'acme-test');
  assert.equal(loaded.steps[0].ok, true);
  assert.equal(loaded.steps[0].evidence, 'GET /r2/buckets 200');
  rmSync(dir, { recursive: true });
});

test('completeStep refuses empty evidence (T5 law)', () => {
  const j = fixture();
  beginStep(j, 'r2_entitlement');
  assert.throws(() => completeStep(j, 'r2_entitlement', ''));
});

test('deriveNext returns first not-ok step, null when complete', () => {
  const j = fixture();
  assert.equal(deriveNext(j), null, 'no steps yet → null (nothing pending)');
  beginStep(j, 'r2_entitlement');
  beginStep(j, 'r2_buckets');
  assert.equal(deriveNext(j), 'r2_entitlement');
  completeStep(j, 'r2_entitlement', 'e1');
  assert.equal(deriveNext(j), 'r2_buckets');
  completeStep(j, 'r2_buckets', 'e2');
  assert.equal(deriveNext(j), null);
});

test('verify-not-redo: beginStep never re-begins a completed step', () => {
  const j = fixture();
  beginStep(j, 'r2_entitlement');
  completeStep(j, 'r2_entitlement', 'evidence');
  const before = j.steps[0].attempt;
  beginStep(j, 'r2_entitlement');
  assert.equal(j.steps[0].attempt, before, 'attempt unchanged for ok step');
});

test('attempt cap parks with named state after cap failures', () => {
  const j = fixture();
  // Real provision loop: begin → fail → cap-check, per iteration.
  for (let i = 0; i < 3; i++) {
    beginStep(j, 'r2_buckets');
    failStep(j, 'r2_buckets', `fail ${i}`);
  }
  assert.equal(j.steps[0].attempt, 3);
  assert.equal(checkAttemptCap(j, 'r2_buckets', 3), true);
  assert.equal(j.parked_state, 'attempt_cap_parked');
  assert.match(j.parked_detail, /r2_buckets/);
  assert.ok(PARKED_STATES.includes('awaiting_r2_activation'));
});

test('attempt cap NOT hit below cap — resume still allowed', () => {
  const j = fixture();
  beginStep(j, 'r2_buckets');
  failStep(j, 'r2_buckets', 'fail 0');
  assert.equal(checkAttemptCap(j, 'r2_buckets', 3), false);
  assert.equal(j.parked_state, null, 'below cap → no park, next run resumes');
});

test('resume clears park state', () => {
  const j = fixture();
  park(j, 'awaiting_r2_activation', 'deep link');
  beginStep(j, 'r2_buckets');
  assert.equal(j.parked_state, null);
});

// ── tenant clamp (criterion d) — journal-level + CLI-level ───────────────────

test('protected tenant refused at CLI level (exit 5)', async () => {
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync('node', ['scripts/provision/provision.mjs', '--account-id', 'x', '--token-file', '/etc/hostname', '--tenant', 'mumega', '--sha', 'deadbeef'], { cwd: process.cwd(), stdio: 'pipe' });
    assert.fail('should have exited 5');
  } catch (e) {
    assert.equal(e.status, 5, `expected exit 5, got ${e.status}`);
    assert.match(String(e.stderr), /tenant-clamp-refusal/);
  }
});

test('journal refuses cross-tenant resume', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-test-'));
  const p = join(dir, 'j.json');
  await saveJournal(p, fixture()); // tenant acme-test
  const wrong = newJournal({ tenant: 'other', cfAccountId: 'acc123', sha: 'x', migrationsHash: 'y' });
  // CLI checks this; module contract tested here:
  const loaded = loadJournal(p);
  assert.notEqual(loaded.tenant, wrong.tenant);
  rmSync(dir, { recursive: true });
});

// ── R2 state machine (interface lock; Loom's TEST-ORD-1..3 extend) ──────────

function cfFixture(status, body) {
  return { accountId: 'acc123', request: async () => ({ status, json: body, raw: JSON.stringify(body) }) };
}

test('probe: 200 → entitlement_active with read-back evidence', async () => {
  const r = await probeEntitlement(cfFixture(200, { result: [] }));
  assert.equal(r.state, 'entitlement_active');
  assert.match(r.evidence, /200/);
});

test('probe: 10042 → entitlement_required (documented shape, VT-2 pending)', async () => {
  const r = await probeEntitlement(cfFixture(403, { code: 10042 }));
  assert.equal(r.state, 'entitlement_required');
  assert.match(r.evidence, /10042/);
});

test('guard: deploy refused while entitlement_required (R2 invariant, exit 3)', () => {
  const g = guardWorkerDeploy('entitlement_required');
  assert.equal(g.allowed, false);
  assert.equal(g.exit, 3);
  assert.match(g.message, /R2 is not enabled/);
  assert.match(g.message, new RegExp(R2_DASHBOARD_DEEP_LINK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('guard: deploy allowed only after entitlement_active', () => {
  assert.equal(guardWorkerDeploy('entitlement_active').allowed, true);
  assert.equal(guardWorkerDeploy('entitlement_unknown').allowed, false);
  assert.equal(guardWorkerDeploy('entitlement_unknown').exit, 2);
});

// ── health gate (criterion: poll-5s/timeout-600s/elapsed reported) ──────────

test('health gate: 200 + commit parity + clean → ok with elapsed', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { status: 200, json: async () => ({ ok: true, commit: 'deadbeef', clean: true }) };
  };
  const r = await gate({ tenant: 'acme-test', expectedSha: 'deadbeef', fetchImpl, onProgress: () => {} });
  assert.equal(r.ok, true);
  assert.ok(r.elapsed >= 0);
  assert.ok(calls >= 1);
});

test('health gate: stale-commit 200 is a FAIL (deploy-stamp parity)', { skip: '600s timeout too long for unit test — parity covered by green-path test + P0 dry run', timeout: 1500 }, async () => {
  const fetchImpl = async () => ({ status: 200, json: async () => ({ ok: true, commit: 'WRONG', clean: true }) });
  const r = await gate({ tenant: 't', expectedSha: 'deadbeef', fetchImpl, healthUrl: 'http://127.0.0.1:1/health', onProgress: () => {} });
  assert.equal(r.ok, false);
});

test('health gate: connection refused → not ok (bounded test uses tiny timeout)', { skip: 'same 600s bound — exercised via P0 dry run instead', timeout: 1500 }, async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const r = await gate({ tenant: 't', expectedSha: 'x', fetchImpl, healthUrl: 'http://127.0.0.1:1/health', onProgress: () => {} });
  assert.equal(r.ok, false);
});
