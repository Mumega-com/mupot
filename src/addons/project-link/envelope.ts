export const PROJECT_LINK_ENVELOPE_SCHEMA = 'mupot.project-link-envelope/v1' as const
export const PROJECT_LINK_ENVELOPE_SIGNATURE_DOMAIN = 'mupot.project-link-envelope/v1/signature' as const

export type ProjectLinkTaskState = 'open' | 'in_progress' | 'review' | 'blocked' | 'done'
export type ProjectLinkPriority = 'low' | 'normal' | 'high' | 'urgent'
export type ProjectLinkCapability = 'project.task.write' | 'project.evidence.write'
export type ProjectLinkEvidenceMediaType = 'application/json' | 'text/plain' | 'image/png' | 'image/jpeg' | 'application/pdf'

/** Allowlisted top-level envelope keys for mupot.project-link-envelope/v1. */
export const PROJECT_LINK_ENVELOPE_FIELDS = Object.freeze([
  'schema', 'source', 'destination', 'correlation_id', 'idempotency_key',
  'requested_capability', 'expires_at', 'task', 'evidence',
] as const)

/** Allowlisted source identity keys (paired pot + project + signing agent/key). */
export const PROJECT_LINK_SOURCE_FIELDS = Object.freeze([
  'pot', 'project_id', 'agent_id', 'key_id',
] as const)

/** Allowlisted destination identity keys (paired pot + project). */
export const PROJECT_LINK_DESTINATION_FIELDS = Object.freeze([
  'pot', 'project_id',
] as const)

/** Allowlisted task coordination fields (sanitized status only). */
export const PROJECT_LINK_TASK_FIELDS = Object.freeze([
  'source_task_id', 'flight_id', 'request_id', 'title', 'state', 'priority',
  'blocker_summary', 'success_predicate', 'progress_summary',
] as const)

/** Allowlisted evidence reference fields (hash + authorized URL only). */
export const PROJECT_LINK_EVIDENCE_FIELDS = Object.freeze([
  'sha256', 'media_type', 'occurred_at', 'url',
] as const)

/**
 * Explicit customer / credential / analytics / transcript fields that must never
 * cross a project link. Rejected as `prohibited_field` (not merely unknown).
 * Design boundary: DME cross-pot collaboration may exchange sanitized coordination
 * state only — never customer records, tokens, raw analytics, transcripts, or
 * unapproved file contents.
 */
export const PROJECT_LINK_PROHIBITED_CUSTOMER_FIELDS = Object.freeze([
  'customer', 'customer_id', 'customer_email', 'customer_record', 'customer_records',
  'contact', 'contacts', 'contact_list', 'contact_lists', 'phone', 'phone_number',
  'access_token', 'api_key', 'credential', 'credentials', 'password', 'secret',
  'private_key', 'authorization', 'bearer',
  'raw_analytics', 'analytics', 'analytics_export', 'analytics_exports',
  'transcript', 'transcripts', 'conversation', 'conversation_transcript',
  'message_body', 'message_bodies', 'private_prompt', 'private_prompts',
  'model_memory', 'file_contents', 'unapproved_file', 'unapproved_files',
] as const)

const PROHIBITED_CUSTOMER_FIELD_SET: ReadonlySet<string> = new Set(PROJECT_LINK_PROHIBITED_CUSTOMER_FIELDS)

export interface ProjectLinkEnvelopeV1 {
  schema: typeof PROJECT_LINK_ENVELOPE_SCHEMA
  source: { pot: string; project_id: string; agent_id: string; key_id: string }
  destination: { pot: string; project_id: string }
  correlation_id: string
  idempotency_key: string
  requested_capability: ProjectLinkCapability
  expires_at: string
  task: {
    source_task_id: string
    flight_id: string | null
    request_id: string | null
    title: string
    state: ProjectLinkTaskState
    priority: ProjectLinkPriority
    blocker_summary: string | null
    success_predicate: string
    progress_summary: string
  } | null
  evidence: {
    sha256: string
    media_type: ProjectLinkEvidenceMediaType
    occurred_at: string
    url: string | null
  } | null
}

export interface SignedProjectLinkEnvelopeV1 {
  envelope: ProjectLinkEnvelopeV1
  signature: string
}

