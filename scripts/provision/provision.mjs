#!/usr/bin/env node
// Provision CLI — P0 core (flight/zero-install-p0-provision-core)
//
// Non-interactive surface (#1310): agents/CI provision pots without a TTY.
// Exit codes (plan §2 input §4, dual-signed):
//   0 ok · 1 uncaught/internal · 2 preflight-fail · 3 activation-required
//   (parked, deep link printed) · 4 health-gate-timeout · 5 tenant-clamp-refusal
//
// Constraints: ZERO model calls. Secrets via FILE PATHS only (never argv/env
// echo). Tenant clamp: NEVER writes into the mumega pot — fail closed (exit 5).
// setup.sh untouched (owner absent) — this is the NEW provisioner entry.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  newJournal, saveJournal, loadJournal, beginStep, completeStep, failStep,
  park, checkAttemptCap, deriveNext,
} from './journal.mjs';
import { probeEntitlement, guardWorkerDeploy, R2_DASHBOARD_DEEP_LINK } from './r2-state.mjs';

const PROTECTED_TENANTS = new Set(['mumega', 'mupot', 'mumega-com']);

// DNS-safe slugs only: the tenant lands in journal paths and CF resource names.
// Loom 2026-09-04 (tenant-clamp lane — Mubot review): trim + charset gate so
// ' MUMEGA ' or '../x' cannot slip the clamp or the journal path.
const TENANT_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function parseArgs(argv) {
  const args = {
    'account-id': null, 'token-file': null, 'tenant': null,
    'journal-path': null, 'sha': null, 'config': null, 'dry-run': false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--account-id') args['account-id'] = argv[++i];
    else if (a === '--token-file') args['token-file'] = argv[++i];
    else if (a === '--tenant') args.tenant = argv[++i];
    else if (a === '--journal-path') args['journal-path'] = argv[++i];
    else if (a === '--sha') args.sha = argv[++i];
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--dry-run') args['dry-run'] = true;
    else if (a === '--help' || a === '-h') return { ...args, help: true };
    else throw new Error(`unknown arg: ${a}`);
  }
  return args;
}

function usage() {
  console.log(`provision.mjs — non-interactive pot provisioner (P0)

  --account-id <id>      Cloudflare account id (required)
  --token-file <path>    file containing mupot/cf token, 0600 (required; PATH only — never echoed)
  --tenant <slug>        tenant slug (required; 'mumega' is refused — exit 5)
  --sha <git-sha>        deploy SHA to pin and verify at health gate (required)
  --journal-path <path>  journal file (default: ~/.fleet/provision/<tenant>.journal.json)
  --dry-run              run preflight + entitlement probe, write nothing

Exit codes: 0 ok · 1 internal · 2 preflight-fail · 3 activation-required ·
4 health-gate-timeout · 5 tenant-clamp-refusal`);
}

