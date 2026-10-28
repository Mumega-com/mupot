// src/policy/registry.ts — the Security Bar's rule registry (data, not logic).
//
// Hadi, 2026-10-26: "move the restriction settings to a security bar that can have
// onboarding, operating, under attack". Every restriction a legitimate user can hit is ONE entry
// here: an id, what it blocks, whether it is a FLOOR (a code constant the bar cannot change), the
// value at each level, and the call sites that read it. Later batches add rules as plain data
// entries (see receipts/policy-catalog-20261026.json for the id style: area.verb.what).
//
// VALUES. 'relaxed' means the friction guard is OFF at that level (the action is allowed and a
// record is written); 'strict' means today's refusal. A FLOOR is strict at every level and shows in the
// read view as read-only. Baseline protections (E3, Athena) never turn off at any level: tenant
// isolation, authorization and admission, credential/identity step-up for sensitive actions,
// bounded abuse/rate limits, independent review and evidence binding. They are registered below as
// floors so they are visible, and src/policy/bar.ts refuses to resolve a floor to anything else
// even if this table were edited wrongly (floors are re-asserted at read time).

export const POLICY_LEVELS = ['onboarding', 'operating', 'under_attack'] as const
export type PolicyLevel = (typeof POLICY_LEVELS)[number]

/** Strictness order: a HIGHER rank is stricter. Raising the rank is always allowed for the owner;
 *  lowering it needs the E3 step-up (src/policy/bar.ts). */
export const LEVEL_RANK: Readonly<Record<PolicyLevel, number>> = { onboarding: 0, operating: 1, under_attack: 2 }

export function isPolicyLevel(v: unknown): v is PolicyLevel {
  return typeof v === 'string' && (POLICY_LEVELS as readonly string[]).includes(v)
}

export type PolicyValue = 'relaxed' | 'strict'

export interface PolicyRule {
  /** area.verb.what, e.g. task.create.gate-owner-creator-is-assignee. Unique. */
  readonly id: string
  /** What the guard blocks and who legitimately hits it. */
  readonly description: string
  /** A floor is a code constant the bar cannot change: strict at every level, read-only in the view. */
  readonly floor: boolean
  readonly values: Readonly<Record<PolicyLevel, PolicyValue>>
  /** file:symbol of every place that reads the rule (documentation; tests pin the wired ones). */
  readonly sites: readonly string[]
  /** Refusal codes this rule produces (the CI guard in tests/policy-refusal-guard.test.ts joins on these). */
  readonly refusalCodes?: readonly string[]
  // ── catalog fields (receipts/policy-catalog-20261026.json): carried verbatim so a later batch PR adds a rule as a
  // plain data entry, mostly by pasting the catalog record through catalogRule() below. All optional.
  readonly class?: 'FLOOR' | 'BAR' | 'REMOVE'
  readonly fileLine?: string
  readonly who?: readonly string[]
  readonly threat?: string
  /** The catalog's DESCRIPTIVE per-level proposal (free text). The machine-read values stay in `values`. */
  readonly bar?: { readonly current: string; readonly onboarding: string; readonly operating: string; readonly under_attack: string }
  /** Set when the rule is registered but NOT wired in this PR: points at the PR/issue that owns it. */
  readonly todo?: string
}

const STRICT = { onboarding: 'strict', operating: 'strict', under_attack: 'strict' } as const
const ONBOARDING_ONLY = { onboarding: 'relaxed', operating: 'strict', under_attack: 'strict' } as const

function floor(id: string, description: string, sites: readonly string[], refusalCodes?: readonly string[]): PolicyRule {
  return { id, description, floor: true, values: STRICT, sites, ...(refusalCodes ? { refusalCodes } : {}) }
}

