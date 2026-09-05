// P0 bucket + deploy steps — Loom lane (flight/zero-install-p0-provision-core).
//
// R2 refusal wiring (plan §3): buckets are created ONLY after the journal proves
// entitlement (R1 ordering); worker deploy is guarded pre-write and 10136-class
// deploy failures park (TEST-ORD-2). All Cloudflare I/O goes through the injected
// `cfClient` ({ request(method, path, body) -> { status, json, raw } }) so every
// path runs offline in tests; provision.mjs passes the real makeCfClient client.
// The actual deploy executor is injected as `deploy` (Mubot's CLI lane wires the
// real one) — default throws rather than inventing deploy mechanics here.

import {
  beginStep, completeStep, failStep, saveJournal, checkAttemptCap, park,
} from './journal.mjs';
import {
  guardWorkerDeploy, classifyDeployError, ERR_NOT_ENTITLED,
} from './r2-state.mjs';

// Idempotent tolerance, same precedent as setup.sh provision_r2():
// "already exists|already owned" ⇒ success, never an error.
const ALREADY_EXISTS_RE = /already exists|already owned/i;

function defaultBucketNames(tenant) {
  return [`${tenant}-blobs`]; // mirrors wrangler.toml BLOBS binding pattern
}

export async function provisionBuckets({ journal, journalPath, args, cfClient, bucketNames }) {
  const ent = (journal.steps ?? []).find((s) => s.id === 'r2_entitlement');
  if (!ent || ent.ok !== true) {
    throw new Error('steps: refusing bucket create — journal does not prove r2_entitlement (R1 ordering)');
  }
  const names = bucketNames ?? defaultBucketNames(args.tenant);
  const step = beginStep(journal, 'r2_buckets');
  if (step.ok === true) return { ok: true, resumed: true }; // verify-not-redo
  const accountId = args['account-id'];
  for (const name of names) {
    const res = await cfClient.request('POST', `/accounts/${accountId}/r2/buckets`, { name });
    if (res.status === 200 || res.status === 201) continue;
    const code = String(res?.json?.code ?? '');
    const raw = String(res?.raw ?? '');
    if (ALREADY_EXISTS_RE.test(raw)) continue;
    if (code === ERR_NOT_ENTITLED) {
      // Entitlement lapsed between probe and create — same park as probe-time.
      failStep(journal, 'r2_buckets', `POST /r2/buckets code:10042 for ${name} (entitlement lapsed post-probe)`);
      if (!checkAttemptCap(journal, 'r2_buckets')) {
        park(journal, 'awaiting_r2_activation', `R2 entitlement lapsed during bucket create (${name})`);
      }
      await saveJournal(journalPath, journal);
      return { ok: false, exit: 3, parked: journal.parked_state };
    }
    failStep(journal, 'r2_buckets', `POST /r2/buckets ${res.status} for ${name}: ${raw.slice(0, 200)}`);
    await saveJournal(journalPath, journal);
    return { ok: false, exit: 2, message: `bucket create failed for ${name} — see journal evidence` };
  }
  // T5 read-back: list must contain every name before the step counts.
  const list = await cfClient.request('GET', `/accounts/${accountId}/r2/buckets`);
  const have = new Set(((list?.json?.result ?? []).map((b) => b?.name)).filter(Boolean));
  const missing = names.filter((n) => !have.has(n));
  if (missing.length) {
    failStep(journal, 'r2_buckets', `read-back: buckets missing from list: ${missing.join(',')}`);
    await saveJournal(journalPath, journal);
    return { ok: false, exit: 2, message: `bucket create unverified for ${missing.join(',')} — see journal evidence` };
  }
  completeStep(journal, 'r2_buckets', `buckets verified in list: ${names.join(',')}`);
  await saveJournal(journalPath, journal);
  return { ok: true };
}

export async function deployWorker({ journal, journalPath, args, entitlementState, deploy }) {
  const guard = guardWorkerDeploy(entitlementState);
  if (!guard.allowed) return { ok: false, exit: guard.exit, message: guard.message }; // TEST-ORD-1: refused pre-write
  const run = deploy ?? (() => { throw new Error('steps: no deployer wired — CLI lane provides the wrangler deploy executor'); });
  const step = beginStep(journal, 'worker_deploy');
  if (step.ok === true) return { ok: true, resumed: true };
  try {
    const evidence = await run();
    completeStep(journal, 'worker_deploy', typeof evidence === 'string' && evidence ? evidence : 'deployer reported ok');
  } catch (err) {
    const res = err && typeof err === 'object' && ('status' in err || 'json' in err || 'raw' in err) ? err : null;
    const classified = classifyDeployError(res);
    if (classified.state === 'entitlement_required') {
      failStep(journal, 'worker_deploy', classified.evidence);
      if (!checkAttemptCap(journal, 'worker_deploy')) {
        park(journal, 'awaiting_r2_activation', classified.evidence);
      }
      await saveJournal(journalPath, journal);
      return { ok: false, exit: 3, message: classified.message }; // TEST-ORD-2
    }
    failStep(journal, 'worker_deploy', `deployer failed: ${String(err?.message ?? err).slice(0, 200)}`);
    if (!checkAttemptCap(journal, 'worker_deploy')) {
      park(journal, 'manual_intervention_required', 'worker deploy failed (non-entitlement) — see journal evidence');
    }
    await saveJournal(journalPath, journal);
    return { ok: false, exit: 1 };
  }
  await saveJournal(journalPath, journal);
  return { ok: true };
}