function preflight(args) {
  if (typeof args.tenant === 'string') args.tenant = args.tenant.trim();
  const missing = ['account-id', 'token-file', 'tenant', 'sha'].filter((k) => !args[k]);
  if (missing.length) {
    console.error(`preflight-fail: missing required args: ${missing.map((m) => `--${m}`).join(', ')}`);
    console.error(usage());
    process.exit(2);
  }
  if (!TENANT_RE.test(args.tenant)) {
    console.error(`preflight-fail: tenant '${args.tenant}' is not a DNS-safe slug [a-z0-9-] — refusing`);
    process.exit(2);
  }
  if (PROTECTED_TENANTS.has(String(args.tenant).toLowerCase())) {
    console.error(`tenant-clamp-refusal: tenant '${args.tenant}' is protected — provisioning into it is refused (fail closed)`);
    process.exit(5);
  }
  try { execFileSync('stat', ['-c', '%a', args['token-file']], { stdio: 'pipe' }); }
  catch { console.error(`preflight-fail: token file not readable at path`); process.exit(2); }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); process.exit(0); }
  preflight(args);

  const defaultJournal = path.join(process.env.HOME ?? '/home/mumega', '.fleet', 'provision', `${args.tenant}.journal.json`);
  const journalPath = args['journal-path'] ?? defaultJournal;

  // Resolve pinned SHA + migrations dir hash (plan §4: pin BOTH).
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  const sha = args.sha;
  const migrationsHash = createHash('sha256')
    .update(execFileSync('git', ['-C', repoRoot, 'ls-files', 'migrations/']).toString())
    .digest('hex')
    .slice(0, 16);

  let journal = loadJournal(journalPath) ?? newJournal({
    tenant: args.tenant, cfAccountId: args['account-id'], sha,
    migrationsHash, tokenFilePath: args['token-file'],
  });
  if (journal.tenant !== args.tenant) {
    console.error(`preflight-fail: journal at ${journalPath} belongs to tenant '${journal.tenant}' — refusing cross-tenant resume`);
    process.exit(2);
  }
  if (journal.pinned_sha && journal.pinned_sha !== sha) {
    console.error(`preflight-fail: journal pinned to SHA ${journal.pinned_sha}, requested ${sha} — pin a new journal for a new SHA`);
    process.exit(2);
  }
  await saveJournal(journalPath, journal);

  // ── Step 1: R2 entitlement (R1: probe BEFORE any bucket op) ────────────────
  const ent = beginStep(journal, 'r2_entitlement');
  if (ent.ok !== true) {
    const { makeCfClient } = await import('./cf-client.mjs');
    const client = makeCfClient({ accountId: args['account-id'], tokenPath: args['token-file'] });
    const probe = await probeEntitlement(client);
    if (probe.state === 'entitlement_active') {
      completeStep(journal, 'r2_entitlement', probe.evidence);
      await saveJournal(journalPath, journal);
    } else if (probe.state === 'entitlement_required') {
      failStep(journal, 'r2_entitlement', probe.evidence);
      if (!checkAttemptCap(journal, 'r2_entitlement')) {
        park(journal, 'awaiting_r2_activation', 'R2 not enabled on this account — activation is dashboard-only (workers-sdk#15468)');
      }
      await saveJournal(journalPath, journal);
      console.log(`awaiting_r2_activation — open ${R2_DASHBOARD_DEEP_LINK} to enable R2, then re-run; provisioning resumes automatically.`);
      process.exit(3);
    } else {
      failStep(journal, 'r2_entitlement', probe.evidence);
      if (!checkAttemptCap(journal, 'r2_entitlement')) {
        park(journal, 'manual_intervention_required', probe.evidence);
      }
      await saveJournal(journalPath, journal);
      console.error('preflight-fail: R2 entitlement unknown — see journal evidence');
      process.exit(2);
    }
  }

  if (args['dry-run']) {
    console.log(`dry-run ok: entitlement active, journal ${journalPath}, next=${deriveNext(journal)}`);
    process.exit(0);
  }

  // ── Steps 2..n: buckets → deploy → health gate (implemented in P0 lanes) ───
  // Loom lane: bucket create + deploy guard (R2 refusal wiring + TEST-ORD-2).
  // Mubot lane: client wiring + health gate below.
  const { provisionBuckets, deployWorker } = await import('./steps.mjs');
  const { makeCfClient } = await import('./cf-client.mjs');
  const client = makeCfClient({ accountId: args['account-id'], tokenPath: args['token-file'] });

  const buckets = await provisionBuckets({ journal, journalPath, args, cfClient: client });
  if (!buckets.ok) {
    console.error(buckets.message ?? `bucket step failed (exit ${buckets.exit}) — see journal evidence`);
    process.exit(buckets.exit);
  }
  const deploy = await deployWorker({ journal, journalPath, args, entitlementState: 'entitlement_active', deploy: makeDeployExecutor(args) });
  if (!deploy.ok) {
    console.error(deploy.message ?? `deploy step failed (exit ${deploy.exit}) — see journal evidence`);
    process.exit(deploy.exit);
  }

  // ── Health gate (poll-5s / timeout-600s / elapsed reported — §2 verified shape) ──
  const health = await import('./health-gate.mjs');
  const hg = beginStep(journal, 'health_gate');
  if (hg.ok !== true) {
    const result = await health.gate({
      tenant: args.tenant, expectedSha: sha,
      onProgress: (s) => process.stdout.write(s),
    });
    if (!result.ok) {
      failStep(journal, 'health_gate', `gate timeout after ${result.elapsed}s — last body ${JSON.stringify(result.lastBody ?? null)}`);
      park(journal, 'manual_intervention_required', `health gate timeout after ${result.elapsed}s`);
      await saveJournal(journalPath, journal);
      console.error(`health-gate-timeout after ${result.elapsed}s — journal parked, re-run to resume`);
      process.exit(4);
    }
    completeStep(journal, 'health_gate', `GET /health 200 commit=${sha} clean=true in ${result.elapsed}s`);
    await saveJournal(journalPath, journal);
  }
  console.log(`provisioned: tenant=${args.tenant} sha=${sha}`);
  process.exit(0);
}

// Deploy executor: wrangler deploy with the provisioner's own token (file → env,
// never echoed), tenant config path from --config. Honest default: P0 has no
// tenant worker config to deploy yet (HQ-2 documented-risk, no virgin account) —
// so the default throws with a plan reference instead of inventing deploy
// mechanics. Tests inject their own deploy (steps.mjs deploy param).
function makeDeployExecutor(args) {
  return async () => {
    const cfg = args.config;
    if (!cfg) {
      throw new Error('no tenant worker config (--config) wired in P0 — deploy executor is injectable; see plan §5 P0 / HQ-2 documented-risk');
    }
    const { execFileSync } = await import('node:child_process');
    const token = readFileSync(args['token-file'], 'utf8').trim();
    const out = execFileSync('npx', ['wrangler', 'deploy', '--config', cfg], {
      env: { ...process.env, CLOUDFLARE_API_TOKEN: token },
      stdio: 'pipe',
    });
    return `wrangler deploy --config ${cfg}: ${String(out).slice(0, 300)}`;
  };
}

main().catch((err) => {
  console.error('internal error:', err?.message ?? err);
  process.exit(1);
});
