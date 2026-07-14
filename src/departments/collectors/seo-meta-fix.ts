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
// executor:'inkwell-content' by hand, lacked the slug semantics an update-existing
// -item action requires (see toMetaFixPublishBody, executors/inkwell.ts) — so it
// never wrote for real. This file is the missing producer.
//
// ⚠ REAL SINK CONTRACT (read before touching `overwrite` anywhere in this file):
// the Inkwell internal endpoint (workers/inkwell-api/src/routes/internal-content.ts
// → lib/tenant-content.ts putContent()) performs an UNCONDITIONAL full replace of
// (tenant, slug) — an unguarded `kv.put(post:slug, markdown)` plus
// `INSERT OR REPLACE INTO content_index`. It never reads a body.overwrite field.
// There is no partial update and no create-vs-update distinction at the sink. The
// `overwrite: true` this producer sets is advisory/inert server-side — it exists so
// the STORED payload documents the caller's intent (an update, never a create) for
// anyone reading the record later, and so toMetaFixPublishBody's own local
// slug-required check has a stable shape to validate. It grants ZERO protection at
// write time; do not describe it, comment it, or test it as if it did.
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
//   Instead, seo-meta-fix's invariants — a mandatory target slug, and a payload
//   shape that always documents "this is an update, never a create" — are
//   enforced ONCE, structurally, at the only site in the codebase that is allowed
//   to mint a seo-meta-fix gate record: this function (proposeSeoMetaFix). By the
//   time executor.execute() runs, the stored payload is already known-good:
//   kernel.ts's BLOCK-2 content-binding guarantees the payload dispatched is
//   exactly the payload that was proposed (never caller-substituted at execute
//   time), so the EXISTING, UNCHANGED 'inkwell-content' branch in kernel.ts (the
//   same inkwellContentWrite call that powers content-publish) writes it correctly
//   with zero new kernel code. This is "map seo-meta-fix's payload to the
//   inkwell-content adapter" — the cleaner of the two options the brief offered.
//   (The payload's `overwrite` field does NOT do this enforcement — see the ⚠ REAL
//   SINK CONTRACT note above. The real invariant this function enforces is
//   requiring `slug`, which fail-closed-refuses a malformed intent before any gate
//   record is minted.)
//
// SCOPE (Flight 2 slice 1): only 'inkwell-content' performs a real write here.
// 'mcpwp' (WordPress) has no update-by-slug REST surface yet — wp-json/wp/v2/posts
// POST always creates a new post; updating an existing one needs its numeric post
// ID (a slug→id GET lookup this slice does not build). A seo-meta-fix executed
// against 'mcpwp' can therefore only ever produce a known-wrong result: a
// duplicate CREATE instead of a meta fix on the existing post. Minting a
// human-approvable gate record whose only possible execute outcome is wrong is
// itself a defect — the producer, not just the executor, must refuse. This
// function HARD-REFUSES executor:'mcpwp' (SeoMetaFixProposeError
// 'mcpwp_unsupported') before any gate record is created; only 'inkwell-content'
// is accepted. A future slice may wire a real WP update-by-slug adapter and lift
// this refusal — until then, WordPress meta-fixes must go through some other,
// correct path (e.g. a direct MCPWP call by a human), not this producer.

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
//
// ⚠⚠ DESTRUCTIVE SEMANTICS — READ BEFORE CALLING proposeSeoMetaFix ⚠⚠
//
//   1. FULL-BODY REPLACE, NOT A PATCH. The sink (Inkwell's internal publish
//      endpoint) has no partial-update surface: whatever `content` this intent
//      carries becomes the ENTIRE article body, unconditionally. There is no
//      diff, no merge, no "only change the meta fields." If the caller resends a
//      stale or truncated copy of the article (a caching bug, a short-circuited
//      fetch, a bad string slice), that stale/truncated text SILENTLY DESTROYS
//      the real, current body — no confirmation, no partial-write fallback.
//   2. PUBLISHED → DRAFT DEMOTION. The pot-scoped internal endpoint force-sets
//      status='draft' on every write, unconditionally. A "meta-only" fix applied
//      to a PUBLISHED article will demote it to draft as a side effect — it drops
//      off the live site until someone re-publishes it. This is true even when
//      the caller's only intent was a title/description/tags tweak.
//   3. NO AUTOMATED TRIGGER. Because of (1) and (2), no cron/agent/automation may
//      call proposeSeoMetaFix without a human in the loop composing the intent —
//      see the BLOCK comment on proposeSeoMetaFix below.

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
   * Body content to write. ⚠ REPLACES THE ENTIRE ARTICLE — see the DESTRUCTIVE
   * SEMANTICS note above. The internal publish endpoint has no partial-update
   * surface (it always requires + writes full content) — pass the CURRENT body
   * unchanged if this is a meta-only fix, or the updated body if content changed
   * too. Passing anything less than the true current body (stale cache, a
   * truncated resend) silently destroys the rest of the article. This producer
   * cannot safely fetch "current content" itself: that would be a second,
   * unaudited external read at propose time, outside what a human reviewer sees
   * in the /approvals payload. The caller (the SEO audit process, which read the
   * article to compute better meta in the first place) already has this value.
   */
  content: string
  /** New meta description (answer-engine/GEO copy). Optional. */
  description?: string
  /** New tag set. Optional. */
  tags?: string[]
  /**
   * Which CMS this pot publishes through. Only 'inkwell-content' is supported —
   * the only adapter with real update-by-slug semantics (see SCOPE note above).
   * Passing 'mcpwp' is a HARD REFUSAL (SeoMetaFixProposeError
   * 'mcpwp_unsupported'): WordPress has no update-by-slug REST surface, so an
   * mcpwp meta-fix can only ever execute as a wrong-result duplicate CREATE.
   * Defaults to 'inkwell-content' when omitted.
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
 * ctx.gate.propose() when the intent does not map to a valid, slug-bound publish
 * body (toMetaFixPublishBody, executors/inkwell.ts) — a malformed intent never
 * reaches the gate store, so a human is never asked to approve something
 * structurally guaranteed to fail at execute time. Also throws
 * SeoMetaFixProposeError('mcpwp_unsupported') when intent.executor === 'mcpwp' —
 * see SeoMetaFixIntent.executor doc and the file-header SCOPE note.
 *
 * ⚠⚠ NO AUTOMATED TRIGGER — BLOCK ⚠⚠
 * Per SeoMetaFixIntent's DESTRUCTIVE SEMANTICS note: this action replaces an
 * article's ENTIRE body and unconditionally demotes a published article to
 * draft. No cron job, no autonomous agent loop, and no scheduled/background
 * caller may invoke this function today. It is HUMAN-INITIATED PROPOSE ONLY:
 * a human (or a human-supervised single action) composes the intent, with the
 * true current body in hand, right before calling this. This restriction stays
 * in place until a fetch-then-merge path (or a content-diff reviewer view that
 * lets the human see exactly what changes vs. what's destroyed) exists — do not
 * lift it by just deleting this comment; build the safeguard first.
 *
 * NO WRITE HAPPENS HERE. This only records intent (ctx.gate.propose) — same as
 * every other proposer in this codebase (seo-collector.ts, agents/execute.ts
 * finishContentProposal). The real write happens later, once a human approves via
 * /approvals and something (the dashboard's execute route, or a future automation)
 * calls ctx.executor.execute(gateId) — the exact rail Flight 1 proved. The stored
 * payload includes a `warning` string precisely so that whatever eventually
 * renders the /approvals record for a human surfaces the full-body-replace +
 * draft-demotion consequence — this must never read like a harmless meta tweak.
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
  // HARD REFUSAL: 'mcpwp' has no update-by-slug REST surface (see file-header
  // SCOPE note) — minting a gate record for it would produce a human-approvable
  // record whose only possible execute outcome is a known-wrong duplicate CREATE.
  // The producer refuses before ever touching the gate store; this is not
  // deferred to execute time.
  if (intent.executor === 'mcpwp') {
    throw new SeoMetaFixProposeError(
      'mcpwp_unsupported',
      'seo-meta-fix does not support executor:mcpwp — WordPress has no update-by-slug REST surface, so it can only execute as a wrong-result duplicate create',
    )
  }

  const executor = intent.executor ?? 'inkwell-content'
  const payload = {
    executor,
    slug: intent.slug,
    title: intent.title,
    content: intent.content,
    description: intent.description,
    tags: intent.tags,
    // Documents caller intent ("this is an update, never a create") for anyone
    // reading the stored record later, and gives toMetaFixPublishBody's slug
    // check a stable shape. Advisory/inert at the sink — see ⚠ REAL SINK
    // CONTRACT note at the top of this file. Not sourced from `intent`; forced
    // here, once, structurally — nothing this function's caller can pass flips
    // it off.
    overwrite: true,
    // The Inkwell internal endpoint server-forces draft regardless (workers/
    // inkwell-api/src/routes/internal-content.ts) — this proposal is explicit
    // about it too so a reviewer never sees a 'published' ask. NOTE: forcing
    // draft here does NOT mean this write is non-destructive on a published
    // article — see the `warning` field below and SeoMetaFixIntent's
    // DESTRUCTIVE SEMANTICS doc: writing this record onto a slug that is
    // currently published WILL demote it to draft.
    status: 'draft' as const,
    // Human-approver-facing warning, carried IN the stored payload so any
    // current or future /approvals rendering of this record surfaces the real
    // consequence rather than a bare field diff. See BLOCK comment above.
    warning:
      'This replaces the ENTIRE body of the target article (no partial update — a stale resend destroys existing content) and, because the write is always draft, will DEMOTE a currently-published article to draft.',
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
