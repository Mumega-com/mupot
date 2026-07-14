// mupot — SEO/Content channel: seo-meta-fix proposer (Flight 2 slice 1).
//
// GAP THIS CLOSES: SeoChannel (channels/seo-channel.ts) declares seo-meta-fix as an
// executable (proposesOnly=false) work-type with a real propose→approve→execute
// path — but nothing in the codebase ever called ctx.gate.propose({ action:
// 'seo-meta-fix', ... }) with a real, well-formed payload. kernel.ts's executor
// dispatch (the 'inkwell-content' branch) is already real and already proven
// end-to-end for content-publish (Flight 1, commit 872a668/cdf1d5e) — it writes
// through inkwellContentWrite whenever handle.executorEnv.inkwell is configured
// and the stored record's payload carries executor:'inkwell-content'. seo-meta-fix
// was proposing+approving into a payload shape that either had no executor hint
// at all (→ executor_not_wired, adapter:'unknown') or, if a caller happened to set
// executor:'inkwell-content' by hand, lacked the slug+overwrite semantics an
// update-existing-item action requires (see toMetaFixPublishBody, executors/
// inkwell.ts) — so it never wrote for real. This file is the missing producer.
//
// WHY NO KERNEL.TS CHANGE (design note per the Flight 2 slice 1 brief — "wire a
// seo-meta-fix executorHint branch in kernel.ts OR map seo-meta-fix's payload to
// the inkwell-content adapter with overwrite semantics, pick the cleaner one"):
//
//   kernel.ts's executor.execute() dispatch is intentionally domain/action-
//   agnostic — it reads ONLY the stored record's `executor` hint (payload.executor:
//   'inkwell-content' | 'mcpwp'), never the action string (kernel.ts "ADAPTERS"
//   comment, ctx.ts CONTENT-BOUND EXECUTION doc). Branching kernel.ts on
//   record.action === 'seo-meta-fix' would (a) blur that domain-agnostic, unit-
//   tested dispatch contract with SEO-specific business rules, and (b) break the
//   existing generic-dispatch test suites (tests/executor-inkwell-s4.test.ts,
//   tests/executor-mcpwp-s4.test.ts, tests/channel-seo-s4.test.ts) which
//   legitimately use the STRING 'seo-meta-fix' as an arbitrary already-declared
//   action label to exercise the kernel's payload.executor-driven contract,
//   independent of any meta-fix-specific semantics (several of those tests
//   propose action:'seo-meta-fix' with executor:'mcpwp' and no slug, and assert
//   executed:true — real, intentional, pre-existing coverage this file must not
//   regress).
//
//   Instead, seo-meta-fix's invariants — a mandatory target slug, and overwrite
//   ALWAYS true, never a create — are enforced ONCE, structurally, at the only
//   site in the codebase that is allowed to mint a seo-meta-fix gate record: this
//   function (proposeSeoMetaFix). By the time executor.execute() runs, the stored
//   payload is already known-good: kernel.ts's BLOCK-2 content-binding guarantees
//   the payload dispatched is exactly the payload that was proposed (never
//   caller-substituted at execute time), so the EXISTING, UNCHANGED
//   'inkwell-content' branch in kernel.ts (the same inkwellContentWrite call that
//   powers content-publish) writes it correctly with zero new kernel code. This is
//   "map seo-meta-fix's payload to the inkwell-content adapter with overwrite
//   semantics" — the cleaner of the two options the brief offered.
//
// SCOPE (Flight 2 slice 1): only 'inkwell-content' performs a real write here.
// 'mcpwp' (WordPress) has no update-by-slug REST surface yet — wp-json/wp/v2/posts
// POST always creates a new post; updating an existing one needs its numeric post
// ID (a slug→id GET lookup this slice does not build). Proposing a seo-meta-fix
// with executor:'mcpwp' still creates a real, valid gated record (WordpressChannel
// declares the same work-type — see channels/wordpress-channel.ts), and at execute
// time the kernel's generic 'mcpwp' branch will still fire wpContentWrite — but
// today that call always CREATES a new WP post rather than fixing the existing
// one's meta, which is the wrong result for this action. This function therefore
// defaults executor to 'inkwell-content' and callers must pass executor:'mcpwp'
// explicitly and knowingly; a follow-up slice should either wire a real WP
// update-by-slug adapter or have this producer refuse mcpwp outright.

import { kernelMintCtx, getRegistered } from '../registry'
import type { KernelHandle } from '../ctx'
import type { Capability } from '../../types'
import { toMetaFixPublishBody } from '../executors/inkwell'
// Import GrowthModule to trigger auto-registration on module load — same pattern
// as seo-collector.ts / growth-collector.ts. Do NOT pass this directly to
// kernelMintCtx; the registry's frozen clone is the authority source (below).
import { GrowthModule as _GrowthModuleForRegistration } from '../modules/growth'
void _GrowthModuleForRegistration