export const POLICY_RULES: readonly PolicyRule[] = [
  floor('approval.bot.processing-failed', 'Approval bot processing failures return a retryable refusal rather than acknowledging an unrecorded operation.', ['src/approval-bot/routes.ts'], ['processing_failed']),
  floor('sudo.owner.claim-release-failed', 'A refused owner-sudo call whose claim cannot be released ends its grant or requires revocation before reapproval.', ['src/auth/owner-sudo.ts', 'src/mcp/index.ts'], ['sudo_claim_release_failed']),
  floor('approval.identity.not-live', 'Approval session minting refuses an identity that is no longer live and asks the human to sign in again.', ['src/access/decision-core.ts', 'src/access/routes.ts'], ['approver_identity_not_live']),
  // ── BAR: the first batch of friction rules, wired in this PR ─────────────────────────────────
  {
    id: 'task.create.gate-owner-creator-is-assignee',
    class: 'BAR', // the catalog lists this as FLOOR; reclassified by Hadi 2026-10-26 (naming an independent lane is allowed, the creator's own lane stays a floor)
    who: ['agent', 'human-non-admin'],
    threat: 'a creator naming itself worker and gate-setter is the self-close shape no-self-review exists to stop',
    fileLine: 'src/mcp/index.ts:toolTaskCreate',
    description:
      'task_create refuses gate_owner whenever creator = assignee. Relaxed: naming a gate lane the creator does NOT hold is allowed; only the creator\'s own lane is still refused (task.create.gate-owner-own-lane).',
    floor: false,
    values: ONBOARDING_ONLY,
    sites: ['src/mcp/index.ts:toolTaskCreate'],
    refusalCodes: ['gate_owner_creator_is_assignee'],
  },
  {
    id: 'task.intake.p1-linkage',
    class: 'BAR',
    who: ['agent', 'human-non-admin'],
    threat: 'priority inflation without a flight/project to answer to',
    fileLine: 'src/tasks/service.ts:assertValidIntakeContract',
    description: 'P1 priority requires project/parent linkage or an "[owner: @x, ttl: 7d]" escape-hatch tag in the body.',
    floor: false,
    values: ONBOARDING_ONLY,
    sites: ['src/tasks/service.ts:assertValidIntakeContract', 'src/mcp/index.ts:toolTaskCreate', 'src/tasks/index.ts:POST /'],
    refusalCodes: ['p1_linkage_required'],
  },
  {
    id: 'task.create.assignee-agent-resolvable.cross-squad',
    description:
      'Assigning an agent whose home squad is not the task\'s squad needs the agent\'s member to hold member on the task squad.',
    class: 'FLOOR',
    floor: true,
    values: STRICT,
    sites: ['src/tasks/assignee.ts:resolveTaskAssignee'],
    refusalCodes: ['assignee_not_in_squad'],
  },
  {
    id: 'task.create.assignee-agent-resolvable.inactive',
    description: 'Assigning a task to a paused/inactive agent is refused.',
    class: 'FLOOR',
    floor: true,
    values: STRICT,
    sites: ['src/tasks/assignee.ts:resolveTaskAssignee'],
  },
  {
    id: 'task.create.assignee-member-resolvable',
    description: 'Assigning a task to a human who holds no member capability on the task squad is refused.',
    class: 'FLOOR',
    floor: true,
    values: STRICT,
    sites: ['src/tasks/assignee.ts:resolveTaskAssigneeMember'],
  },
  {
    id: 'task.update.transition-matrix',
    class: 'BAR', // catalog id; this PR wires only the open -> blocked slice. open -> done and blocked -> open for UNGATED tasks are a later batch under the same id
    who: ['agent', 'human-non-admin'],
    threat: 'none on its own: the gate guards (review, verdict, terminal done) are separate floors',
    fileLine: 'src/tasks/service.ts:checkTransition',
    description: 'The transition matrix refuses open -> blocked. Relaxed: allowed with a non-empty reason; every use is audited. (blocked -> in_progress is already legal and stays so.)',
    floor: false,
    values: ONBOARDING_ONLY,
    sites: ['src/tasks/service.ts:checkTransition', 'src/mcp/index.ts:toolTaskUpdate', 'src/tasks/index.ts:PATCH /:id'],
    refusalCodes: ['invalid_transition', 'transition_reason_required'],
  },
  {
    id: 'task.update.artifact-shape-gate',
    class: 'BAR', // the catalog lists this as FLOOR; reclassified per E2 (Athena): relaxed kinds are explicit, binding unchanged
    who: ['agent'],
    threat: 'prose "I did it" with no work (a5e45082); shape-only, the digest was never verified',
    fileLine: 'src/tasks/artifact-verification.ts:verifyTaskArtifactShape',
    description:
      'A result entering review/done must carry "Artifact: <path>" + "SHA256: <64-hex>". At onboarding only: also accepts a file with a claimed digest, a repository/PR URL with a FULL commit id and repo identity, or a labelled snapshot with an http(s) reference whose digest the SERVER computes. Plain prose is still refused at every level.',
    floor: false,
    values: ONBOARDING_ONLY,
    sites: [
      'src/tasks/evidence.ts:verifyTaskEvidence',
      'src/mcp/index.ts:toolTaskUpdate',
      'src/mcp/index.ts:toolTaskSubmitResult',
      'src/tasks/index.ts:PATCH /:id',
      'src/agents/execute.ts:finishTask',
    ],
    refusalCodes: ['artifact_verification_failed'],
  },

  // ── FLOORS beside the wired rules (visible, read-only) ───────────────────────────────────────
  floor('task.create.gate-owner-own-lane', 'A creator may never name a gate lane it holds itself (the self-close shape no-self-review exists to stop).', ['src/mcp/index.ts:toolTaskCreate']),
  floor('task.assign.cross-tenant', 'A task is never assigned across tenants (one pot = one DB; ids are resolved inside it).', ['src/tasks/assignee.ts']),
  floor('task.assign.agent-not-visible', 'An agent the caller cannot see (no capability on its home squad) can never be assigned.', ['src/tasks/assignee.ts:resolveTaskAssignee']),
  floor('task.assign.invalid-assignee', 'An assignee id that does not exist is refused.', ['src/tasks/assignee.ts'], ['invalid_assignee']),
  floor('task.update.external-assign-admin', 'Assigning externally-sourced (source_pot / external_source) tasks needs admin+: untrusted content must not be self-assigned and executed.', ['src/mcp/index.ts:toolTaskUpdate', 'src/tasks/index.ts:PATCH /:id']),
  floor('task.update.assignee-cannot-mutate-own', 'The current assignee of an in_progress task cannot change the assignee (fake-green launder path).', ['src/tasks/service.ts:assigneeCannotMutateOwnAssignment'], ['assignee_cannot_mutate_own_assignment']),
  floor('members.telegram-unbind.binding-changed', 'A Telegram unbind that loses a race to a concurrent rebind revokes nothing and reports the conflict; it never ends grants against a binding it did not clear (#2100).', ['src/members/index.ts'], ['telegram_binding_changed']),
  floor('task.update.reassign-in-flight-dispatch', 'No reassignment while a dispatch is mid-flight (orphans the receipt).', ['src/mcp/index.ts:toolTaskUpdate'], ['task_dispatch_in_flight']),
  floor('task.update.assignee-frozen-in-review', 'The assignee of a task in review is frozen (verdict independence keys on it).', ['src/tasks/service.ts:assigneeChangesInReview'], ['assignee_frozen_in_review']),
  floor('task.create.single-assignee', 'A task has one owner: agent or member, never both.', ['src/mcp/index.ts', 'src/tasks/index.ts'], ['task_single_assignee']),
  floor('task.status.review-exit-via-verdict', 'review exits only through the verdict path; PATCH never moves review -> approved/rejected.', ['src/tasks/service.ts:checkTransition']),
  floor('task.status.gated-no-direct-done', 'A task with a gate_owner reaches done only after the verdict (no PATCH-to-done).', ['src/tasks/service.ts:patchToDoneBypassesGate']),
  floor('task.status.done-terminal', 'done has no outbound transitions.', ['src/tasks/service.ts:checkTransition']),
  floor('task.update.gate-required-for-review', 'A task can enter review only with a gate_owner (no zombie review).', ['src/mcp/index.ts:toolTaskUpdate'], ['gate_required_for_review']),
  floor('task.update.assignee-self-close', 'The assignee cannot mark its own task done.', ['src/tasks/service.ts:assigneeSelfClose'], ['assignee_cannot_self_close']),
  floor('task.evidence.approval-binding', 'Approval stays bound to the exact submission id and digest at every level; relaxed evidence kinds change what is ACCEPTED, never what is bound.', ['src/tasks/service.ts:writeVerdict']),
  floor('task.artifact.placeholder-evidence', 'Placeholder, refusal-prose and disallowed-path evidence is refused at every level; plain prose is never evidence.', ['src/tasks/evidence.ts']),

  // ── baseline FLOORS (E3): never off at any level ─────────────────────────────────────────────
  floor('board.webhook.handler-success', 'A failed board webhook handler returns a retryable error and releases the delivery claim.', ['src/integrations/board-webhook-routes.ts'], ['handler_failed']),
  floor('tenant.isolation', 'Tenant scoping on every read and write.', ['src/**']),
  floor('authz.admission', 'Authorization and admission checks (capability, rank ceilings, verified identity).', ['src/auth/capability.ts', 'src/admission/**']),
  floor('identity.step-up-sensitive', 'Credential and identity step-up for sensitive actions (passkey/device enrolment, link-signin, operator creation, token mint/rotation).', ['src/secure-moments/enrol-mint.ts', 'src/auth/index.ts']),
  floor('abuse.rate-limits', 'Bounded abuse/rate limits (signup, seat caps, meter caps).', ['src/mcp/oauth-authorize.ts', 'src/members/bootstrap-self.ts', 'src/agents/meter.ts']),
  floor('review.independent-gate', 'Independent review: an agent never approves its own work.', ['src/tasks/index.ts:evaluateVerdictGates']),
  floor('bar.owner-only-write', 'Only the org owner can write the bar. Agents and ordinary members never can.', ['src/policy/bar.ts', 'src/dashboard/security-bar.ts', 'src/mcp/security-bar.ts']),
  floor('bar.lowering-step-up', 'Lowering the level needs a fresh strong re-auth through a path the bar cannot relax, plus a second owner when one exists (otherwise a delay). No timed auto-downgrade.', ['src/policy/bar.ts:requestLower', 'src/policy/bar.ts:confirmLower']),
  floor('bar.fail-closed', 'A missing/malformed setting or a failed read resolves to the stricter level; request-local caching never leaks across requests.', ['src/policy/bar.ts:resolveLevel']),

  // ── registered, NOT wired here: other builders own these (do not move them onto the bar in this PR) ──
  {
    id: 'verdict.owner-self-approve',
    description: 'D1: an owner may approve their own agent\'s result after both gate lenses pass. Five enforcement sites must move together.',
    floor: false,
    values: { onboarding: 'strict', operating: 'strict', under_attack: 'strict' },
    sites: ['src/tasks/index.ts:evaluateVerdictGates', 'src/tasks/service.ts:writeVerdict', 'src/tasks/verdict-independence.ts', 'src/im/origin-verdict.ts', 'src/tasks/runtime-receipts.ts'],
    todo: 'TODO(D1 builder PR): wire onto the bar when the owner-self-approve PR lands; values here are placeholders (strict) until then.',
  },
  {
    id: 'thread.attach-existing-agent',
    description: 'R1: a new ChatGPT thread may seat_attach to an already-admitted agent with no new human tap (same member, harness, live grant, live admission).',
    floor: false,
    values: { onboarding: 'strict', operating: 'strict', under_attack: 'strict' },
    sites: ['src/members/seat-attach.ts'],
    todo: 'TODO(R1 builder PR): wire onto the bar when the thread-attach PR lands; values here are placeholders (strict) until then.',
  },
  floor('seat.connection-check.attached-only', 'connection_check runs only from an attached chat; an unattached chat is refused with the seat_attach next step.', ['src/mcp/seat-attach.ts:toolConnectionCheck'], ['not_attached']),
]

