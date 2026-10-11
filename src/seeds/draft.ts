// mupot.seed/v1 DRAFTER. Pure: no env, no DB, no network. Turns facts an agent already holds
// (a repo URL or a site URL, plus optional hints) into seed text, then runs the REAL validator on
// that text and proves the parsed result is exactly what was intended.
//
// SAFETY
//   - The draft only ever REQUESTS. It never carries a grant, a credential value or an accept
//     token: the contract has no field for acceptance, and the validator refuses authority-named
//     keys, so the drafter has nowhere to put one.
//   - Defaults are the narrowest the contract can express: edits are `propose`, never `direct`
//     (so no allow_direct), deploy is human-only, one observer seat, a named human gate.
//   - Author text is refused (not repaired) when it holds control or invisible characters, and
//     every scalar is emitted as a JSON double-quoted string (valid YAML). The emitted text is
//     then parsed back by the real validator and compared to the intended object, so a string
//     that escaped its scalar surfaces as a mismatch, never as a different seed.
//   - No fetch. The URL is only parsed and normalised.

import {
  CRED_SLOT_RE, SEED_CAPS, SEED_DEPLOY_VIA, SEED_KINDS, SEED_MAX_LIST, SEED_RISK_CLASSES, SEED_SCHEMA, SEED_SLUG_RE,
  type SeedDeployVia, type SeedKind, type SeedRiskClass, type SeedValidation,
} from './contract'
import { validateSeed } from './validate'
import { repoIdentity, slugFromProjectName } from '../projects/urls'

export const DRAFT_PLATFORMS = ['wordpress', 'astro', 'shopify', 'static'] as const
export type DraftPlatform = (typeof DRAFT_PLATFORMS)[number]

export type DraftSource =
  | { kind: 'repo'; url: string }
  | { kind: 'site'; url: string; platform?: DraftPlatform }

export interface DraftInput {
  source: DraftSource
  project_name?: string
  hints?: Record<string, unknown>
}

export type DraftErrorCode = 'invalid_args' | 'invalid_source' | 'invalid_hint' | 'draft_rejected'
export interface DraftError { code: DraftErrorCode; path: string; message: string }

/** Turns the intended seed object into YAML text. Injectable so a test can plug in a broken emitter. */
export type SeedEmitter = (seed: Record<string, unknown>) => string
export interface DraftOptions { emit?: SeedEmitter }

export type DraftResult =
  | { ok: true; seedYaml: string; validation: Extract<SeedValidation, { ok: true }>; warnings: string[] }
  | { ok: false; error: DraftError }

class DraftFail extends Error {
  constructor(readonly detail: DraftError) { super(detail.message) }
}
function refuse(code: DraftErrorCode, path: string, message: string): never {
  throw new DraftFail({ code, path, message })
}

// Same classes the validator refuses; refused here first so the message names the hint, not a
// generic validator path. Author text is never echoed in a message.
const CONTROL_RE = /\p{Cc}/u
const SPOOF_RE = /[\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}⠀]/u
// A lone UTF-16 surrogate is not valid text and does not survive UTF-8 encoding of the seed.
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

const HINT_KEYS = [
  'goal', 'owner', 'live_url', 'repo_url', 'kind', 'deploy_via', 'deploy_cmd', 'deploy_receipt',
  'squad', 'gate', 'risk_class', 'surface_paths', 'tool_slots',
] as const

function cleanKey(key: string): string {
  const cleaned = key.replace(/[^A-Za-z0-9_.-]/g, '?')
  return cleaned.length > 40 ? `${cleaned.slice(0, 40)}...` : cleaned
}

function str(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) refuse('invalid_args', path, 'expected a non-empty string')
  if (value.length > max) refuse('invalid_args', path, `longer than ${max} characters`)
  if (CONTROL_RE.test(value)) refuse('invalid_args', path, 'control characters are not allowed')
  if (SPOOF_RE.test(value)) refuse('invalid_args', path, 'invisible or formatting characters are not allowed')
  if (LONE_SURROGATE_RE.test(value)) refuse('invalid_args', path, 'unpaired surrogate characters are not allowed')
  return value.trim()
}

function oneOf<T extends string>(value: unknown, path: string, options: readonly T[]): T {
  if (typeof value !== 'string' || !(options as readonly string[]).includes(value)) {
    refuse('invalid_args', path, `expected one of: ${options.join(', ')}`)
  }
  return value as T // as: membership in `options` checked on the line above
}

