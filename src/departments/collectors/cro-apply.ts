// mupot — CRO apply-bridge proposer (CRO epic S5b, "close the ONE hole").
//
// GAP THIS CLOSES: the CRO loop (src/loops/cro.ts) senses/proposes/gates a content-
// conversion hypothesis, but there was no APPLY leg — an approved CRO hypothesis had
// nowhere real to go. This is the missing producer: it turns an approved CRO change
// intent into a gated 'cro-apply' proposal that dispatches, on human approval, through
// the SAME propose→approve→execute rail Flight 1/2 proved (kernel.ts's executor.execute,
// the 'inkwell-content' branch — now routed through inkwellContentDispatch, executors/
// inkwell.ts) to a FETCH-THEN-MERGE write: read the current article, patch ONLY the
// targeted field, write the merged whole back. Never a full-body replace like
// seo-meta-fix's write path — see executors/inkwell.ts file-header note.
//
// STRUCTURAL TWIN of collectors/seo-meta-fix.ts: same fail-closed-before-gate-store
// discipline, same kernelMintCtx pattern, same "the producer refuses, not the sink,
// for the classification the producer can validate — but the sink ALSO re-validates
// the allowlist (inkwellContentApplyWrite), because a safety check only the producer
// makes is defensive theater the moment anything else can reach the sink directly."
//
// CHANGE-TYPE ALLOWLIST (change-types.ts) — the anchor this file enforces BEFORE ever
// calling ctx.gate.propose():
//   AUTO-PROPOSABLE (meta_title, meta_description, cta_text, internal_links) — proposes
//     normally. Still human-gated before write (proposesOnly=false ≠ auto-execute; see
//     the cro-apply work-type doc in channels/seo-channel.ts).
//   FLAGGED (body_copy, headline) — proposes, but the stored payload carries
//     `flagged: true` + an explicit warning string so whatever renders the /approvals
//     record surfaces the elevated risk (a bigger edit) rather than looking routine.
//   REFUSED (layout, forms, offer, pricing, brand_voice, or anything unrecognized) —
//     CroApplyProposeError('change_type_refused') thrown BEFORE any gate record exists.
//     No human is ever asked to approve something this producer already knows is out
//     of scope for a CRO content loop.
//
// NOTE (scope of this slice): this file provides the PROPOSER + the gated rail to the
// executor — the real, sensitive, previously-missing apply leg. It does not itself
// listen to src/loops/cro.ts's `reason()` output or auto-translate a freeform
// `recommendation` string into a structured { changeType, value, findText } intent —
// that mapping is a product/NLP decision (which words become the new title? which
// substring is the "current CTA" to replace?) that should not be fabricated here. A
// future integration slice wires the loop's approved task to a call into
// proposeCroApply with a real, human-legible intent — this file is the target that
// wiring calls into, tested standalone (mirrors how seo-meta-fix.ts shipped before any
// caller besides tests existed).

import { kernelMintCtx, getRegistered } from '../registry'
import type { KernelHandle } from '../ctx'
import type { Capability } from '../../types'
import { classifyChangeType, type CroChangeType } from '../change-types'
// Import GrowthModule to trigger auto-registration on module load — same pattern
// as seo-meta-fix.ts / seo-collector.ts / growth-collector.ts. Do NOT pass this
// directly to kernelMintCtx; the registry's frozen clone is the authority source
// (below).
import { GrowthModule as _GrowthModuleForRegistration } from '../modules/growth'
void _GrowthModuleForRegistration

/** A human/agent-composed CRO content change targeting ONE field of an existing post. */
export interface CroApplyIntent {
  /** The EXISTING content item's slug this change targets. Required — no create-new. */
  slug: string
  /** Which field/aspect this change touches — validated against the allowlist. */
  changeType: CroChangeType
  /**
   * The new value: for meta_title/headline the new title, for meta_description the
   * new description, for body_copy the new full body, for cta_text/internal_links the
   * REPLACEMENT text (paired with findText below).
   */
  value: string
  /**
   * REQUIRED for changeType 'cta_text' | 'internal_links' only. The exact current
   * substring in the article body to replace — Inkwell's content schema has no
   * separate CTA/internal-links field (see change-types.ts SCHEMA NOTE), so these two
   * change-types target a substring within the body via an exact find/replace. The
   * executor (mergeContentUpdate) fail-closed-refuses if this substring is absent or
   * appears more than once in the current body — never guesses which occurrence.
   */
  findText?: string
}

