// mupot — elevation action registry (Delivery Sequence step 3, mupot task
// f5fe1222, mumega-com#1173).
//
// Step-3 constraint 3: "GRANT OVER NAMED ACTIONS, NEVER OVER THE WORD
// `admin`." `admin` is undecomposed — it bundles project lifecycle, squad
// lifecycle, identity minting, key registration, capability granting, and
// budget into one word. A human elevation approval ticks one or more of the
// NAMED actions below; there is no 'admin' or 'rank' grant anywhere in this
// module or the elevation ledger it feeds.
//
// Step-3 constraint 4: "CLASSIFY EVERY ACTION BY WHETHER ITS EFFECT SURVIVES
// EXPIRY... A human must be able to see, before clicking, that an action's
// effect outlives the grant." This is the canonical map. It is a static,
// reviewed registry — NOT computed from a live table — because the whole
// point is that a human sees a value that cannot silently drift out from
// under an already-issued grant (see migrations/0148_elevation_ledger.sql's
// `effect` column, which freezes a COPY of this classification at grant
// time).
//
//   reversible            — the action's on-disk effect can be undone by
//                            someone with ordinary standing authority after
//                            the grant expires (create/delete a squad, edit
//                            an access edge, adjust a capability grant).
//   revocable_if_recorded — the action mints something with its own
//                            independent revoke primitive (a token id, a
//                            secret version) IF AND ONLY IF the elevation
//                            recorded what it minted (elevation_usage_log)
//                            so a human knows what to revoke.
//   irreversible          — there is NO undo primitive anywhere in this
//                            codebase for this action's effect. The task's
//                            own audit: register_agent_key is the only two
//                            `DELETE FROM agent_keys` statements in the
//                            codebase both live inside deactivate_agent, and
//                            registerAgentPublicKey (src/fleet/agent-keys.ts)
//                            refuses implicit rotation. A key registered
//                            inside a 15-minute elevation window is
//                            permanent. A D1 schema migration has the same
//                            shape (no down-migration mechanism exists here)
//                            and is classified the same way, conservatively.

export type ElevationActionEffect = 'reversible' | 'revocable_if_recorded' | 'irreversible'

export interface ElevationActionDef {
  /** The literal 'action:*' key stored in elevation_requests/elevation_grants. */
  key: string
  /** Short human label for the approval surface. */
  label: string
  /** One-sentence explanation of what this unlocks, for the approval surface. */
  description: string
  effect: ElevationActionEffect
  /** Human-readable note explaining the effect classification — rendered
   *  next to the effect badge so "irreversible" is never just an unglossed
   *  word on a click-through screen. */
  effectNote: string
  /** TRUE when at least one tool actually CONSULTS this action.
   *
   *  Six of these eight shipped as vocabulary with no consumer: a human could
   *  approve action:deploy, watch it render on the dashboard with a live
   *  countdown and an effect badge, and it authorized nothing. A defined
   *  action with no enforcement branch is a FALSE-AUTHORITY surface — worse
   *  than a missing feature, because the approval screen makes a promise the
   *  system never keeps, and the operator believes a decision was made.
   *
   *  Only enforced actions are requestable (REQUESTABLE_ELEVATION_ACTION_KEYS).
   *  Flip this to true in the same commit that wires the consumer, never
   *  before; tests/elevation-actions-enforced.test.ts fails either way round. */
  enforced: boolean
}