/** https only, no credentials; returns the parsed URL. */
function parseHttps(raw: string, path: string): URL {
  let url: URL
  try { url = new URL(raw) } catch { return refuse('invalid_source', path, 'expected an https URL') }
  if (url.protocol !== 'https:') refuse('invalid_source', path, 'expected an https URL')
  if (url.username || url.password) refuse('invalid_source', path, 'URL must not carry credentials')
  return url
}

const SCP_RE = /^[^/@\s]+@([^:/\s]+):(?!\/\/)(.+)$/

/**
 * Normalised https repo URL: any accepted spelling of one repository folds to one https form, with the
 * ORIGINAL owner/repo case kept (hosts are lowercased) so it compares equal to an existing row.
 * repoIdentity is used only to validate and to confirm the rebuilt URL names the same repository.
 * Only https URLs and scp-style `user@host:owner/repo` are accepted; a non-default port is refused
 * (a seed repo URL has nowhere to carry it); embedded credentials are stripped with a warning.
 */
function normaliseRepo(raw: string, path: string, warnings: string[]): string {
  const trimmed = raw.trim()
  const scp = SCP_RE.exec(trimmed)
  let url: URL
  if (scp) {
    try { url = new URL(`ssh://${scp[1]}/${scp[2]}`) } catch { return refuse('invalid_source', path, 'not a recognisable repository URL') }
  } else {
    try { url = new URL(trimmed) } catch { return refuse('invalid_source', path, 'not a recognisable repository URL') }
    if (url.protocol !== 'https:') refuse('invalid_source', path, 'repository URL must be https (or scp-style user@host:owner/repo)')
    // WHATWG parsing turns `https:///o/r` into host `o`; an empty authority is a missing host, not a short one.
    if (!/^[a-z][a-z0-9+.-]*:\/\/[^/\s]/i.test(trimmed)) refuse('invalid_source', path, 'repository URL has no host')
    if (url.username || url.password) warnings.push(`credentials in ${path} were stripped; never put credentials in a repository URL`)
    if (url.port) refuse('invalid_source', path, 'repository URL with a non-default port is not supported')
  }
  if (!url.hostname) refuse('invalid_source', path, 'repository URL has no host')
  const id = repoIdentity(trimmed)
  if (!id) return refuse('invalid_source', path, 'not a recognisable repository URL')
  if (id.kind === 'github-unsure' || id.kind === 'url-unsure') refuse('invalid_source', path, 'repository URL has an undecodable segment')
  const host = url.hostname.toLowerCase().replace(/\.+$/, '')
  const segments = url.pathname.split('/').filter((x) => x !== '' && x !== '.')
  const stripGit = (x: string): string => { let t = x; while (/\.git$/i.test(t)) t = t.slice(0, -4); return t }
  if (id.kind === 'github') {
    if (!id.repo) refuse('invalid_source', path, 'repository URL must name owner and repository')
    const parts = host === 'api.github.com' && segments[0]?.toLowerCase() === 'repos' ? segments.slice(1) : segments
    const owner = parts[0] ?? ''
    const repoName = stripGit(parts[1] ?? '')
    // Keep the original spelling only when it is the very repository repoIdentity resolved.
    if (owner.toLowerCase() === id.owner && repoName.toLowerCase() === id.repo) return `https://github.com/${owner}/${repoName}`
    return `https://github.com/${id.owner}/${id.repo}`
  }
  if (!id.key.includes('/')) refuse('invalid_source', path, 'repository URL must include a path')
  const last = segments.length - 1
  const rebuilt = `${host}/${segments.map((seg, i) => (i === last ? stripGit(seg) : seg)).join('/')}`
  return `https://${rebuilt.toLowerCase() === id.key ? rebuilt : id.key}`
}

function repoDisplayName(repoUrl: string): string {
  const last = repoUrl.split('/').filter(Boolean).pop() ?? ''
  return last
}