export type EnvelopeValidationResult =
  | { ok: true; envelope: ProjectLinkEnvelopeV1 }
  | { ok: false; reason: string; path: string }

export interface ProjectLinkEnvelopeValidationOptions {
  approvedEvidenceOrigins?: readonly string[]
}

const ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,198}[A-Za-z0-9])?$/
const SHA256 = /^[a-f0-9]{64}$/
const CANONICAL_DOMAIN = /^[a-z0-9](?:[a-z0-9._/-]{0,126}[a-z0-9])?$/
const CANONICAL_PREFIX = 'MUPOT-SIGNED-CANONICAL-JSON'
const MAX_URL_PATH_DECODE_PASSES = 8
const TASK_STATES: readonly ProjectLinkTaskState[] = ['open', 'in_progress', 'review', 'blocked', 'done']
const PRIORITIES: readonly ProjectLinkPriority[] = ['low', 'normal', 'high', 'urgent']
const CAPABILITIES: readonly ProjectLinkCapability[] = ['project.task.write', 'project.evidence.write']
const MEDIA_TYPES: readonly ProjectLinkEvidenceMediaType[] = ['application/json', 'text/plain', 'image/png', 'image/jpeg', 'application/pdf']
const SENSITIVE = /(?:Bearer\s+\S+|\bmupot_[A-Za-z0-9_-]+\b|\bgh[pousr]_[A-Za-z0-9_-]{12,}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b|\bAKIA[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?:api[_-]?key|access[_-]?token|private[_-]?key|password|secret)\s*[:=])/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fieldPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key
}

function exactKeys(value: unknown, keys: readonly string[], path: string): EnvelopeValidationResult | null {
  if (!isRecord(value)) return { ok: false, reason: 'invalid_object', path }
  const actual = Object.keys(value)
  for (const key of actual) {
    if (PROHIBITED_CUSTOMER_FIELD_SET.has(key)) {
      return { ok: false, reason: 'prohibited_field', path: fieldPath(path, key) }
    }
    if (!keys.includes(key)) return { ok: false, reason: 'unknown_field', path: fieldPath(path, key) }
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) return { ok: false, reason: 'missing_field', path: fieldPath(path, key) }
  }
  return null
}

/** Reject explicit denylisted keys anywhere in the tree before content scans. */
function prohibitedFieldName(
  value: unknown,
  path = '',
  seen = new WeakSet<object>(),
): EnvelopeValidationResult | null {
  if (typeof value !== 'object' || value === null) return null
  if (seen.has(value)) return null
  seen.add(value)
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const error = prohibitedFieldName(value[index], `${path}[${index}]`, seen)
      if (error) return error
    }
    return null
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = fieldPath(path, key)
    if (PROHIBITED_CUSTOMER_FIELD_SET.has(key)) {
      return { ok: false, reason: 'prohibited_field', path: childPath }
    }
    const error = prohibitedFieldName(child, childPath, seen)
    if (error) return error
  }
  return null
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value) && !sensitive(value)
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

function boundedText(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === 'string'
    && value.length <= max
    && (allowEmpty || value.trim().length > 0)
}

function sensitive(value: string): boolean {
  return SENSITIVE.test(value)
}

// #403 gap 2(a): reject NUL bytes and non-whitespace C0/DEL control characters in inbound
// free-text task fields (title, blocker_summary, success_predicate, progress_summary). Length
// bounds already existed (see the [key, max, nullable] table below) but any byte was
// previously accepted within that bound. Tab/newline/CR are left alone -- normal, expected
// in multi-line summary text -- everything else in the C0 control range plus DEL is refused
// outright rather than silently accepted (this is a transport-boundary rejection, distinct
// from src/agents/sensorium.ts's asData(), which strips control chars at RENDER time for a
// different, already-trusted-local-task, surface).
const DISALLOWED_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

function hasDisallowedControlChars(value: string): boolean {
  return DISALLOWED_CONTROL_CHARS.test(value)
}

