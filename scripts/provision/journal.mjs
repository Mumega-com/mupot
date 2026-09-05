// Provisioning journal — P0 core (flight/zero-install-p0-provision-core)
//
// Contract: plan doc §4 (dual-signed 2026-09-04). Verbatim invariants:
//   - Local file, 0600, NO secrets (token PATHS only; never values).
//   - Outside D1 — `d1_migrations` remains the durable migration ledger; stock
//     `wrangler d1 migrations apply` is the only applier (never re-invented here).
//   - Journal pins BOTH git SHA and migrations/ dir hash.
//   - steps[].attempt increments per try; named cap reached → park (no infinite resume).
//   - `next` is DERIVED (first not-ok step), never hand-set.
//   - parked_state enum includes "awaiting_r2_activation".
//   - T5 law: every step's ok is confirmed by a READ-BACK (evidence carries the
//     read-back proof); exit codes never substitute for verification.
//
// Tenant clamp lives in provision.mjs (fail-closed, exit 5) — journal only records.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const PARKED_STATES = Object.freeze([
  'awaiting_r2_activation',
  'attempt_cap_parked',
  'manual_intervention_required',
]);

export const DEFAULT_ATTEMPT_CAP = 3;

// ── create / load ────────────────────────────────────────────────────────────

export function newJournal({ tenant, cfAccountId, sha, migrationsHash, tokenFilePath }) {
  if (!tenant || typeof tenant !== 'string') throw new Error('journal: tenant required');
  if (!cfAccountId || typeof cfAccountId !== 'string') throw new Error('journal: cf_account_id required');
  if (!sha || typeof sha !== 'string') throw new Error('journal: sha (pinned git SHA) required');
  if (!migrationsHash || typeof migrationsHash !== 'string') throw new Error('journal: migrations_hash required');
  const now = new Date().toISOString();
  return {
    version: 1,
    tenant,
    cf_account_id: cfAccountId,
    token_file_path: tokenFilePath ?? null, // PATH only — never the token value
    started_at: now,
    updated_at: now,
    pinned_sha: sha,
    migrations_hash: migrationsHash,
    parked_state: null,
    parked_detail: null,
    steps: [],
  };
}

export function loadJournal(pathname) {
  let raw;
  try {
    raw = readFileSync(pathname, 'utf8');
  } catch {
    return null; // no journal yet — fresh provisioning
  }
  const parsed = JSON.parse(raw);
  if (parsed.version !== 1) throw new Error(`journal: unsupported version ${parsed.version}`);
  return parsed;
}

// Atomic save: tmp file + rename, mode 0600 (plan §4: local file, 0600).
export async function saveJournal(pathname, journal, { fs } = {}) {
  const fsp = (fs ?? await import('node:fs')).promises;
  const payload = { ...journal, updated_at: new Date().toISOString() };
  const tmp = `${pathname}.tmp-${randomUUID()}`;
  await fsp.writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  await fsp.rename(tmp, pathname);
  return payload;
}

// ── step lifecycle ───────────────────────────────────────────────────────────

export function beginStep(journal, id) {
  let step = journal.steps.find((s) => s.id === id);
  if (!step) {
    step = { id, ok: null, ts: null, evidence: null, attempt: 0 };
    journal.steps.push(step);
  }
  if (step.ok === true) return step; // verify-not-redo: completed steps are never re-begun
  step.attempt += 1;
  step.ts = new Date().toISOString();
  journal.parked_state = null; // resuming clears any park
  journal.parked_detail = null;
  return step;
}

export function completeStep(journal, id, evidence) {
  const step = journal.steps.find((s) => s.id === id);
  if (!step) throw new Error(`journal: completeStep on unknown step ${id}`);
  if (!evidence || typeof evidence !== 'string') {
    throw new Error('journal: completeStep requires read-back evidence (T5 law — exit codes never substitute)');
  }
  step.ok = true;
  step.ts = new Date().toISOString();
  step.evidence = evidence;
}

export function failStep(journal, id, evidence) {
  const step = journal.steps.find((s) => s.id === id);
  if (!step) throw new Error(`journal: failStep on unknown step ${id}`);
  step.ok = false;
  step.ts = new Date().toISOString();
  step.evidence = evidence ?? null;
}

// ── parking / caps ───────────────────────────────────────────────────────────

export function park(journal, state, detail) {
  if (!PARKED_STATES.includes(state)) throw new Error(`journal: unknown parked_state ${state}`);
  journal.parked_state = state;
  journal.parked_detail = detail ?? null;
}

// Cap check AFTER a failure: attempt >= cap → park with a named state.
export function checkAttemptCap(journal, id, cap = DEFAULT_ATTEMPT_CAP) {
  const step = journal.steps.find((s) => s.id === id);
  if (step && step.ok === false && step.attempt >= cap) {
    park(journal, 'attempt_cap_parked', `step ${id} hit attempt cap ${cap}`);
    return true;
  }
  return false;
}

// ── derived cursor ───────────────────────────────────────────────────────────

// `next` is ALWAYS derived: first step without ok:true. Never hand-set.
export function deriveNext(journal) {
  const pending = journal.steps.find((s) => s.ok !== true);
  return pending ? pending.id : null; // null ⇒ all steps complete
}
