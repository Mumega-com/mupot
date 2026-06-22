// mupot — goal-loop decision deduplication (S2 sane-brain anti-spam spine).
//
// computeDecisionFp: produces a stable SHA-256 hex fingerprint over a canonical,
// deterministically-serialised preimage that covers:
//   - SENSORIUM_VERSION  (bump invalidates ALL stale dedup records → clean slate)
//   - agent.id           (fingerprint is per-agent, cannot collide across agents)
//   - salient sensorium projection: kpi_progress, schedule.counts.open, schedule.overdue
//   - normalised proposal set: sorted titles
//
// Same (state + proposals) → same fp.  A SENSORIUM_VERSION bump → different fp.
//
// reserveDecision: single-statement INSERT ... ON CONFLICT DO NOTHING.
//   meta.changes === 1 → reservation won   → reserved: true  (caller proceeds)
//   meta.changes === 0 → already reserved  → reserved: false (caller returns 'deduped')
//
// This is the Codex condition: check + reserve are atomic — the INSERT is the
// commit point, not a separate SELECT.

import type { Sensorium } from './sensorium'
import type { Env, Agent } from '../types'

// ── Proposal shape (minimal — we only hash titles) ────────────────────────────

export interface FpProposal {
  title: string
}

// ── computeDecisionFp ─────────────────────────────────────────────────────────

/**
 * Compute a stable SHA-256 hex fingerprint for a goal-cycle tick.
 *
 * Preimage (deterministically serialised, no key-insertion-order ambiguity):
 *   version   SENSORIUM_VERSION constant
 *   agent     agent.id
 *   kpi       sensorium.vitals.kpi_progress (number, JSON-safe)
 *   open      sensorium.schedule.counts.open (number)
 *   overdue   sensorium.schedule.overdue (number)
 *   proposals sorted proposal titles (alphabetical; model output order is non-deterministic)
 *
 * Determinism guarantee: `crypto.subtle.digest` (Web Crypto) is spec-defined and
 * produces a fixed-width byte sequence for a fixed byte input. JSON.stringify of a
 * fixed-shape object with only number/string primitives and no undefined values is
 * stable across V8 (key insertion order preserved, no optional fields).
 */
export async function computeDecisionFp(
  agent: Agent,
  sensorium: Sensorium,
  proposals: FpProposal[],
): Promise<string> {
  // Sorted titles — remove order ambiguity from model output.
  const sortedTitles = proposals.map((p) => p.title).sort()

  // Canonical preimage object — explicit key list, no spreading, no optionals.
  // Use sensorium.version (the runtime value carried BY the sensorium) so that a
  // SENSORIUM_VERSION bump produces a different fp for otherwise-identical state.
  const preimage = {
    version: sensorium.version,
    agent: agent.id,
    kpi: sensorium.vitals.kpi_progress,
    open: sensorium.schedule.counts.open,
    overdue: sensorium.schedule.overdue,
    proposals: sortedTitles,
  }

  const raw = JSON.stringify(preimage)
  const encoded = new TextEncoder().encode(raw)
  const hashBuf = await crypto.subtle.digest('SHA-256', encoded)
  return bufToHex(hashBuf)
}

// ── reserveDecision ───────────────────────────────────────────────────────────

export interface ReserveResult {
  /** true only if the row was actually inserted (meta.changes === 1). */
  reserved: boolean
}

/**
 * Attempt to atomically reserve a decision fingerprint for (tenant, agentId).
 *
 * Uses a single INSERT ... ON CONFLICT(tenant, agent_id, decision_fp) DO NOTHING.
 * D1 sets meta.changes to 1 on insert and 0 on conflict — no separate SELECT needed.
 *
 * Tenant isolation: the (tenant, agent_id, decision_fp) unique constraint means
 * the same fp from different tenants creates two independent rows — never conflicts.
 *
 * Throws on unexpected DB errors (caller should treat as a cycle error, not deduped).
 */
export async function reserveDecision(
  env: Env,
  tenant: string,
  agentId: string,
  fp: string,
): Promise<ReserveResult> {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  const result = await env.DB.prepare(
    `INSERT INTO loop_decisions (id, tenant, agent_id, decision_fp, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tenant, agent_id, decision_fp) DO NOTHING`,
  )
    .bind(id, tenant, agentId, fp, now)
    .run()

  // D1 result: meta.changes is 1 when a row was inserted, 0 on conflict (DO NOTHING).
  const changes = result.meta?.changes ?? 0
  return { reserved: changes === 1 }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