// Minimal YAML writer for the fixed shape the drafter builds. Keys are code literals; every
// scalar string is a JSON double-quoted string, which is a valid YAML scalar for any content.
type Emittable = string | number | boolean | Emittable[] | { [key: string]: Emittable | undefined }
export function emitSeedYaml(seed: Record<string, unknown>): string {
  return `${emit(seed as Emittable, 0).join('\n')}\n` // as: the drafter builds `seed` from Emittable parts only
}
function emit(value: Emittable, indent: number): string[] {
  const pad = '  '.repeat(indent)
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const [first, ...rest] = emit(item, indent + 1)
        return [`${pad}- ${first.trimStart()}`, ...rest]
      }
      return [`${pad}- ${scalar(item as string | number | boolean)}`] // as: arrays here hold scalars or objects only
    })
  }
  if (typeof value === 'object') {
    const lines: string[] = []
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue
      if (typeof child === 'object') {
        lines.push(`${pad}${key}:`, ...emit(child, indent + 1))
      } else {
        lines.push(`${pad}${key}: ${scalar(child)}`)
      }
    }
    return lines
  }
  return [`${pad}${scalar(value)}`]
}
function scalar(value: string | number | boolean): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}

function stringList(value: unknown, path: string, max: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > SEED_MAX_LIST) refuse('invalid_hint', path, `expected a list of 1 to ${SEED_MAX_LIST} strings`)
  return value.map((v, i) => str(v, `${path}[${i}]`, max))
}

interface ToolSlot { mcp?: string; openapi?: string; cred_slot?: string }
function toolSlots(value: unknown): ToolSlot[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > SEED_MAX_LIST) refuse('invalid_hint', 'hints.tool_slots', `expected a list of 1 to ${SEED_MAX_LIST} entries`)
  return value.map((raw, i) => {
    const p = `hints.tool_slots[${i}]`
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) refuse('invalid_hint', p, 'expected an object')
    const rec = raw as Record<string, unknown> // as: plain object checked on the line above
    for (const k of Object.keys(rec)) if (!['mcp', 'openapi', 'cred_slot'].includes(k)) refuse('invalid_hint', p, 'only mcp, openapi and cred_slot are allowed')
    if ((rec.mcp === undefined) === (rec.openapi === undefined)) refuse('invalid_hint', p, 'exactly one of mcp or openapi is required')
    const out: ToolSlot = {}
    if (rec.mcp !== undefined) out.mcp = str(rec.mcp, `${p}.mcp`, SEED_CAPS.tool)
    else out.openapi = str(rec.openapi, `${p}.openapi`, SEED_CAPS.tool)
    if (rec.cred_slot !== undefined) {
      if (typeof rec.cred_slot !== 'string' || !CRED_SLOT_RE.test(rec.cred_slot)) refuse('invalid_hint', `${p}.cred_slot`, 'cred_slot must be a slot NAME matching ^[A-Z][A-Z0-9_]{2,63}$')
      out.cred_slot = rec.cred_slot
    }
    return out
  })
}

const PLATFORM_KIND: Record<DraftPlatform, SeedKind> = {
  wordpress: 'site/wordpress', astro: 'site/astro', shopify: 'store/shopify', static: 'app',
}

