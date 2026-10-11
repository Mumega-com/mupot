// mupot.seed/v1 validator. Pure: no env, no DB, no network, no credential lookup.
// Validation grants NOTHING — it parses, refuses, canonicalises and lists the
// requests the seed makes. Strict by construction: unknown keys are refused.

import { isAlias, parseDocument, visit } from 'yaml'
import {
  CRED_SLOT_RE, SEED_DATA_TIERS, SEED_DEPLOY_VIA, SEED_KINDS, SEED_MAX_BYTES, SEED_MAX_DEPTH,
  SEED_CAPS, SEED_MAX_LIST, SEED_MAX_SEATS, SEED_RISK_CLASSES, SEED_ROUTINE_APPROVALS, SEED_SCHEMA,
  SEED_SEAT_CAPABILITIES, SEED_SLUG_RE, SEED_SURFACE_MODES,
  type SeedError, type SeedErrorCode, type SeedRequest, type SeedV1, type SeedValidation,
} from './contract'
import { canonicalSeedJson, seedSha256 } from './canonical'

class SeedFail extends Error {
  constructor(readonly detail: SeedError) { super(detail.message) }
}
function refuse(code: SeedErrorCode, path: string, message: string): never {
  throw new SeedFail({ code, path, message })
}

// Authority is never declared. A key NAMED like a credential is refused outright,
// whatever its value (an empty or placeholder value is still the wrong shape: the
// seed names a cred_slot, a human binds the value elsewhere).
const SECRET_KEY_RE = /(?:^|[_\-.])(?:grants?|tokens?|secrets?|passwords?|passwd|api[_-]?keys?|apikeys?|credentials?|private[_-]?keys?|bearer|authorization|auth[_-]?header)(?:$|[_\-.])/i

// Value shapes. Mirrors scripts/no-secrets.mjs (that file is a node-only CLI, not an
// importable lib, and this module must run in a Worker). Keep the two in step.
const SECRET_VALUE_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'OpenAI-style key', re: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/ },
  { label: 'GitHub token', re: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/ },
  { label: 'JWT', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { label: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'AWS access key id', re: /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/ },
  { label: 'Slack token', re: /xox[abprs]-[A-Za-z0-9-]{10,}/ },
  { label: 'bearer credential', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i },
  { label: 'URL with embedded credentials', re: /[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]*@/i },
]
// Long unbroken base64/hex-ish run containing both a digit and a letter.
// `/` is deliberately NOT in the class: ordinary paths (src/content/en/blog/...) are long and slashy.
const OPAQUE_RUN_RE = /(?<![A-Za-z0-9+])[A-Za-z0-9+]{40,}={0,2}(?![A-Za-z0-9+])/g

function looksSecret(value: string): string | null {
  for (const { label, re } of SECRET_VALUE_PATTERNS) if (re.test(value)) return label
  for (const run of value.matchAll(OPAQUE_RUN_RE)) {
    if (/\d/.test(run[0]) && /[A-Za-z]/.test(run[0])) return 'opaque high-entropy string'
  }
  return null
}

function scanForSecrets(value: unknown, path: string, depth: number): void {
  if (depth > SEED_MAX_DEPTH) refuse('seed_too_deep', path, `nesting deeper than ${SEED_MAX_DEPTH}`)
  if (typeof value === 'string') {
    const label = looksSecret(value)
    if (label) refuse('secret_in_seed', path, `value looks like a secret (${label}); seeds name a cred_slot, never a value`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((child, i) => scanForSecrets(child, `${path}[${i}]`, depth + 1))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) { // as: parsed plain data
      const childPath = path ? `${path}.${key}` : key
      if (SECRET_KEY_RE.test(key)) refuse('secret_in_seed', childPath, `key "${key}" names authority; a seed never declares grants, tokens or credentials`)
      scanForSecrets(child, childPath, depth + 1)
    }
  }
}

type Rec = Record<string, unknown>

function asRecord(value: unknown, path: string, allowed: readonly string[]): Rec {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse('invalid_field', path || '(root)', 'expected an object')
  const rec = value as Rec // as: narrowed to a non-array object above
  for (const key of Object.keys(rec)) {
    if (!allowed.includes(key)) refuse('unknown_key', path ? `${path}.${key}` : key, `unknown key "${key}"`)
  }
  return rec
}

// eslint-disable-next-line no-control-regex -- deliberate: reject control characters in seed text
const CONTROL_RE = /[\u0000-\u001f\u007f]/

