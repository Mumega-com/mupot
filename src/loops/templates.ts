// mupot — addon-declared Loop templates (#471).
//
// An addon manifest's `loops[]` names a templateKey (e.g. 'website-opportunity-review')
// but carries no LoopSpec itself — the manifest is a DECLARATION, not an implementation.
// The spec (kpi/sources/gate/budget/cadence/stop) is a pure function of the template +
// the owning installation, resolved here. This is the loops-side half of the seam;
// src/addons/service.ts's ensureLoopClaim() is the addons-side half that calls
// getLoopTemplate() and writes the resulting spec as a `loops` row.
//
// Mirrors src/departments/registry.ts's register()/getRegistered() discipline (data-
// driven catalogue, duplicate key throws) without departments' DB-side activate() —
// a loop template is a PURE factory; the write lives in addons/service.ts, keyed by
// the ownership claim that reserves the loop's id first (replay-safety is enforced
// there, not here).
//
// A template MUST declare `kind` as one of the existing LoopKind values — the driver
// (src/loops/driver.ts loopRuntimeConfig) dispatches reason/KPI wiring ONLY on `kind`,
// never on templateKey. Adding a template here never requires a new LoopKind; it reuses
// whichever kind's reason/KPI factory already exists (cro.ts, outreach.ts, ...).

import type { LoopSpec } from './manifest'

export interface LoopTemplateContext {
  /** The addon installation this loop belongs to. */
  installationId: string
  addonKey: string
}

export type LoopTemplateFactory = (ctx: LoopTemplateContext) => LoopSpec

const _templates = new Map<string, LoopTemplateFactory>()

/**
 * registerLoopTemplate — an addon module calls this once at import time (mirrors
 * registerAddon / registerAddonConsoleRenderer's self-registration convention). Throws
 * on a duplicate key so two addons can never silently clobber each other's template.
 */
export function registerLoopTemplate(key: string, factory: LoopTemplateFactory): void {
  if (_templates.has(key)) {
    throw new Error(`[loop_template_duplicate_key] Loop template '${key}' is already registered.`)
  }
  _templates.set(key, factory)
}

export function getLoopTemplate(key: string): LoopTemplateFactory | undefined {
  return _templates.get(key)
}

// ── website-opportunity-review (marketing-cro-monitor's loop) ──────────────────────
//
// kind:'cro' reuses the EXISTING reason+KPI wiring (src/loops/cro.ts, dispatched by
// src/loops/driver.ts's loopRuntimeConfig) — no new LoopKind invented for this addon.
//
// Owner: agent_id is a SYNTHETIC identifier (`addon:<installationId>`), not a minted
// squad/agent row. Minting a real squad here would run createSquad's plan-tier
// maxSquads gate (src/org/service.ts checkCreateLimit) INSIDE addon activation —
// coupling a marketing addon's activation to the tenant's squad quota, for a
// machine-owned system loop that is not a human work-unit. `loops.agent_id` carries no
// FK (migrations/0014_loops.sql), so a synthetic id validates cleanly; the
// addon_resource_ownership claim (not agent_id) is the authoritative, queryable link
// back to the owning installation.
//
// kpi.signal 'avg_conversion_bps' matches the metric_key convention documented in
// cro.ts's defaultReadSignal (a trailing-window basis-points average). target=500
// (5.00%) is a reasonable starting floor for a first-run pot; retuning it is a normal
// loop-lifecycle action (PATCH /api/loops/:id/status or MCP loop_set_status) once the
// loop is promoted out of 'paused' — promotion is explicit and org-admin gated
// (see docs/playbooks/marketing-loop-promote.md). Never auto-activate on addon install.
export function websiteOpportunityReviewTemplate(ctx: LoopTemplateContext): LoopSpec {
  return {
    kind: 'cro',
    squad_id: null,
    agent_id: `addon:${ctx.installationId}`,
    okr: 'Improve on-site conversion via a monitored, human-gated CRO review loop',
    kpi: { signal: 'avg_conversion_bps', target: 500 },
    // Built-in 'memory' source: a safe, always-valid placeholder. Wiring this loop's
    // sources to the addon's real first-party CRO connector (src/cro/first-party.ts)
    // is a separate, tracked concern (docs/cro-system-epic.md's S5b apply-bridge) — the
    // loop stays 'paused' until that wiring + an explicit promotion happen, so an
    // inert source here has no behavioral effect yet.
    sources: [{ kind: 'memory', name: 'cro-pages' }],
    channels: [], // the proposed act is CONTENT-kind (gated review task), not a channel send
    gate: { require_approval: true }, // approvalRequired:true — never auto-approved
    budget: { cap_micro_usd: null, window: 'week', effort: 'standard' },
    cadence: { heartbeat: true },
    stop: { dry_rounds_max: 10 },
  }
}
