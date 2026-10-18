// Admission by observation, P0 (SHADOW ONLY). Pure Stage-0 rule scorer + shape-only argument description.
// Design: agents/kasra/docs/design-admission-by-observation-20261018.md (b), (c), (f) P0.
//
// NOTHING here blocks a call, changes a seat's status, or notifies anyone. It computes a score and a
// `would_hold` verdict that the store records for the owner to tune against in the shadow week.
//
// All thresholds live in TAPE_THRESHOLDS below, in ONE place.

export const TAPE_THRESHOLDS = {
  /** A window closes at this many events... */
  windowEvents: 20,
  /** ...or when its oldest event is this old (ms), whichever comes first. */
  windowMs: 10 * 60 * 1000,
  /** ...or when the serialised window reaches this many bytes (D1 row limit is 2MB; close far below it). */
  windowBytes: 200_000,
  /** Keys recorded per event; the rest are only counted. */
  maxKeysPerEvent: 32,
  /** Unknown key names scanned per event, each truncated, so a key flood cannot cost unbounded CPU. */
  maxUnknownScanned: 256,
  unknownKeyScanChars: 256,
  /** Window score at or above this would hold the seat (design: score >= 70). */
  holdScore: 70,
  /** Floor refusals within probeWindowMs that make a hard trip (design: 3 in 5 min = probing). */
  probeRefusals: 3,
  probeWindowMs: 5 * 60 * 1000,
  /** Points per signal occurrence, each capped so one signal cannot fill the whole scale alone. */
  drift: { per: 20, cap: 60 },
  destructive: { per: 10, cap: 40 },
  refusal: { per: 8, cap: 32 },
  /** Velocity: events per minute across the window (needs >= 5 events to mean anything). */
  velocity: { minEvents: 5, amberPerMin: 30, amberPoints: 20, redPerMin: 60, redPoints: 35 },
} as const

export type ArgClass = 'url' | 'email' | 'id' | 'secret_like'

/** The ONLY thing about a call's arguments that the tape ever stores: key names, lengths, classes. Never values. */
export interface ArgShape {
  /** Only keys that the tool's own inputSchema declares (at most TAPE_THRESHOLDS.maxKeysPerEvent). */
  keys: Record<string, { type: string; len?: number; classes?: ArgClass[] }>
  /** How many other keys the caller sent. Their names are caller-chosen text and are NEVER kept. */
  unknown_keys: number
  /** An unknown key's name or value looked secret-like (a secret or credentialed URL used as a key name). */
  unknown_secret_like?: boolean
}

export interface TapeEvent {
  seat_id: string
  member_id: string
  squad: string | null
  tool: string
  /** spec.min of the tool called */
  min: string
  /** 200 for ok, else the refusal/failure status */
  status: number
  /** refusal/error code, null when ok */
  error: string | null
  arg_shape: ArgShape
  /** the call named a squad/project other than the seat's own (computed at tap time; the target itself is not kept) */
  target_drift: boolean
  /** epoch ms */
  t: number
}

export interface WindowScore {
  score: number
  signals: {
    events: number
    drift: number
    destructive: number
    secret_outbound: number
    refusals: number
    cross_tenant: number
    hard_list: number
    events_per_min: number
  }
  hard_trips: string[]
  would_hold: boolean
}

// ── tool tables ────────────────────────────────────────────────────────────────────────────────────────────────

/** Name segments that make a tool destructive (design: archive, delete, revoke, transition, publish). */
export const DESTRUCTIVE_VERBS: ReadonlySet<string> = new Set([
  'archive', 'delete', 'remove', 'revoke', 'deactivate', 'cancel', 'release', 'reset', 'revert', 'verdict', 'publish', 'deploy', 'transition',
])

