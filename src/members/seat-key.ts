// mupot#1794 W1 — the seat WORKSPACE KEY: server-side normalisation + canonical string + hash.
//
// A seat is identified by (tenant, member, harness, key). The key is built ONLY from the caller's
// args, but the caller never gets to choose the canonical form: every component is normalised
// here, on the server, so two spellings of the same workspace collapse to ONE key (idempotent
// find-or-create) and two genuinely different workspaces never collapse (no seat takeover by
// aliasing). The key is a LABEL-derived identifier, never authority.
//
// Rules (v1):
//   * every text component: Unicode NFC, trim, whitespace runs -> one space, control characters
//     REJECTED (not stripped — silently dropping a char could merge two distinct inputs), a safe
//     charset, a length cap. '%' and other URL-escape carriers are outside the charset, so there
//     is no percent-decoding ambiguity (a%2e%2e/b never aliases a/../b).
//   * project / squad: case-insensitive (lowercased). thread / folder: case-preserving
//     (a case-sensitive filesystem has distinct 'A' and 'a').
//   * folder: backslash -> '/', '//' collapsed, '.' and '..' resolved LEXICALLY (no filesystem
//     access), trailing '/' stripped. '..' above an absolute root clamps at the root (POSIX); a
//     relative folder that climbs above its own start is refused rather than guessed at.
//   * the canonical string is NUL/newline-free and field-tagged, so no field value can forge a
//     neighbouring field.
//   * key_hash = sha256(member_id + 0x1f + canonical). The canonical string embeds the harness id,
//     so the same folder under a different harness, or under a different human, hashes apart.
//   * Only the hash and a short basename label are ever stored. A full path is never persisted.

export const SEAT_KEY_VERSION = 'v1'

const MAX_COMPONENT = 200
const MAX_FOLDER = 512
const MAX_LABEL = 64

export interface SeatKeyArgs {
  project: unknown
  folder?: unknown
  thread?: unknown
  squad?: unknown
}

export interface NormalizedSeatKey {
  project: string
  squad: string
  folder: string
  thread: string
  /** Short human label: last folder segment, else the project. Never a full path. */
  labelBasename: string
}

export type SeatKeyError =
  | 'project_required'
  | 'invalid_component'
  | 'component_too_long'
  | 'folder_escapes_root'

export type SeatKeyResult =
  | { ok: true; key: NormalizedSeatKey }
  | { ok: false; error: SeatKeyError; field: string }

// Letters/numbers (any script), and a small set of path/label punctuation. No control chars,
// no '%', no quotes, no angle brackets, no backslash (folder backslashes are rewritten first).
const SAFE_TEXT = /^[\p{L}\p{N}\p{M}._\-\/ @+:#~()\[\],=]+$/u
// eslint-disable-next-line no-control-regex -- detecting C0/C1 controls and DEL is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

function cleanText(raw: unknown): { ok: true; value: string } | { ok: false; error: 'invalid_component' } {
  if (raw === undefined || raw === null) return { ok: true, value: '' }
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_component' }
  if (CONTROL.test(raw)) return { ok: false, error: 'invalid_component' }
  const value = raw.normalize('NFC').trim().replace(/[ ]+/g, ' ')
  if (value.length === 0) return { ok: true, value: '' }
  if (!SAFE_TEXT.test(value)) return { ok: false, error: 'invalid_component' }
  return { ok: true, value }
}

/** Lexical folder normalisation. Returns null when a relative path climbs above its start. */
export function normalizeFolderPath(input: string): string | null {
  const slashed = input.replace(/\\/g, '/')
  const absolute = slashed.startsWith('/')
  const out: string[] = []
  for (const seg of slashed.split('/')) {
    const part = seg.trim()
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') {
        out.pop()
      } else if (absolute) {
        // '/..' is '/' (POSIX): clamp at the root.
      } else {
        return null
      }
      continue
    }
    out.push(part)
  }
  const joined = out.join('/')
  return absolute ? `/${joined}` : joined
}

export function normalizeSeatKey(args: SeatKeyArgs): SeatKeyResult {
  const project = cleanText(args.project)
  if (!project.ok) return { ok: false, error: project.error, field: 'project' }
  if (project.value === '') return { ok: false, error: 'project_required', field: 'project' }
  if (project.value.length > MAX_COMPONENT) return { ok: false, error: 'component_too_long', field: 'project' }

  const squad = cleanText(args.squad)
  if (!squad.ok) return { ok: false, error: squad.error, field: 'squad' }
  if (squad.value.length > MAX_COMPONENT) return { ok: false, error: 'component_too_long', field: 'squad' }

  const thread = cleanText(args.thread)
  if (!thread.ok) return { ok: false, error: thread.error, field: 'thread' }
  if (thread.value.length > MAX_COMPONENT) return { ok: false, error: 'component_too_long', field: 'thread' }

  // Folder: rewrite backslashes BEFORE the charset check (a Windows path is legitimate input),
  // then normalise lexically.
  let folder = ''
  if (args.folder !== undefined && args.folder !== null) {
    if (typeof args.folder !== 'string') return { ok: false, error: 'invalid_component', field: 'folder' }
    if (CONTROL.test(args.folder)) return { ok: false, error: 'invalid_component', field: 'folder' }
    const rawFolder = args.folder.normalize('NFC').trim().replace(/\\/g, '/')
    if (rawFolder.length > MAX_FOLDER) return { ok: false, error: 'component_too_long', field: 'folder' }
    if (rawFolder.length > 0) {
      if (!SAFE_TEXT.test(rawFolder)) return { ok: false, error: 'invalid_component', field: 'folder' }
      const normal = normalizeFolderPath(rawFolder)
      if (normal === null) return { ok: false, error: 'folder_escapes_root', field: 'folder' }
      folder = normal
    }
  }

  const lastSegment = folder.split('/').filter((p) => p.length > 0).pop() ?? ''
  const labelBasename = (lastSegment || project.value).slice(0, MAX_LABEL)

  return {
    ok: true,
    key: {
      project: project.value.toLowerCase(),
      squad: squad.value.toLowerCase(),
      folder,
      thread: thread.value,
      labelBasename,
    },
  }
}

/** The v1 canonical string. Field-tagged, newline-separated; no component can contain a newline
 *  (controls are rejected upstream), so no value can forge a sibling field. */
export function canonicalSeatKeyString(harnessId: string, key: NormalizedSeatKey): string {
  return [
    `seat-key:${SEAT_KEY_VERSION}`,
    `harness=${harnessId}`,
    `project=${key.project}`,
    `squad=${key.squad}`,
    `folder=${key.folder}`,
    `thread=${key.thread}`,
  ].join('\n')
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  let out = ''
  for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, '0')
  return out
}

/** sha256(member_id 0x1f canonical). The member id is mixed in so the same workspace under a
 *  different human can never share a hash (and so a hash alone is not a cross-human handle). */
export async function seatKeyHash(memberId: string, harnessId: string, key: NormalizedSeatKey): Promise<string> {
  return sha256Hex(`${memberId}\u001f${canonicalSeatKeyString(harnessId, key)}`)
}