// Design doc "Authorization Semantics" names the first five presets
// (manage_access, deploy, migrate, secrets, dispatch); register_key and
// mint_token are added because they are the two actions the step-3 task
// brief calls out by name as needing explicit effect classification.
export const ELEVATION_ACTIONS: Readonly<Record<string, ElevationActionDef>> = Object.freeze({
  'action:manage_access': {
    key: 'action:manage_access',
    enforced: true,
    label: 'Manage access',
    description: 'Grant/revoke capabilities, add/remove squad members, edit project↔squad access.',
    effect: 'reversible',
    effectNote: 'Access edges and capability grants can be edited or removed by standing authority after expiry.',
  },
  'action:project_lifecycle': {
    key: 'action:project_lifecycle',
    enforced: true,
    label: 'Create/update squads',
    description: 'Create a squad inside a department you have been granted.',
    effect: 'reversible',
    effectNote: 'Created/updated records can be edited or removed by standing authority after expiry.',
  },
  'action:workspace_project': {
    key: 'action:workspace_project',
    enforced: true,
    label: 'Create/update workspace projects',
    description: 'Create or update a workspace project.',
    effect: 'reversible',
    effectNote: 'Created/updated records can be edited or removed by standing authority after expiry.',
  },
  'action:mint_token': {
    key: 'action:mint_token',
    enforced: true,
    label: 'Mint agent token',
    description: 'Issue a new bound bearer credential for an agent.',
    effect: 'revocable_if_recorded',
    effectNote:
      'A minted token is revocable by id via revoke_agent_token — but ONLY if this grant\'s usage log recorded the minted token id. Unrecorded, it is effectively irreversible.',
  },
  'action:register_key': {
    key: 'action:register_key',
    enforced: false,
    label: 'Register agent signing key',
    description: 'Register a public Ed25519 key for an agent\'s signed runtime identity.',
    effect: 'irreversible',
    effectNote:
      'There is no key rotation in this codebase — registerAgentPublicKey refuses implicit rotation. A key registered under this grant is permanent until a future owner-ceremony feature exists.',
  },
  'action:deploy': {
    key: 'action:deploy',
    enforced: false,
    label: 'Deploy',
    description: 'Trigger a project deploy.',
    effect: 'reversible',
    effectNote: 'A later deploy (by standing authority) can supersede this one.',
  },
  'action:migrate': {
    key: 'action:migrate',
    enforced: false,
    label: 'Apply migration',
    description: 'Apply a D1 schema migration.',
    effect: 'irreversible',
    effectNote: 'This codebase has no down-migration mechanism; an applied schema change is not automatically undone.',
  },
  'action:secrets': {
    key: 'action:secrets',
    enforced: false,
    label: 'Manage secrets',
    description: 'Set or rotate a secret value.',
    effect: 'revocable_if_recorded',
    effectNote: 'A set secret can be rotated again by standing authority — but only once someone knows it was set, which requires this grant\'s usage log to record it.',
  },
  'action:dispatch': {
    key: 'action:dispatch',
    enforced: false,
    label: 'Dispatch work',
    description: 'Dispatch a task/flight to a squad or agent.',
    effect: 'reversible',
    effectNote: 'Dispatching enqueues work; it does not itself grant standing authority beyond the dispatch record.',
  },
})

export type ElevationActionKey = keyof typeof ELEVATION_ACTIONS

export function isKnownElevationAction(key: string): key is ElevationActionKey {
  return Object.prototype.hasOwnProperty.call(ELEVATION_ACTIONS, key)
}

export function elevationActionEffect(key: string): ElevationActionEffect | null {
  return isKnownElevationAction(key) ? ELEVATION_ACTIONS[key].effect : null
}

export const ALL_ELEVATION_ACTION_KEYS: readonly string[] = Object.freeze(Object.keys(ELEVATION_ACTIONS))

/** The actions a request may actually name. An unenforced action is refused at
 *  REQUEST time rather than granted and silently ignored at use time, so nobody
 *  approves something decorative. */
export const REQUESTABLE_ELEVATION_ACTION_KEYS: readonly string[] = Object.freeze(
  Object.keys(ELEVATION_ACTIONS).filter((k) => ELEVATION_ACTIONS[k].enforced),
)

export function isRequestableElevationAction(key: string): boolean {
  return isKnownElevationAction(key) && ELEVATION_ACTIONS[key].enforced
}

// 1446 minutes (~24.1 hours) is Hadi's own explicit duration — asked for
// twice, verbatim "time limited 1446" (mupot task f5fe1222). It is not a
// round-hour value; formatMinutes() in src/dashboard/elevation.ts renders it
// as "1446 minutes (~24 hours)" rather than pretending it is exactly a day.
export const ELEVATION_DURATION_PRESETS_MINUTES = Object.freeze([15, 60, 240, 480, 1440, 1446] as const)
export type ElevationDurationMinutes = (typeof ELEVATION_DURATION_PRESETS_MINUTES)[number]
export const ELEVATION_DEFAULT_DURATION_MINUTES: ElevationDurationMinutes = 60

export function isValidElevationDuration(minutes: number): minutes is ElevationDurationMinutes {
  return (ELEVATION_DURATION_PRESETS_MINUTES as readonly number[]).includes(minutes)
}

/** Actions requiring the approving human's web session to have proven a
 *  fresh (≤5min) reauthentication round-trip before the approval is
 *  admitted — design doc Approval Flow step 5. */
export const SENSITIVE_STEP_UP_ACTIONS: ReadonlySet<string> = new Set([
  'action:manage_access',
  'action:deploy',
  'action:migrate',
  'action:secrets',
  'action:register_key',
  'action:mint_token',
])