/** Tools whose arguments leave the seat's own surface (a secret-like arg here is exfiltration). */
export const OUTBOUND_TOOLS: ReadonlySet<string> = new Set([
  'send', 'broadcast', 'squad_message', 'remember', 'squad_remember', 'project_remember', 'project_wiki_upsert',
  'task_create', 'task_update', 'task_submit_result', 'set_agent_webhook_doorbell', 'supabase_mutate', 'project_deploy',
])

/** Design section (d): authority and identity mints. Attempting one from an observed seat is a hard trip. */
export const HARD_LIST_TOOLS: ReadonlySet<string> = new Set([
  'bootstrap_self', 'create_agent', 'mint_agent_token', 'grant_agent_capability', 'grant_gate_capability',
  'secret_env_request', 'reveal_credential_claim', 'pot_provision', 'operator_delegate',
])

export function isDestructiveTool(tool: string): boolean {
  return tool.split('_').some((seg) => DESTRUCTIVE_VERBS.has(seg))
}

// ── arg shape ──────────────────────────────────────────────────────────────────────────────────────────────────

const SECRET_KEY_RE = /(secret|token|password|passwd|api_?key|authorization|credential|private_?key)/i
const SECRET_VALUE_RES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/, // API-key style
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[A-Fa-f0-9]{40,}\b/, // long hex
  /\b[A-Za-z0-9+/_-]{48,}={0,2}/, // long base64/url-safe blob
  /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@/i, // URL with embedded credentials
]
const URL_RE = /^https?:\/\/\S+$/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,40})$/i

function classesOf(key: string, value: string): ArgClass[] {
  const out: ArgClass[] = []
  const v = value.trim()
  if (URL_RE.test(v)) out.push('url')
  if (EMAIL_RE.test(v)) out.push('email')
  if (ID_RE.test(v)) out.push('id')
  // A bare id is not a secret; the long-hex rule would otherwise flag every sha/uuid-ish id, so ids are exempt from it.
  const secretByValue = SECRET_VALUE_RES.some((re) => re.test(value)) && !out.includes('id')
  const secretByKey = SECRET_KEY_RE.test(key) && v.length >= 8
  if (secretByValue || secretByKey) out.push('secret_like')
  return out
}

/** Describe arguments WITHOUT keeping any value. A key name is kept ONLY when `allowedKeys` (the tool's inputSchema
 *  property names) contains it; every other key is counted, and its name and value are scanned for secret-like content
 *  but never stored. Nested objects/arrays are summarised by type and size, their string leaves still scanned. */
export function describeArgs(args: Record<string, unknown>, allowedKeys: ReadonlySet<string> = new Set()): ArgShape {
  const T = TAPE_THRESHOLDS
  const keys: ArgShape['keys'] = {}
  let kept = 0
  let unknown = 0
  let scanned = 0
  let unknownSecret = false
  for (const k in args) {
    if (!Object.prototype.hasOwnProperty.call(args, k)) continue
    const v = args[k]
    if (!allowedKeys.has(k) || kept >= T.maxKeysPerEvent) {
      unknown++
      if (!unknownSecret && scanned < T.maxUnknownScanned) {
        scanned++
        const head = k.slice(0, T.unknownKeyScanChars)
        if (SECRET_VALUE_RES.some((re) => re.test(head)) || SECRET_KEY_RE.test(head)) unknownSecret = true
        else if (typeof v === 'string' && classesOf(head, v.slice(0, 4096)).includes('secret_like')) unknownSecret = true
      }
      continue
    }
    kept++
    if (typeof v === 'string') {
      const classes = classesOf(k, v)
      keys[k] = { type: 'string', len: v.length, ...(classes.length ? { classes } : {}) }
    } else if (Array.isArray(v)) {
      const leaves = v.filter((x): x is string => typeof x === 'string')
      const secret = leaves.some((s) => classesOf(k, s).includes('secret_like'))
      keys[k] = { type: 'array', len: v.length, ...(secret ? { classes: ['secret_like' as const] } : {}) }
    } else if (v !== null && typeof v === 'object') {
      const flat = JSON.stringify(v)
      const secret = SECRET_VALUE_RES.some((re) => re.test(flat))
      keys[k] = { type: 'object', len: Object.keys(v).length, ...(secret ? { classes: ['secret_like' as const] } : {}) }
    } else {
      keys[k] = { type: v === null ? 'null' : typeof v }
    }
  }
  return { keys, unknown_keys: unknown, ...(unknownSecret ? { unknown_secret_like: true } : {}) }
}