function buildSeed(input: DraftInput, warnings: string[]): Record<string, Emittable> {
  const { source } = input
  const hints = input.hints ?? {}
  if (hints === null || typeof hints !== 'object' || Array.isArray(hints)) refuse('invalid_args', 'hints', 'expected an object')
  const unknownHints: string[] = []
  for (const key of Object.keys(hints)) {
    if (key === 'branches') warnings.push('hint "branches" ignored: mupot.seed/v1 has no field for branch policy')
    else if (!(HINT_KEYS as readonly string[]).includes(key)) unknownHints.push(cleanKey(key))
  }
  if (unknownHints.length > 0) {
    const shown = unknownHints.slice(0, 10).map((k) => `"${k}"`).join(', ')
    const more = unknownHints.length > 10 ? ` and ${unknownHints.length - 10} more` : ''
    warnings.push(`${unknownHints.length} hint(s) ignored, not fields the drafter understands: ${shown}${more}`)
  }

  let repo: string | undefined
  let live: string | undefined
  let kind: SeedKind
  let platform: DraftPlatform | undefined
  let baseName: string

  if (source.kind === 'repo') {
    repo = normaliseRepo(str(source.url, 'source.url', SEED_CAPS.repo), 'source.url', warnings)
    kind = 'repo'
    baseName = repoDisplayName(repo)
  } else {
    const url = parseHttps(str(source.url, 'source.url', SEED_CAPS.live), 'source.url')
    live = url.origin // path, query and fragment dropped: a site seed names the site, not a page
    if (url.pathname !== '/' || url.search || url.hash) warnings.push('site URL reduced to its origin')
    platform = source.platform === undefined ? undefined : oneOf(source.platform, 'source.platform', DRAFT_PLATFORMS)
    kind = platform ? PLATFORM_KIND[platform] : 'app'
    if (!platform) warnings.push('no platform given: kind defaults to "app"; pass source.platform or hints.kind')
    if (platform === 'static') warnings.push('mupot.seed/v1 has no static-site kind: kind set to "app"')
    baseName = url.hostname
  }

  if (hints.kind !== undefined) kind = oneOf(hints.kind, 'hints.kind', SEED_KINDS)
  if (hints.repo_url !== undefined) repo = normaliseRepo(str(hints.repo_url, 'hints.repo_url', SEED_CAPS.repo), 'hints.repo_url', warnings)
  if (hints.live_url !== undefined) live = parseHttps(str(hints.live_url, 'hints.live_url', SEED_CAPS.live), 'hints.live_url').origin

  // The derived default goes through the same text checks as an explicit name.
  const name = str(input.project_name === undefined ? baseName : input.project_name, input.project_name === undefined ? 'source.url' : 'project_name', SEED_CAPS.name)
  const slug = slugFromProjectName(name)
  if (!slug || !SEED_SLUG_RE.test(slug)) refuse('invalid_args', 'project_name', 'no usable slug can be derived from the name')

  let goal: string
  if (hints.goal !== undefined) goal = str(hints.goal, 'hints.goal', SEED_CAPS.goal)
  else {
    goal = `Maintain ${name}; every change is proposed for human review before it lands.`
    warnings.push('goal is a generic placeholder: replace it with the real goal')
  }
  let owner: string
  if (hints.owner !== undefined) owner = str(hints.owner, 'hints.owner', SEED_CAPS.owner)
  else {
    owner = 'unassigned'
    warnings.push('owner is "unassigned": set the accountable person or team label')
  }

  const seed: Record<string, Emittable> = { schema: SEED_SCHEMA, slug, name, kind, goal, owner }
  if (repo) seed.repo = repo
  if (live) seed.live = live

  // deploy: WordPress mirrors the plugin-deploy shape; anything else only when told.
  const via: SeedDeployVia | undefined = hints.deploy_via !== undefined
    ? oneOf(hints.deploy_via, 'hints.deploy_via', SEED_DEPLOY_VIA)
    : kind === 'site/wordpress' ? 'wp-plugin' : hints.deploy_cmd !== undefined ? 'git-push-only' : undefined
  if (hints.deploy_cmd !== undefined && hints.deploy_via === undefined) warnings.push('deploy_cmd given without deploy_via: via set to "git-push-only"')
  if (hints.deploy_receipt !== undefined && !via) warnings.push('hint "deploy_receipt" ignored: no deploy is declared (pass deploy_via or deploy_cmd)')
  if (via) {
    const deploy: { [key: string]: Emittable } = { via }
    if (hints.deploy_cmd !== undefined) deploy.cmd = str(hints.deploy_cmd, 'hints.deploy_cmd', SEED_CAPS.cmd)
    if (hints.deploy_receipt !== undefined) deploy.receipt = str(hints.deploy_receipt, 'hints.deploy_receipt', SEED_CAPS.receipt)
    else deploy.receipt = 'change receipt recorded on the project'
    deploy.human_only = true // the contract requires literally true; a human always deploys
    seed.deploy = deploy
  } else {
    warnings.push('no deploy declared: pass hints.deploy_via (and deploy_cmd) if the project deploys')
  }

  // surfaces: propose only. A draft never asks for direct writes, so it never needs allow_direct.
  if (kind === 'site/wordpress') {
    if (hints.surface_paths !== undefined) warnings.push('hint "surface_paths" ignored for a WordPress site: surfaces are wp.page, wp.post and wp.media')
    seed.surfaces = [{ type: 'wp.page', mode: 'propose' }, { type: 'wp.post', mode: 'propose' }, { type: 'wp.media', mode: 'propose' }]
  } else {
    const paths = hints.surface_paths !== undefined ? stringList(hints.surface_paths, 'hints.surface_paths', SEED_CAPS.surfacePath) : ['**']
    if (hints.surface_paths === undefined) warnings.push('surfaces default to every path in propose mode: narrow with hints.surface_paths')
    seed.surfaces = paths.map((path) => ({ path, mode: 'propose' }))
  }

  // tools: only slot NAMES. A WordPress site gets the MCPWP default endpoint with one slot.
  let tools: ToolSlot[] | undefined
  if (hints.tool_slots !== undefined) tools = toolSlots(hints.tool_slots)
  else if (kind === 'site/wordpress' && live) tools = [{ mcp: `${live}/wp-json/mcpwp/v1/mcp`, cred_slot: 'WP_SITE_API' }]
  if (tools) seed.tools = tools.map((t) => ({ ...t }))
  if (kind === 'site/wordpress' && hints.tool_slots === undefined) warnings.push('tool endpoint /wp-json/mcpwp/v1/mcp is the MCPWP default endpoint; confirm before binding (a human binds the credential for slot WP_SITE_API)')

  const gate = hints.gate === undefined ? 'gate:owner' : str(hints.gate, 'hints.gate', SEED_CAPS.gateField)
  if (hints.gate === undefined) warnings.push('gate defaults to "gate:owner": name the human who holds the gate')
  let squad = slug.slice(0, 63)
  if (hints.squad !== undefined) {
    squad = str(hints.squad, 'hints.squad', 63)
    if (!SEED_SLUG_RE.test(squad)) refuse('invalid_hint', 'hints.squad', 'expected a kebab-case squad slug')
  }
  seed.wants = {
    gates: [{ action: 'publish_change', gate }],
    // One observer seat: the narrowest the contract allows. A human can raise it when accepting.
    seats: { squad, max: 1, capability: 'observer' },
  }
  warnings.push('one observer seat requested: raise to member when a human accepts, if agents must write proposals')

  if (live) seed.signals = { health: [live] }

  const riskClass: SeedRiskClass = hints.risk_class === undefined ? 'medium' : oneOf(hints.risk_class, 'hints.risk_class', SEED_RISK_CLASSES)
  seed.risk = {
    class: riskClass,
    forbidden: kind === 'repo' ? ['force_push', 'delete_branch'] : ['delete_content'],
    human_only: ['deploy'],
  }
  return seed
}