// #404 re-gate defense-in-depth: title-SPECIFIC hardening, tighter than the
// general control-char check above. task.title has no legitimate multi-line use
// (unlike blocker_summary/progress_summary, which are prose) and title is what
// src/addons/project-link/service.ts stamps verbatim into `tasks.title` as
// `[project-link:<pot>] <title>` -- a highly visible, widely-read field (task
// lists, GitHub mirror, dashboard). Reject tab/newline/CR (the newline-injection
// vector: a title with an embedded newline can forge what looks like a second
// line once interpolated anywhere) and the bidi mark/embedding/override/isolate
// block (LRM/RLM, LRE/RLE/PDF/LRO/RLO incl. U+202E RIGHT-TO-LEFT OVERRIDE,
// LRI/RLI/FSI/PDI -- can visually reverse/hide text in a title). This is
// belt-and-suspenders: src/agents/execute.ts's buildExecutePrompt fences title
// through asData() (../../lib/prompt-safety) regardless, but a title rejected
// HERE never reaches storage/display anywhere else in the product surface either
// (dashboard, GitHub mirror, MCP reads) -- reject-at-the-edge beats
// sanitize-at-every-reader.
// Bidi/line-separator ranges built from numeric code points (not pasted glyphs)
// so this source file stays plain ASCII and diffable:
//   0x2028-0x2029   LINE SEPARATOR, PARAGRAPH SEPARATOR
//   0x200E-0x200F   LRM, RLM (bidi marks)
//   0x202A-0x202E   LRE/RLE/PDF/LRO/RLO bidi embed/override (incl. U+202E
//                   RIGHT-TO-LEFT OVERRIDE, the 'reversed filename' trick)
//   0x2066-0x2069   LRI/RLI/FSI/PDI bidi isolates
const TITLE_UNSAFE_CODEPOINT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x2028, 0x2029],
  [0x200e, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
]

function titleHex4(n: number): string {
  return n.toString(16).padStart(4, '0')
}

function buildTitleDisallowedCharsRegex(): RegExp {
  const unicodeBody = TITLE_UNSAFE_CODEPOINT_RANGES.map(([lo, hi]) =>
    lo === hi ? `\\u${titleHex4(lo)}` : `\\u${titleHex4(lo)}-\\u${titleHex4(hi)}`,
  ).join('')
  return new RegExp(`[\\t\\n\\r${unicodeBody}]`)
}

const TITLE_DISALLOWED_CHARS = buildTitleDisallowedCharsRegex()

function hasDisallowedTitleChars(value: string): boolean {
  return TITLE_DISALLOWED_CHARS.test(value)
}

function checkTitleText(value: unknown, path: string, max: number): EnvelopeValidationResult | null {
  if (!boundedText(value, max)) return { ok: false, reason: 'invalid_string', path }
  if (sensitive(value)) return { ok: false, reason: 'prohibited_content', path }
  if (hasDisallowedControlChars(value)) return { ok: false, reason: 'invalid_control_chars', path }
  if (hasDisallowedTitleChars(value)) return { ok: false, reason: 'invalid_title_chars', path }
  return null
}

function prohibitedString(value: unknown, path = '', seen = new WeakSet<object>()): EnvelopeValidationResult | null {
  if (typeof value === 'string') {
    return sensitive(value) ? { ok: false, reason: 'prohibited_content', path } : null
  }
  if (typeof value !== 'object' || value === null) return null
  if (seen.has(value)) return null
  seen.add(value)
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const error = prohibitedString(value[index], `${path}[${index}]`, seen)
      if (error) return error
    }
    return null
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key
    const error = prohibitedString(child, childPath, seen)
    if (error) return error
  }
  return null
}

function checkText(value: unknown, path: string, max: number, nullable = false): EnvelopeValidationResult | null {
  if (nullable && value === null) return null
  if (!boundedText(value, max)) return { ok: false, reason: 'invalid_string', path }
  if (sensitive(value)) return { ok: false, reason: 'prohibited_content', path }
  if (hasDisallowedControlChars(value)) return { ok: false, reason: 'invalid_control_chars', path }
  return null
}

function normalizeApprovedOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || url.pathname !== '/' || value.trim() !== value || sensitive(value)
    ) return null
    return url.origin
  } catch {
    return null
  }
}