export function hasSecretLike(shape: ArgShape): boolean {
  return shape.unknown_secret_like === true || Object.values(shape.keys).some((k) => k.classes?.includes('secret_like'))
}

// ── scorer ─────────────────────────────────────────────────────────────────────────────────────────────────────

export function isFloorRefusal(e: Pick<TapeEvent, 'status' | 'error'>): boolean {
  return e.status === 403 && e.error === 'forbidden'
}

export function isCrossTenant(e: Pick<TapeEvent, 'error'>): boolean {
  return e.error !== null && /tenant/i.test(e.error)
}

const cap = (n: number, c: { per: number; cap: number }): number => Math.min(n * c.per, c.cap)

/** Has the window run its course? Called with the events collected so far and the arrival time of the newest. */
export function windowIsFull(events: readonly TapeEvent[], now: number): boolean {
  if (events.length === 0) return false
  return events.length >= TAPE_THRESHOLDS.windowEvents || now - events[0].t >= TAPE_THRESHOLDS.windowMs
}

export function scoreWindow(events: readonly TapeEvent[]): WindowScore {
  const T = TAPE_THRESHOLDS
  const drift = events.filter((e) => e.target_drift).length
  const destructive = events.filter((e) => isDestructiveTool(e.tool)).length
  const secretOutbound = events.filter((e) => OUTBOUND_TOOLS.has(e.tool) && hasSecretLike(e.arg_shape)).length
  const refusalEvents = events.filter(isFloorRefusal)
  const crossTenant = events.filter(isCrossTenant).length
  const hardList = events.filter((e) => HARD_LIST_TOOLS.has(e.tool)).length

  let probe = false
  for (let i = 0; i < refusalEvents.length && !probe; i++) {
    const inWin = refusalEvents.filter((r) => r.t >= refusalEvents[i].t && r.t - refusalEvents[i].t <= T.probeWindowMs).length
    probe = inWin >= T.probeRefusals
  }

  const spanMs = events.length > 1 ? Math.max(events[events.length - 1].t - events[0].t, 1000) : 0
  const perMin = spanMs > 0 ? (events.length / spanMs) * 60_000 : 0
  let velocityPoints = 0
  if (events.length >= T.velocity.minEvents) {
    if (perMin >= T.velocity.redPerMin) velocityPoints = T.velocity.redPoints
    else if (perMin >= T.velocity.amberPerMin) velocityPoints = T.velocity.amberPoints
  }

  const hardTrips: string[] = []
  if (secretOutbound > 0) hardTrips.push('secret_outbound')
  if (crossTenant > 0) hardTrips.push('cross_tenant')
  if (probe) hardTrips.push('floor_probe')
  if (hardList > 0) hardTrips.push('hard_list_tool')
  // Scope drift is a hard trip per the design ("cross-squad reach is a hard trip").
  if (drift > 0) hardTrips.push('scope_drift')

  const raw = cap(drift, T.drift) + cap(destructive, T.destructive) + cap(refusalEvents.length, T.refusal) + velocityPoints
  const score = Math.max(0, Math.min(100, Math.round(raw)))
  return {
    score,
    signals: { events: events.length, drift, destructive, secret_outbound: secretOutbound, refusals: refusalEvents.length, cross_tenant: crossTenant, hard_list: hardList, events_per_min: Math.round(perMin * 10) / 10 },
    hard_trips: hardTrips,
    would_hold: hardTrips.length > 0 || score >= T.holdScore,
  }
}
