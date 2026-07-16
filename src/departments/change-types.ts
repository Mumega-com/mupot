// mupot — CRO apply-bridge change-type allowlist (CRO epic S5b, "close the ONE hole").
//
// GAP THIS CLOSES: the CRO loop (src/loops/cro.ts) senses/proposes/gates a content-
// conversion hypothesis, but nothing turns an APPROVED hypothesis into a real content
// write. The apply leg needs a governance anchor BEFORE it touches the executor: which
// kinds of change may an agent even propose, and which of those still need extra human
// scrutiny once approved. This file is that anchor — a single, allowlist (never denylist),
// fail-closed classification shared by the proposer (collectors/cro-apply.ts, which must
// refuse a bad change-type BEFORE any gate record is minted) and the executor
// (executors/inkwell.ts, which re-validates at the write sink — "a safety flag the
// producer sets and the server never re-checks is defensive theater; enforce invariants
// at the SINK, not just the producer" — the exact lesson mupot commit 10846b4 (Flight 2
// slice 1) drew from the adversarial gate on this same content-write surface).
//
// THREE TIERS (Hadi/brief, CRO apply-bridge S5b):
//   AUTO-PROPOSABLE   — an agent may propose these unattended; a human STILL approves via
//                        /approvals before anything writes (the gate is never bypassed —
//                        see kernel.ts's fail-closed executor.execute()). Low blast-radius,
//                        narrowly-scoped field edits.
//   FLAGGED           — an agent may propose these, but the stored payload carries an
//                        explicit human-review flag (see collectors/cro-apply.ts) so
//                        whatever renders the /approvals record surfaces the elevated risk
//                        (a bigger edit — the whole visible headline or the whole article
//                        body) rather than looking like a routine meta tweak.
//   HARD-REFUSED      — refused BEFORE any gate record is created (SeoMetaFixProposeError-
//                        style refusal, mirrored here as CroApplyProposeError). These are
//                        levers this slice does not touch at all: layout/forms/offer/
//                        pricing/brand_voice change the product or the deal, not the copy
//                        around it — a CRO content loop has no business touching them.
//   UNRECOGNIZED      — anything not explicitly listed in AUTO or FLAGGED is refused by
//                        construction (allowlist, not denylist — a new/typo'd change-type
//                        fails closed instead of silently falling through to "allowed").
//
// SCHEMA NOTE (read before adding a change-type): Inkwell's content schema
// (mumega.com src/content.config.ts blog collection) has exactly ONE `title` field and
// ONE `description` field — there is no separate meta-title/OG-title distinct from the
// on-page headline, and no distinct meta-description. This forces two deliberate,
// DOCUMENTED collisions in executors/inkwell.ts's field mapping:
//   - meta_title and headline BOTH target the `title` field. They are governed
//     differently (meta_title=auto, a small SEO-copy polish; headline=flagged, a
//     substantive on-page-headline rewrite) because the VALUE a caller sends differs in
//     scope, not because Inkwell stores them separately. A future slice that adds a real
//     distinct meta/OG-title field to the schema should split this properly.
//   - cta_text and internal_links both target a substring WITHIN the `content` (body)
//     field via an exact find/replace (there is no separate CTA or internal-links field
//     either) — see mergeContentUpdate's ambiguous-target refusal in executors/inkwell.ts.

export type CroChangeType =
  | 'meta_title'
  | 'meta_description'
  | 'cta_text'
  | 'internal_links'
  | 'body_copy'
  | 'headline'

/** Agent may propose unattended; still human-gated before write (never auto-published). */
export const AUTO_PROPOSABLE_CHANGE_TYPES: readonly CroChangeType[] = Object.freeze([
  'meta_title',
  'meta_description',
  'cta_text',
  'internal_links',
])

/** Agent may propose; the stored payload is flagged for elevated human-review attention. */
export const FLAGGED_CHANGE_TYPES: readonly CroChangeType[] = Object.freeze(['body_copy', 'headline'])

/**
 * Documented for tests/readability only — NOT the enforcement mechanism. Enforcement is
 * allowlist-based (classifyChangeType refuses anything not in the two arrays above); this
 * list exists so a reviewer can see the change-types the brief explicitly named as
 * destructive/out-of-scope, without it being possible to "forget" one off a denylist and
 * accidentally allow it through.
 */
export const HARD_REFUSED_CHANGE_TYPES: readonly string[] = Object.freeze([
  'layout',
  'forms',
  'offer',
  'pricing',
  'brand_voice',
])

export type ChangeTypeClassification = 'auto' | 'flagged' | 'refused'

/**
 * Classify an arbitrary (possibly caller-supplied, possibly malformed) change-type
 * string. Fail-closed: anything not explicitly in AUTO_PROPOSABLE_CHANGE_TYPES or
 * FLAGGED_CHANGE_TYPES classifies as 'refused' — this covers HARD_REFUSED_CHANGE_TYPES,
 * any future/unknown type, and non-string input alike. There is no branch that can return
 * 'auto' or 'flagged' for an unlisted value.
 */
export function classifyChangeType(value: unknown): ChangeTypeClassification {
  if (typeof value !== 'string') return 'refused'
  if ((AUTO_PROPOSABLE_CHANGE_TYPES as readonly string[]).includes(value)) return 'auto'
  if ((FLAGGED_CHANGE_TYPES as readonly string[]).includes(value)) return 'flagged'
  return 'refused'
}

/** Type guard companion to classifyChangeType — narrows to CroChangeType when not refused. */
export function isKnownChangeType(value: unknown): value is CroChangeType {
  return classifyChangeType(value) !== 'refused'
}