function checkUrl(
  value: unknown,
  path: string,
  approvedOrigins: readonly string[] | undefined,
): EnvelopeValidationResult | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > 2048 || value.trim() !== value) return { ok: false, reason: 'invalid_url', path }
  if (sensitive(value)) return { ok: false, reason: 'prohibited_content', path }
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      return { ok: false, reason: 'invalid_url', path }
    }
    let decodedPath = url.pathname
    let converged = false
    for (let pass = 0; pass < MAX_URL_PATH_DECODE_PASSES; pass += 1) {
      const decoded = decodeURIComponent(decodedPath)
      if (decoded === decodedPath) {
        converged = true
        break
      }
      decodedPath = decoded
    }
    if (!converged && decodeURIComponent(decodedPath) !== decodedPath) {
      return { ok: false, reason: 'invalid_url', path }
    }
    if (sensitive(decodedPath)) return { ok: false, reason: 'prohibited_content', path }
    if (approvedOrigins !== undefined) {
      const normalized = approvedOrigins.map(normalizeApprovedOrigin)
      if (normalized.some((origin) => origin === null)) {
        return { ok: false, reason: 'invalid_approved_origin', path }
      }
      if (!normalized.includes(url.origin)) return { ok: false, reason: 'unapproved_origin', path }
    }
  } catch {
    return { ok: false, reason: 'invalid_url', path }
  }
  return null
}

