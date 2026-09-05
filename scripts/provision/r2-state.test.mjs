// Loom lane tests — R2 ordering invariant, resume-kill, tenant-clamp edges.
// Run: node --test scripts/provision/r2-state.test.mjs  (offline, no network)
// Plan §3 TEST-ORD-1..3 + criterion (c) kill/resume + (d) clamp edges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  newJournal, saveJournal, loadJournal, beginStep, completeStep, deriveNext,
} from './journal.mjs';
import {
  probeEntitlement, guardWorkerDeploy, classifyDeployError, R2_DASHBOARD_DEEP_LINK,
} from './r2-state.mjs';
import { provisionBuckets, deployWorker } from './steps.mjs';

const ACC = 'acc123';
const ARGS = { 'account-id': ACC, tenant: 'acme-test' };

// cfClient double: scripted responses in order; records every call.
function scripted(responses) {
  const calls = [];
  return {
    calls,
    client: {
      accountId: ACC,
      request: async (method, path, body) => {
        calls.push({ method, path, body: body ?? null });
        const next = responses[Math.min(calls.length - 1, responses.length - 1)];
        return typeof next === 'function' ? next(calls.length) : next;
      },
    },
  };
}

const okList = (names) => ({ status: 200, json: { result: names.map((n) => ({ name: n })) }, raw: '' });
const err10042 = { status: 403, json: { code: 10042 }, raw: '{"code":10042}' };
const err10136 = { status: 400, json: { code: 10136 }, raw: '{"code":10136}' };

function tmpJournalPath() {
  const dir = mkdtempSync(join(tmpdir(), 'loom-p0-'));
  return { dir, path: join(dir, 'j.json') };
}

function entitledJournal() {
  const j = newJournal({ tenant: 'acme-test', cfAccountId: ACC, sha: 'deadbeef', migrationsHash: 'mh001' });
  beginStep(j, 'r2_entitlement');
  completeStep(j, 'r2_entitlement', 'GET /r2/buckets 200');
  return j;
}

// ── TEST-ORD-1: deploy refused pre-write while entitlement required ───────────

test('TEST-ORD-1: required probe → guard refuses, zero mutating calls', async () => {
  const { calls, client } = scripted([err10042]);
  const probe = await probeEntitlement(client);
  assert.equal(probe.state, 'entitlement_required');
  const guard = guardWorkerDeploy(probe.state);
  assert.equal(guard.allowed, false);
  assert.equal(guard.exit, 3);
  assert.match(guard.message, /R2 is not enabled/);
  assert.ok(guard.message.includes(R2_DASHBOARD_DEEP_LINK), 'deep link present (string match, not regex — CodeQL js/incomplete-hostname-regexp)');
  assert.equal(calls.length, 1, 'only the GET probe ran');
  assert.equal(calls[0].method, 'GET', 'no POST/PUT/DELETE attempted');
});

test('TEST-ORD-1b: wrangler text-body 10042 (no JSON) still classifies', async () => {
  const { client } = scripted([{
    status: 403, json: null,
    raw: '✘ [ERROR] A request to the Cloudflare API failed. Please enable R2 through the Cloudflare Dashboard. [code: 10042]',
  }]);
  const probe = await probeEntitlement(client);
  assert.equal(probe.state, 'entitlement_required');
});