function text(value: unknown, path: string, max: number, required = true): string | undefined {
  if (value === undefined) {
    if (required) refuse('missing_field', path, 'required')
    return undefined
  }
  if (typeof value !== 'string' || value.trim().length === 0) refuse('invalid_field', path, 'expected a non-empty string')
  if (value.length > max) refuse('invalid_field', path, `longer than ${max} characters`)
  if (CONTROL_RE.test(value)) refuse('invalid_field', path, 'control characters are not allowed')
  return value
}

function oneOf<T extends string>(value: unknown, path: string, options: readonly T[]): T {
  if (value === undefined) refuse('missing_field', path, 'required')
  if (typeof value !== 'string' || !(options as readonly string[]).includes(value)) {
    refuse('invalid_field', path, `expected one of: ${options.join(', ')}`)
  }
  return value as T // as: membership in `options` checked on the line above
}

function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) refuse('invalid_field', path, 'expected a list')
  if (value.length > SEED_MAX_LIST) refuse('invalid_field', path, `more than ${SEED_MAX_LIST} entries`)
  return value
}

function textList(value: unknown, path: string, max = 200): string[] | undefined {
  if (value === undefined) return undefined
  return list(value, path).map((item, i) => text(item, `${path}[${i}]`, max) as string) // as: required=true never returns undefined
}

function httpsUrl(value: unknown, path: string): string | undefined {
  const raw = text(value, path, SEED_CAPS.live, false)
  if (raw === undefined) return undefined
  let url: URL
  try { url = new URL(raw) } catch { return refuse('invalid_field', path, 'expected an https URL') }
  if (url.protocol !== 'https:') refuse('invalid_field', path, 'expected an https URL')
  if (url.username || url.password) refuse('secret_in_seed', path, 'URL carries credentials')
  return raw
}