/** The shape of one record in receipts/policy-catalog-20261026.json. */
export interface CatalogRecord {
  id: string
  file_line: string
  code: string | null
  blocks: string
  who: string[]
  threat: string
  class: 'FLOOR' | 'BAR' | 'REMOVE'
  bar?: { current: string; onboarding: string; operating: string; under_attack: string } | null
  duplicates?: string[]
}

/**
 * Turn a catalog record into a registry rule WITHOUT wiring it. FLOOR records become floors. BAR and REMOVE
 * records are registered strict at every level (todo set) until a batch PR wires the call site and supplies
 * `values`; a rule can only relax once someone wrote code that reads it, so registering the whole catalog can
 * never loosen anything by itself.
 */
export function catalogRule(rec: CatalogRecord, wired?: { values: Readonly<Record<PolicyLevel, PolicyValue>> }): PolicyRule {
  const base = {
    id: rec.id,
    description: rec.blocks,
    sites: [rec.file_line],
    class: rec.class,
    fileLine: rec.file_line,
    who: rec.who,
    threat: rec.threat,
    ...(rec.bar ? { bar: rec.bar } : {}),
    ...(rec.code ? { refusalCodes: [rec.code] } : {}),
  } as const
  if (rec.class === 'FLOOR') return { ...base, floor: true, values: STRICT }
  if (wired) return { ...base, floor: false, values: wired.values }
  return { ...base, floor: false, values: STRICT, todo: `TODO(batch): catalog ${rec.class} entry, not wired; strict at every level until a batch PR reads it` }
}

const BY_ID: ReadonlyMap<string, PolicyRule> = new Map(POLICY_RULES.map((r) => [r.id, r]))

export function getRule(id: string): PolicyRule | undefined {
  return BY_ID.get(id)
}

/** Every refusal code the registry knows (used by the CI guard). */
export function registeredRefusalCodes(): ReadonlySet<string> {
  const s = new Set<string>()
  for (const r of POLICY_RULES) for (const c of r.refusalCodes ?? []) s.add(c)
  return s
}