test('TEST-ORD-1c: deployWorker refuses before invoking deployer', async () => {
  const { path: jp, dir } = tmpJournalPath();
  let invoked = 0;
  const r = await deployWorker({
    journal: entitledJournal(), journalPath: jp, args: ARGS,
    entitlementState: 'entitlement_required',
    deploy: async () => { invoked++; return 'never'; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.exit, 3);
  assert.equal(invoked, 0, 'deployer must not run when refused');
  rmSync(dir, { recursive: true });
});

// ── TEST-ORD-2: 10136 replay fails closed with actionable message ─────────────

test('TEST-ORD-2: 10136 deploy failure parks awaiting_r2_activation', async () => {
  const { path: jp, dir } = tmpJournalPath();
  const journal = entitledJournal();
  await saveJournal(jp, journal);
  const r = await deployWorker({
    journal, journalPath: jp, args: ARGS,
    entitlementState: 'entitlement_active',
    deploy: async () => { throw err10136; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.exit, 3);
  assert.match(r.message, /10136/);
  assert.match(r.message, /dash\.cloudflare\.com/);
  const reloaded = loadJournal(jp);
  const step = reloaded.steps.find((s) => s.id === 'worker_deploy');
  assert.equal(step.ok, false);
  assert.match(step.evidence, /10136/);
  assert.equal(reloaded.parked_state, 'awaiting_r2_activation');
  rmSync(dir, { recursive: true });
});

test('TEST-ORD-2b: non-10136 deploy failure passes through (no false park)', () => {
  const c = classifyDeployError({ status: 500, json: { code: 7000 }, raw: 'boom' });
  assert.equal(c.state, null);
  assert.ok(c.passthrough, 'caller owns non-entitlement failures');
});

// ── TEST-ORD-3: post-activation resume continues at buckets ───────────────────

test('TEST-ORD-3: completed entitlement is verified-not-redone, buckets proceed', async () => {
  const { path: jp, dir } = tmpJournalPath();
  const journal = entitledJournal(); // entitlement proven pre-"restart"
  await saveJournal(jp, journal);
  const resumed = loadJournal(jp); // fresh process after activation
  const before = resumed.steps.find((s) => s.id === 'r2_entitlement').attempt;
  beginStep(resumed, 'r2_entitlement');
  assert.equal(resumed.steps.find((s) => s.id === 'r2_entitlement').attempt, before, 'no re-probe of proven step');
  assert.equal(deriveNext(resumed), null); // nothing else begun yet
  const { client } = scripted([
    { status: 200, json: { success: true }, raw: '{}' }, // POST bucket
    okList(['acme-test-blobs']), // read-back list
  ]);
  const r = await provisionBuckets({ journal: resumed, journalPath: jp, args: ARGS, cfClient: client });
  assert.equal(r.ok, true);
  const done = loadJournal(jp);
  assert.match(done.steps.find((s) => s.id === 'r2_buckets').evidence, /acme-test-blobs/);
  rmSync(dir, { recursive: true });
});

test('buckets: already-exists is success (setup.sh precedent)', async () => {
  const { path: jp, dir } = tmpJournalPath();
  const { client } = scripted([
    { status: 400, json: null, raw: 'A bucket named "acme-test-blobs" already exists.' },
    okList(['acme-test-blobs']),
  ]);
  const r = await provisionBuckets({ journal: entitledJournal(), journalPath: jp, args: ARGS, cfClient: client });
  assert.equal(r.ok, true);
  rmSync(dir, { recursive: true });
});

test('buckets: refuse when journal does not prove entitlement (R1)', async () => {
  const { path: jp, dir } = tmpJournalPath();
  const j = newJournal({ tenant: 'acme-test', cfAccountId: ACC, sha: 'x', migrationsHash: 'y' });
  const { client } = scripted([{ status: 200, json: {}, raw: '' }]);
  await assert.rejects(
    provisionBuckets({ journal: j, journalPath: jp, args: ARGS, cfClient: client }),
    /R1 ordering/,
  );
  rmSync(dir, { recursive: true });
});

// ── resume-kill: crash between save and completion, re-run is clean ───────────

test('resume-kill: begun-but-unsaved-completion resumes without double-apply', async () => {
  const { path: jp, dir } = tmpJournalPath();
  const j = entitledJournal();
  beginStep(j, 'r2_buckets'); // attempt 1 starts…
  await saveJournal(jp, j); // …then the process dies before completeStep
  const afterCrash = loadJournal(jp); // brand-new process, disk state only
  assert.equal(deriveNext(afterCrash), 'r2_buckets', 'crashed step is next, nothing skipped');
  const attemptsBefore = afterCrash.steps.find((s) => s.id === 'r2_entitlement').attempt;
  beginStep(afterCrash, 'r2_buckets'); // re-run resumes it (attempt 2)
  beginStep(afterCrash, 'r2_entitlement'); // completed step must not re-begin
  assert.equal(
    afterCrash.steps.find((s) => s.id === 'r2_entitlement').attempt, attemptsBefore,
    'completed step never double-applies after kill',
  );
  completeStep(afterCrash, 'r2_buckets', 'buckets verified in list: acme-test-blobs');
  await saveJournal(jp, afterCrash);
  assert.equal(deriveNext(loadJournal(jp)), null);
  rmSync(dir, { recursive: true });
});

// ── tenant-clamp edges (criterion d — CLI level, offline) ─────────────────────

function cliExit(args, cwd) {
  try {
    execFileSync('node', ['scripts/provision/provision.mjs', ...args], { cwd, stdio: 'pipe' });
    return { status: 0, stderr: '' };
  } catch (e) {
    return { status: e.status, stderr: String(e.stderr) };
  }
}

test('clamp: MUMEGA (case variant) refused exit 2 (not DNS-safe — never normalized)', () => {
  // Deliberate: uppercase never reaches the clamp because it is not a valid slug.
  // Silent lowercasing would let journal identity ('MUMEGA') diverge from CF
  // resource identity ('mumega'); refusal keeps one canonical form.
  const r = cliExit(['--account-id', 'x', '--token-file', '/etc/hostname', '--tenant', 'MUMEGA', '--sha', 's'], process.cwd());
  assert.equal(r.status, 2);
  assert.match(r.stderr, /DNS-safe/);
});

test('clamp: padded " mumega " refused exit 5 (trim gate)', () => {
  const r = cliExit(['--account-id', 'x', '--token-file', '/etc/hostname', '--tenant', ' mumega ', '--sha', 's'], process.cwd());
  assert.equal(r.status, 5);
});

test('clamp: path-traversal tenant refused exit 2 (charset gate)', () => {
  const r = cliExit(['--account-id', 'x', '--token-file', '/etc/hostname', '--tenant', '../x', '--sha', 's'], process.cwd());
  assert.equal(r.status, 2);
  assert.match(r.stderr, /DNS-safe/);
});

test('clamp: legit slug passes clamp (fails later at token check, exit 2)', () => {
  const r = cliExit(['--account-id', 'x', '--token-file', '/definitely/not/here', '--tenant', 'acme-test', '--sha', 's'], process.cwd());
  assert.equal(r.status, 2, 'clamp passed; token-file preflight fails instead');
  assert.doesNotMatch(r.stderr, /tenant-clamp-refusal/);
});