function validateStructure(root: Rec): SeedV1 {
  if (root.schema !== SEED_SCHEMA) refuse('invalid_schema', 'schema', `expected "${SEED_SCHEMA}"`)
  const seed: Rec = { schema: SEED_SCHEMA }

  const slug = text(root.slug, 'slug', 63) as string
  if (!SEED_SLUG_RE.test(slug)) refuse('invalid_field', 'slug', 'expected kebab-case [a-z0-9-], at most 63 characters')
  seed.slug = slug
  seed.name = text(root.name, 'name', SEED_CAPS.name)
  seed.kind = oneOf(root.kind, 'kind', SEED_KINDS)
  seed.goal = text(root.goal, 'goal', SEED_CAPS.goal)
  seed.owner = text(root.owner, 'owner', 120) // a label only; never resolved to a member here
  const repo = text(root.repo, 'repo', SEED_CAPS.repo, false)
  if (repo !== undefined) seed.repo = repo
  const live = httpsUrl(root.live, 'live')
  if (live !== undefined) seed.live = live

  if (root.deploy !== undefined) {
    const d = asRecord(root.deploy, 'deploy', ['via', 'cmd', 'receipt', 'human_only'])
    if (d.human_only !== true) refuse('deploy_not_human_only', 'deploy.human_only', 'deploy.human_only must be literally true')
    const out: Rec = { via: oneOf(d.via, 'deploy.via', SEED_DEPLOY_VIA), human_only: true }
    const cmd = text(d.cmd, 'deploy.cmd', SEED_CAPS.cmd, false)
    if (cmd !== undefined) out.cmd = cmd
    const receipt = text(d.receipt, 'deploy.receipt', 300, false)
    if (receipt !== undefined) out.receipt = receipt
    seed.deploy = out
  }

  const risk = root.risk === undefined ? undefined : asRecord(root.risk, 'risk', ['class', 'forbidden', 'human_only', 'allow_direct'])
  const allowDirect = risk ? (textList(risk.allow_direct, 'risk.allow_direct') ?? []) : []
  if (risk) {
    const out: Rec = { class: oneOf(risk.class, 'risk.class', SEED_RISK_CLASSES) }
    for (const key of ['forbidden', 'human_only', 'allow_direct'] as const) {
      const v = textList(risk[key], `risk.${key}`)
      if (v && v.length > 0) out[key] = v
    }
    seed.risk = out
  }

  if (root.surfaces !== undefined) {
    const surfaces = list(root.surfaces, 'surfaces').map((raw, i) => {
      const p = `surfaces[${i}]`
      const s = asRecord(raw, p, ['path', 'type', 'mode'])
      if ((s.path === undefined) === (s.type === undefined)) refuse('invalid_field', p, 'exactly one of path or type is required')
      const mode = oneOf(s.mode, `${p}.mode`, SEED_SURFACE_MODES)
      const out: Rec = { mode }
      const id = s.path !== undefined ? text(s.path, `${p}.path`, 200) as string : text(s.type, `${p}.type`, 100) as string
      if (s.path !== undefined) out.path = id; else out.type = id
      // direct is refused by default; only an explicit risk.allow_direct entry opens it.
      if (mode === 'direct' && !allowDirect.includes(id)) {
        refuse('direct_not_allowed', `${p}.mode`, `direct mode for "${id}" requires it to be listed in risk.allow_direct`)
      }
      return out
    })
    if (surfaces.length > 0) seed.surfaces = surfaces
  }

  if (root.data !== undefined) {
    const data = list(root.data, 'data').map((raw, i) => {
      const d = asRecord(raw, `data[${i}]`, ['store', 'tier'])
      return { store: text(d.store, `data[${i}].store`, 200), tier: oneOf(d.tier, `data[${i}].tier`, SEED_DATA_TIERS) }
    })
    if (data.length > 0) seed.data = data
  }

  if (root.tools !== undefined) {
    const tools = list(root.tools, 'tools').map((raw, i) => {
      const p = `tools[${i}]`
      const t = asRecord(raw, p, ['mcp', 'openapi', 'cred_slot'])
      if ((t.mcp === undefined) === (t.openapi === undefined)) refuse('invalid_field', p, 'exactly one of mcp or openapi is required')
      const out: Rec = {}
      if (t.mcp !== undefined) out.mcp = text(t.mcp, `${p}.mcp`, 300)
      else out.openapi = text(t.openapi, `${p}.openapi`, 300)
      if (t.cred_slot !== undefined) {
        // A SLOT NAME only. Never looked up, never resolved, never validated against a vault here.
        if (typeof t.cred_slot !== 'string' || !CRED_SLOT_RE.test(t.cred_slot)) {
          refuse('invalid_cred_slot', `${p}.cred_slot`, 'cred_slot must match ^[A-Z][A-Z0-9_]{2,63}$')
        }
        out.cred_slot = t.cred_slot
      }
      return out
    })
    if (tools.length > 0) seed.tools = tools
  }

  if (root.wants !== undefined) {
    const w = asRecord(root.wants, 'wants', ['memory', 'gates', 'routines', 'seats'])
    const out: Rec = {}
    const memory = textList(w.memory, 'wants.memory')
    if (memory && memory.length > 0) out.memory = memory
    if (w.gates !== undefined) {
      const gates = list(w.gates, 'wants.gates').map((raw, i) => {
        const g = asRecord(raw, `wants.gates[${i}]`, ['action', 'gate'])
        return { action: text(g.action, `wants.gates[${i}].action`, 120), gate: text(g.gate, `wants.gates[${i}].gate`, 120) }
      })
      if (gates.length > 0) out.gates = gates
    }
    if (w.routines !== undefined) {
      const routines = list(w.routines, 'wants.routines').map((raw, i) => {
        const p = `wants.routines[${i}]`
        const r = asRecord(raw, p, ['id', 'cron', 'approval'])
        const cron = text(r.cron, `${p}.cron`, SEED_CAPS.cron) as string
        if (!/^\S+(?: \S+){4}$/.test(cron) || !/^[0-9A-Za-z*/,\-? ]+$/.test(cron)) refuse('invalid_field', `${p}.cron`, 'expected a five-field cron expression')
        return { id: text(r.id, `${p}.id`, 120), cron, approval: r.approval === undefined ? 'human_accept' : oneOf(r.approval, `${p}.approval`, SEED_ROUTINE_APPROVALS) } // default materialized: digest stable
      })
      if (routines.length > 0) out.routines = routines
    }
    if (w.seats !== undefined) {
      const s = asRecord(w.seats, 'wants.seats', ['squad', 'max', 'capability'])
      if (s.capability !== undefined) {
        if (typeof s.capability !== 'string' || !(SEED_SEAT_CAPABILITIES as readonly string[]).includes(s.capability)) {
          refuse('seat_capability_too_high', 'wants.seats.capability', 'seats may request at most member capability')
        }
      }
      if (typeof s.max !== 'number' || !Number.isInteger(s.max) || s.max < 1) refuse('invalid_field', 'wants.seats.max', 'expected a positive integer')
      if (s.max > SEED_MAX_SEATS) refuse('seat_cap_exceeded', 'wants.seats.max', `at most ${SEED_MAX_SEATS} seats`)
      const squad = text(s.squad, 'wants.seats.squad', 63) as string
      if (!SEED_SLUG_RE.test(squad)) refuse('invalid_field', 'wants.seats.squad', 'expected a kebab-case squad slug')
      // Default materialized so `capability: member` and an omitted capability share one digest.
      out.seats = { squad, max: s.max, capability: s.capability ?? 'member' }
    }
    if (Object.keys(out).length > 0) seed.wants = out
  }

  if (root.signals !== undefined) {
    const s = asRecord(root.signals, 'signals', ['health', 'outcome'])
    const out: Rec = {}
    const health = textList(s.health, 'signals.health')
    const outcome = textList(s.outcome, 'signals.outcome')
    if (health && health.length > 0) out.health = health
    if (outcome && outcome.length > 0) out.outcome = outcome
    if (Object.keys(out).length > 0) seed.signals = out
  }

  return seed as unknown as SeedV1 // as: every field above was checked or built by a validator in this function
}