export function validateProjectLinkEnvelope(
  value: unknown,
  options: ProjectLinkEnvelopeValidationOptions = {},
): EnvelopeValidationResult {
  const top = exactKeys(value, PROJECT_LINK_ENVELOPE_FIELDS, '')
  if (top) return top
  const prohibitedName = prohibitedFieldName(value)
  if (prohibitedName) return prohibitedName
  const prohibited = prohibitedString(value)
  if (prohibited) return prohibited
  const envelope = value as Record<string, unknown>
  if (envelope.schema !== PROJECT_LINK_ENVELOPE_SCHEMA) return { ok: false, reason: 'invalid_schema', path: 'schema' }

  const sourceError = exactKeys(envelope.source, PROJECT_LINK_SOURCE_FIELDS, 'source')
  if (sourceError) return sourceError
  const source = envelope.source as Record<string, unknown>
  for (const key of PROJECT_LINK_SOURCE_FIELDS) {
    if (!validId(source[key])) return { ok: false, reason: 'invalid_id', path: `source.${key}` }
  }

  const destinationError = exactKeys(envelope.destination, PROJECT_LINK_DESTINATION_FIELDS, 'destination')
  if (destinationError) return destinationError
  const destination = envelope.destination as Record<string, unknown>
  for (const key of PROJECT_LINK_DESTINATION_FIELDS) {
    if (!validId(destination[key])) return { ok: false, reason: 'invalid_id', path: `destination.${key}` }
  }

  if (!validId(envelope.correlation_id)) return { ok: false, reason: 'invalid_id', path: 'correlation_id' }
  if (!validId(envelope.idempotency_key)) return { ok: false, reason: 'invalid_id', path: 'idempotency_key' }
  if (!CAPABILITIES.includes(envelope.requested_capability as ProjectLinkCapability)) {
    return { ok: false, reason: 'invalid_capability', path: 'requested_capability' }
  }
  if (!validIso(envelope.expires_at)) return { ok: false, reason: 'invalid_timestamp', path: 'expires_at' }

  if (envelope.task !== null) {
    const taskError = exactKeys(envelope.task, PROJECT_LINK_TASK_FIELDS, 'task')
    if (taskError) return taskError
    const task = envelope.task as Record<string, unknown>
    if (!validId(task.source_task_id)) return { ok: false, reason: 'invalid_id', path: 'task.source_task_id' }
    for (const key of ['flight_id', 'request_id'] as const) {
      if (task[key] !== null && !validId(task[key])) return { ok: false, reason: 'invalid_id', path: `task.${key}` }
    }
    // title goes through checkTitleText (tighter than checkText -- rejects
    // newline/CR/tab + bidi overrides; see TITLE_DISALLOWED_CHARS above). The
    // other free-text fields keep checkText's general control-char bound only
    // -- they are prose with a legitimate multi-line use.
    const titleError = checkTitleText(task.title, 'task.title', 240)
    if (titleError) return titleError
    for (const [key, max, nullable] of [
      ['blocker_summary', 1000, true],
      ['success_predicate', 2000, false], ['progress_summary', 4000, false],
    ] as const) {
      const error = checkText(task[key], `task.${key}`, max, nullable)
      if (error) return error
    }
    if (!TASK_STATES.includes(task.state as ProjectLinkTaskState)) return { ok: false, reason: 'invalid_state', path: 'task.state' }
    if (!PRIORITIES.includes(task.priority as ProjectLinkPriority)) return { ok: false, reason: 'invalid_priority', path: 'task.priority' }
  }

  if (envelope.evidence !== null) {
    const evidenceError = exactKeys(envelope.evidence, PROJECT_LINK_EVIDENCE_FIELDS, 'evidence')
    if (evidenceError) return evidenceError
    const evidence = envelope.evidence as Record<string, unknown>
    if (typeof evidence.sha256 !== 'string' || !SHA256.test(evidence.sha256)) return { ok: false, reason: 'invalid_sha256', path: 'evidence.sha256' }
    if (!MEDIA_TYPES.includes(evidence.media_type as ProjectLinkEvidenceMediaType)) return { ok: false, reason: 'invalid_media_type', path: 'evidence.media_type' }
    if (!validIso(evidence.occurred_at)) return { ok: false, reason: 'invalid_timestamp', path: 'evidence.occurred_at' }
    const urlError = checkUrl(evidence.url, 'evidence.url', options.approvedEvidenceOrigins)
    if (urlError) return urlError
  }

  if (envelope.requested_capability === 'project.task.write' && envelope.task === null) {
    return { ok: false, reason: 'task_required', path: 'task' }
  }
  if (envelope.requested_capability === 'project.evidence.write' && envelope.evidence === null) {
    return { ok: false, reason: 'evidence_required', path: 'evidence' }
  }
  const task = envelope.task as Record<string, unknown> | null
  const evidence = envelope.evidence as Record<string, unknown> | null
  return {
    ok: true,
    envelope: {
      schema: PROJECT_LINK_ENVELOPE_SCHEMA,
      source: {
        pot: source.pot as string,
        project_id: source.project_id as string,
        agent_id: source.agent_id as string,
        key_id: source.key_id as string,
      },
      destination: {
        pot: destination.pot as string,
        project_id: destination.project_id as string,
      },
      correlation_id: envelope.correlation_id as string,
      idempotency_key: envelope.idempotency_key as string,
      requested_capability: envelope.requested_capability as ProjectLinkCapability,
      expires_at: envelope.expires_at as string,
      task: task === null ? null : {
        source_task_id: task.source_task_id as string,
        flight_id: task.flight_id as string | null,
        request_id: task.request_id as string | null,
        title: task.title as string,
        state: task.state as ProjectLinkTaskState,
        priority: task.priority as ProjectLinkPriority,
        blocker_summary: task.blocker_summary as string | null,
        success_predicate: task.success_predicate as string,
        progress_summary: task.progress_summary as string,
      },
      evidence: evidence === null ? null : {
        sha256: evidence.sha256 as string,
        media_type: evidence.media_type as ProjectLinkEvidenceMediaType,
        occurred_at: evidence.occurred_at as string,
        url: evidence.url as string | null,
      },
    },
  }
}

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError('canonical_json_invalid_unicode')
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError('canonical_json_invalid_unicode')
    }
  }
}