export async function draftSeed(input: DraftInput, options: DraftOptions = {}): Promise<DraftResult> {
  try {
    if (input === null || typeof input !== 'object') refuse('invalid_args', '(root)', 'expected an object')
    const source: unknown = input.source
    if (source === null || typeof source !== 'object' || Array.isArray(source)) refuse('invalid_args', 'source', 'expected an object')
    const src = source as { kind?: unknown; url?: unknown; platform?: unknown } // as: plain object checked above; fields validated below
    const kind = oneOf(src.kind, 'source.kind', ['repo', 'site'] as const)
    if (kind === 'repo' && src.platform !== undefined) refuse('invalid_args', 'source.platform', 'platform applies to site sources only')
    if (typeof src.url !== 'string') refuse('invalid_args', 'source.url', 'expected a string')
    const normalised: DraftInput = {
      source: kind === 'repo'
        ? { kind, url: src.url }
        : { kind, url: src.url, platform: src.platform === undefined ? undefined : oneOf(src.platform, 'source.platform', DRAFT_PLATFORMS) },
      project_name: input.project_name,
      hints: input.hints,
    }
    const warnings: string[] = ['no network fetch was made: fields come from the URL and the hints only']
    const extraSource = Object.keys(src).filter((k) => !['kind', 'url', 'platform'].includes(k)).map(cleanKey)
    if (extraSource.length > 0) warnings.push(`${extraSource.length} extra key(s) under source ignored: ${extraSource.slice(0, 10).map((k) => `"${k}"`).join(', ')}${extraSource.length > 10 ? ` and ${extraSource.length - 10} more` : ''}`)
    const intended = buildSeed(normalised, warnings)
    const seedYaml = (options.emit ?? emitSeedYaml)(intended)

    // The real validator is the judge. A refusal here is a drafter bug or hostile input.
    const validation = await validateSeed(seedYaml)
    if (!validation.ok) refuse('draft_rejected', validation.error.path, `validator refused the draft (${validation.error.code}): ${validation.error.message}`)
    // Round trip: the text must parse back to exactly what was intended. A string that escaped its
    // scalar (and so changed or added a field) shows up as a digest mismatch, never as another seed.
    const reparsed = await validateSeed(JSON.stringify(intended))
    if (!reparsed.ok || reparsed.canonical !== validation.canonical) {
      refuse('draft_rejected', '(root)', 'drafted text did not round-trip to the intended seed')
    }
    return { ok: true, seedYaml, validation, warnings }
  } catch (err) {
    if (err instanceof DraftFail) return { ok: false, error: err.detail }
    throw err
  }
}