// ── SeoMetaFixIntent ─────────────────────────────────────────────────────────
//
// The meta-fix data an SEO audit (human or agent-drafted, always human-approved
// before it writes anything — S4 invariant) wants applied to an EXISTING content
// item, identified by slug.

export interface SeoMetaFixIntent {
  /** The EXISTING content item's slug this fix targets. Required — no create-new. */
  slug: string
  /**
   * Title to write. Inkwell's internal publish endpoint requires a non-empty
   * title on every write (workers/inkwell-api/src/routes/internal-content.ts) —
   * pass the corrected title even if only description/tags changed.
   */
  title: string
  /**
   * Body content to write. The internal publish endpoint has no partial-update
   * surface (it always requires + writes full content) — pass the CURRENT body
   * unchanged if this is a meta-only fix, or the updated body if content changed
   * too. This producer cannot safely fetch "current content" itself: that would
   * be a second, unaudited external read at propose time, outside what a human
   * reviewer sees in the /approvals payload. The caller (the SEO audit process,
   * which read the article to compute better meta in the first place) already
   * has this value.
   */
  content: string
  /** New meta description (answer-engine/GEO copy). Optional. */
  description?: string
  /** New tag set. Optional. */
  tags?: string[]
  /**
   * Which CMS this pot publishes through. Defaults 'inkwell-content' — the only
   * adapter with real update-by-slug semantics this slice (see SCOPE note above).
   */
  executor?: 'inkwell-content' | 'mcpwp'
}

export class SeoMetaFixProposeError extends Error {
  constructor(
    public readonly reason: string,
    message?: string,
  ) {
    super(message ?? reason)
    this.name = 'SeoMetaFixProposeError'
  }
}

/**
 * Propose a gated seo-meta-fix action. FAIL-CLOSED: throws
 * SeoMetaFixProposeError('invalid_meta_fix_intent') BEFORE ever calling
 * ctx.gate.propose() when the intent does not map to a valid, slug-bound,
 * overwrite-forced publish body (toMetaFixPublishBody, executors/inkwell.ts) — a
 * malformed intent never reaches the gate store, so a human is never asked to
 * approve something structurally guaranteed to fail (or worse, silently create a
 * new item) at execute time.
 *
 * NO WRITE HAPPENS HERE. This only records intent (ctx.gate.propose) — same as
 * every other proposer in this codebase (seo-collector.ts, agents/execute.ts
 * finishContentProposal). The real write happens later, once a human approves via
 * /approvals and something (the dashboard's execute route, or a future automation)
 * calls ctx.executor.execute(gateId) — the exact rail Flight 1 proved.
 */
export async function proposeSeoMetaFix(
  handle: KernelHandle,
  tenantId: string,
  intent: SeoMetaFixIntent,
  opts?: {
    /** Capability floor to mint the ctx with. seo-meta-fix requires 'lead' — see
     *  channels/seo-channel.ts requiredCapability. Defaults ['lead']. */
    capabilities?: Capability[]
    idGen?: () => string
    now?: () => string
  },
): Promise<{ gateId: string }> {
  const executor = intent.executor ?? 'inkwell-content'
  const payload = {
    executor,
    slug: intent.slug,
    title: intent.title,
    content: intent.content,
    description: intent.description,
    tags: intent.tags,
    // ALWAYS true — seo-meta-fix is definitionally an update to an EXISTING item.
    // Not sourced from `intent` — nothing this function's caller can pass flips
    // this off. Forced here, once, structurally (see file header WHY NO KERNEL.TS
    // CHANGE note): by construction, this is the only site that can ever produce
    // a seo-meta-fix gate record, so every such record carries overwrite:true.
    overwrite: true,
    // Defence-in-depth: the Inkwell internal endpoint server-forces draft
    // regardless (workers/inkwell-api/src/routes/internal-content.ts), but this
    // proposal is explicit about it too — nothing here ever asks for 'published'.
    status: 'draft' as const,
  }

  // Fail-closed validation BEFORE propose — reuses the SAME contract the executor
  // enforces at write time (toMetaFixPublishBody), so an intent that would fail
  // at execute() never gets a gate record at all.
  if (!toMetaFixPublishBody(payload)) {
    throw new SeoMetaFixProposeError(
      'invalid_meta_fix_intent',
      'seo-meta-fix requires a non-empty slug, title, and content',
    )
  }

  const frozenModule = getRegistered('growth')
  if (!frozenModule) {
    throw new SeoMetaFixProposeError(
      'department_not_registered',
      '[seo_meta_fix] GrowthModule is not registered — cannot mint ctx',
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

  const proposal = await ctx.gate.propose({ action: 'seo-meta-fix', payload })
  return { gateId: proposal.gateId }
}