export function canonicalJson(value: unknown): string {
  const stack = new WeakSet<object>()
  const encode = (item: unknown): string => {
    if (item === null) return 'null'
    if (typeof item === 'string') {
      assertUnicodeScalarString(item)
      return JSON.stringify(item)
    }
    if (typeof item === 'boolean') return item ? 'true' : 'false'
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError('canonical_json_non_finite_number')
      return JSON.stringify(item)
    }
    if (typeof item !== 'object') throw new TypeError('canonical_json_unsupported_value')
    if (stack.has(item)) throw new TypeError('canonical_json_cycle')
    stack.add(item)
    try {
      if (Array.isArray(item)) {
        const entries: string[] = []
        for (let index = 0; index < item.length; index += 1) {
          if (!Object.hasOwn(item, index)) throw new TypeError('canonical_json_unsupported_value')
          entries.push(encode(item[index]))
        }
        return `[${entries.join(',')}]`
      }
      const prototype = Object.getPrototypeOf(item)
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError('canonical_json_unsupported_value')
      const record = item as Record<string, unknown>
      const entries = Object.keys(record).sort().map((key) => {
        assertUnicodeScalarString(key)
        return `${JSON.stringify(key)}:${encode(record[key])}`
      })
      return `{${entries.join(',')}}`
    } finally {
      stack.delete(item)
    }
  }
  return encode(value)
}

export function canonicalProjectLinkArtifact(domain: string, value: unknown): string {
  if (!CANONICAL_DOMAIN.test(domain)) throw new TypeError('invalid_project_link_canonical_domain')
  return `${CANONICAL_PREFIX}\0${domain}\0${canonicalJson(value)}`
}

export function canonicalDomainSeparatedBytes(domain: string, value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalProjectLinkArtifact(domain, value))
}

export function canonicalProjectLinkEnvelope(envelope: ProjectLinkEnvelopeV1): string {
  return canonicalProjectLinkArtifact(PROJECT_LINK_ENVELOPE_SIGNATURE_DOMAIN, envelope)
}

export function canonicalProjectLinkEnvelopeSigningBytes(envelope: ProjectLinkEnvelopeV1): Uint8Array {
  return new TextEncoder().encode(canonicalProjectLinkEnvelope(envelope))
}

function b64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function fromB64url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
    const binary = atob(padded)
    return Uint8Array.from(binary, (char) => char.charCodeAt(0))
  } catch {
    return null
  }
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function generateProjectLinkKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as Promise<CryptoKeyPair>
}

export async function exportProjectLinkPublicKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key)
  if (!(raw instanceof ArrayBuffer)) throw new Error('invalid_project_link_public_key')
  return b64url(new Uint8Array(raw))
}

export async function importProjectLinkPublicKey(value: string): Promise<CryptoKey> {
  const bytes = fromB64url(value)
  if (!bytes || bytes.byteLength !== 32) throw new Error('invalid_project_link_public_key')
  return crypto.subtle.importKey('raw', bytes, { name: 'Ed25519' }, false, ['verify'])
}

export async function createSignedProjectEnvelope(
  input: Omit<ProjectLinkEnvelopeV1, 'schema'>,
  privateKey: CryptoKey,
  options: ProjectLinkEnvelopeValidationOptions = {},
): Promise<SignedProjectLinkEnvelopeV1> {
  const validation = validateProjectLinkEnvelope({ schema: PROJECT_LINK_ENVELOPE_SCHEMA, ...input }, options)
  if (!validation.ok) throw new Error(`invalid_project_link_envelope:${validation.reason}:${validation.path}`)
  const bytes = canonicalProjectLinkEnvelopeSigningBytes(validation.envelope)
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, bytes))
  return { envelope: validation.envelope, signature: b64url(signature) }
}

export async function verifySignedProjectEnvelope(
  value: unknown,
  publicKey: CryptoKey,
  options: ProjectLinkEnvelopeValidationOptions = {},
): Promise<{ ok: true; envelope: ProjectLinkEnvelopeV1 } | { ok: false; reason: string; path?: string }> {
  const wrapper = exactKeys(value, ['envelope', 'signature'], '')
  if (wrapper) return wrapper
  const record = value as Record<string, unknown>
  if (typeof record.signature !== 'string') return { ok: false, reason: 'invalid_signature' }
  const signature = fromB64url(record.signature)
  if (!signature || signature.byteLength !== 64) return { ok: false, reason: 'invalid_signature' }
  const validation = validateProjectLinkEnvelope(record.envelope, options)
  if (!validation.ok) return validation
  const valid = await crypto.subtle.verify(
    { name: 'Ed25519' }, publicKey, signature,
    canonicalProjectLinkEnvelopeSigningBytes(validation.envelope),
  )
  return valid ? { ok: true, envelope: validation.envelope } : { ok: false, reason: 'invalid_signature' }
}