export class CroApplyProposeError extends Error {
  constructor(
    public readonly reason: string,
    message?: string,
  ) {
    super(message ?? reason)
    this.name = 'CroApplyProposeError'
  }
}

/**
 * Propose a gated 'cro-apply' action. FAIL-CLOSED, in order:
 *   1. classifyChangeType(intent.changeType) === 'refused' → CroApplyProposeError
 *      'change_type_refused' — BEFORE ever calling ctx.gate.propose(). Covers the
 *      hard-refused destructive set (layout/forms/offer/pricing/brand_voice) and any
 *      unrecognized/malformed value (allowlist, not denylist — fail-closed on unknown).
 *   2. A structurally invalid intent (missing slug/value, or a substring change-type
 *      missing findText) → CroApplyProposeError 'invalid_cro_apply_intent' — same
 *      "never gate-store something structurally guaranteed to fail at execute time"
 *      discipline as proposeSeoMetaFix.
 *
 * On success, mints a growth-department ctx and calls ctx.gate.propose({action:
 * 'cro-apply', payload}) — the SAME rail every other S4 executable action uses. NO
 * WRITE HAPPENS HERE. A human still approves via /approvals before
 * ctx.executor.execute(gateId) performs the real fetch-then-merge write
 * (executors/inkwell.ts inkwellContentApplyWrite, dispatched through kernel.ts's
 * inkwellContentDispatch).
 */
export async function proposeCroApply(
  handle: KernelHandle,
  tenantId: string,
  intent: CroApplyIntent,
  opts?: {
    /** Capability floor to mint the ctx with. cro-apply requires 'lead' — see
     *  channels/seo-channel.ts's cro-apply work-type. Defaults ['lead']. */
    capabilities?: Capability[]
    idGen?: () => string
    now?: () => string
  },
): Promise<{ gateId: string; flagged: boolean }> {
  // ── 1. Change-type allowlist — refuse BEFORE touching the gate store ────────
  const classification = classifyChangeType(intent?.changeType)
  if (classification === 'refused') {
    throw new CroApplyProposeError(
      'change_type_refused',
      `cro-apply refuses change-type '${String(intent?.changeType)}' — not on the AUTO_PROPOSABLE or FLAGGED allowlist (see change-types.ts)`,
    )
  }
  const flagged = classification === 'flagged'

  // ── 2. Structural validation — fail-closed before minting a gate record ─────
  const slug = typeof intent.slug === 'string' ? intent.slug.trim() : ''
  const value = typeof intent.value === 'string' ? intent.value : ''
  if (!slug || !value) {
    throw new CroApplyProposeError(
      'invalid_cro_apply_intent',
      'cro-apply requires a non-empty slug and value',
    )
  }
  const needsFindText = intent.changeType === 'cta_text' || intent.changeType === 'internal_links'
  const findText = typeof intent.findText === 'string' && intent.findText ? intent.findText : undefined
  if (needsFindText && !findText) {
    throw new CroApplyProposeError(
      'invalid_cro_apply_intent',
      `cro-apply changeType '${intent.changeType}' requires findText (the current substring to replace)`,
    )
  }

  const payload = {
    executor: 'inkwell-content' as const,
    // Marker the executor dispatch (executors/inkwell.ts inkwellContentDispatch)
    // reads to route to the fetch-then-merge path instead of the full-replace path.
    mode: 'cro-apply-merge' as const,
    slug,
    changeType: intent.changeType,
    value,
    ...(findText ? { findText } : {}),
    // FLAGGED tier surfaces in the stored record so any /approvals rendering shows
    // the elevated-review marker — mirrors seo-meta-fix's `warning` field pattern.
    flagged,
    warning: flagged
      ? `FLAGGED: '${intent.changeType}' is a substantive content change (whole headline or whole body) — review carefully before approving.`
      : `Targeted '${intent.changeType}' change — fetch-then-merge write preserves every other field of the existing post.`,
  }

  const frozenModule = getRegistered('growth')
  if (!frozenModule) {
    throw new CroApplyProposeError(
      'department_not_registered',
      '[cro_apply] GrowthModule is not registered — cannot mint ctx',
    )
  }

  const ctx = kernelMintCtx(handle, {
    tenantId,
    departmentKey: 'growth',
    module: frozenModule,
    capabilities: opts?.capabilities ?? ['lead'],
    now: opts?.now,
    idGen: opts?.idGen,
  })

  const proposal = await ctx.gate.propose({ action: 'cro-apply', payload })
  return { gateId: proposal.gateId, flagged }
}