// Every ask the seed makes, as an explicit line. Nothing here is granted by validating.
export function seedRequests(seed: SeedV1): SeedRequest[] {
  const out: SeedRequest[] = []
  const req = (kind: SeedRequest['kind'], detail: string) => out.push({ kind, detail, needs: 'human_accept' })
  for (const g of seed.wants?.gates ?? []) req('gate', `action ${g.action} gated by ${g.gate}`)
  for (const r of seed.wants?.routines ?? []) req('routine', `routine ${r.id} at "${r.cron}" (approval: ${r.approval})`)
  if (seed.wants?.seats) {
    const s = seed.wants.seats
    req('seat', `up to ${s.max} seat(s) in squad ${s.squad} at capability ${s.capability ?? 'member'} or lower`)
  }
  for (const m of seed.wants?.memory ?? []) req('memory', `memory scope ${m}`)
  for (const t of seed.tools ?? []) {
    if (t.cred_slot) req('tool_credential', `${t.mcp ?? t.openapi} needs credential slot ${t.cred_slot} bound by a human`)
  }
  for (const s of seed.surfaces ?? []) {
    if (s.mode === 'direct') req('direct_surface', `direct writes to ${s.path ?? s.type}`)
  }
  return out
}

function depthOf(value: unknown, depth: number): number {
  if (depth > SEED_MAX_DEPTH) return depth
  if (Array.isArray(value)) return value.reduce<number>((m, c) => Math.max(m, depthOf(c, depth + 1)), depth)
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Rec).reduce<number>((m, c) => Math.max(m, depthOf(c, depth + 1)), depth) // as: parsed plain data
  }
  return depth
}

export async function validateSeed(source: unknown): Promise<SeedValidation> {
  try {
    if (typeof source !== 'string') refuse('seed_unparseable', '(root)', 'seed must be a YAML or JSON string')
    if (new TextEncoder().encode(source).length > SEED_MAX_BYTES) refuse('seed_too_large', '(root)', `seed exceeds ${SEED_MAX_BYTES} bytes`)
    let parsed: unknown
    try {
      // Anchors and aliases are both refused below (alias expansion attacks); an alias needs an anchor;
      // duplicate keys are an error by default.
      const doc = parseDocument(source, { schema: 'core' })
      if (doc.errors.length > 0) throw doc.errors[0]
      let anchored = false
      visit(doc, { Node(_key, node) { if (isAlias(node) || ('anchor' in node && node.anchor)) anchored = true } })
      if (anchored) return refuse('seed_unparseable', '(root)', 'YAML anchors and aliases are not allowed')
      parsed = doc.toJS({ maxAliasCount: 0 })
    } catch (err) {
      if (err instanceof SeedFail) throw err
      return refuse('seed_unparseable', '(root)', err instanceof Error ? err.message.split('\n')[0].slice(0, 200) : 'parse error')
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) refuse('seed_not_object', '(root)', 'seed must be a mapping')
    if (depthOf(parsed, 0) > SEED_MAX_DEPTH) refuse('seed_too_deep', '(root)', `nesting deeper than ${SEED_MAX_DEPTH}`)
    scanForSecrets(parsed, '', 0) // before structure: a credential-named key reads as secret_in_seed, not unknown_key
    const root = asRecord(parsed, '', [
      'schema', 'slug', 'name', 'kind', 'goal', 'owner', 'repo', 'live', 'deploy', 'surfaces', 'data', 'tools', 'wants', 'signals', 'risk',
    ])
    const seed = validateStructure(root)
    return { ok: true, seed, canonical: canonicalSeedJson(seed), seedSha256: await seedSha256(seed), requests: seedRequests(seed) }
  } catch (err) {
    if (err instanceof SeedFail) return { ok: false, error: err.detail }
    throw err
  }
}
