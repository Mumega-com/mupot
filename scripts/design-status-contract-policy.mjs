import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { minimatch } from 'minimatch'

/**
 * Design-status contract policy (#603 / rework of #604; round 4 decision table).
 *
 * Decision table (strict recognizer for HARD failures; loose shape for WARNINGS):
 * (1) Contract recognition = id matches CONTRACT_ID_PATTERN.
 *     Recognized contracts on runtime paths fail iff normalize(status) starts
 *     with "design" (normalize = trim + casefold). Elsewhere, recognized
 *     design-status contracts pass only with designOnly location/marker.
 * (2) id+status shape whose id does NOT match the pattern = WARNING on
 *     runtime paths (printed, exit 0), silent elsewhere — never a hard fail.
 * (3) Unparseable JSON: known-JSONC basenames and .design-status-ignore
 *     matches are skipped with a note; other unparseable on runtime = hard
 *     fail, elsewhere = warning.
 * (4) Symlinks / non-UTF-8 stay reported as hard findings (round 3).
 */

const CONTRACT_ID_PATTERN = /^[a-z][a-z0-9-]*\/v[0-9]+$/
const DESIGN_STATUS_PREFIX = 'design'
const DESIGN_ONLY_DIR = 'docs/design-contracts/'
const DESIGN_ONLY_MARKER = 'designOnly'
const IGNORE_FILE = '.design-status-ignore'

/** Path segments that mark a runtime/release tree at any depth. */
const RUNTIME_RELEASE_SEGMENTS = new Set([
  'src',
  'fleet-runtime',
  'plugin',
  'packs',
  'deploy',
  'connectors',
])

/** Basename files that are always runtime/release registries. */
const RUNTIME_RELEASE_FILES = new Set(['pots.manifest.json'])

const ALLOWED_LOCATIONS_HELP =
  'docs/design-contracts/** or top-level "designOnly": true'

const RUNTIME_HELP =
  'any-depth src/, fleet-runtime/, plugin/, packs/, deploy/, connectors/, docs/releases/, or pots.manifest.json'

function parseRoot(args) {
  if (args.length === 0) return process.cwd()
  if (args.length === 2 && args[0] === '--root' && args[1]) return resolve(args[1])
  throw new Error('usage: node scripts/design-status-contract-policy.mjs [--root <repository>]')
}

function trackedFiles(root) {
  const output = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached'], {
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return output.toString('utf8').split('\0').filter(Boolean)
}

function decodeText(buffer) {
  if (buffer.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return null
  }
}

function displayPath(path) {
  return path.replaceAll('\r', '\\r').replaceAll('\n', '\\n')
}

function normalizePath(path) {
  return path.replaceAll('\\', '/')
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isContractLike(value) {
  return isPlainObject(value) && typeof value.id === 'string' && typeof value.status === 'string'
}

function hasValidContractId(contract) {
  return CONTRACT_ID_PATTERN.test(contract.id)
}

function normalizeStatus(status) {
  return status.trim().toLowerCase()
}

function isDesignStatus(status) {
  return normalizeStatus(status).startsWith(DESIGN_STATUS_PREFIX)
}

function isRuntimeOrReleasePath(path) {
  const normalized = normalizePath(path)
  const parts = normalized.split('/').filter((part) => part.length > 0)
  if (parts.length === 0) return false

  if (RUNTIME_RELEASE_FILES.has(basename(normalized))) return true

  for (let index = 0; index < parts.length - 1; index += 1) {
    if (parts[index] === 'docs' && parts[index + 1] === 'releases') return true
  }

  return parts.some((part) => RUNTIME_RELEASE_SEGMENTS.has(part))
}

function isDesignOnlyLocation(path) {
  return normalizePath(path).startsWith(DESIGN_ONLY_DIR)
}

function hasDesignOnlyMarker(contract) {
  // Boolean true only — a string such as "design-only" is not a marker and
  // must not authorize (or invent) design status.
  return contract[DESIGN_ONLY_MARKER] === true
}

function isKnownJsoncPath(path) {
  const normalized = normalizePath(path)
  const base = basename(normalized)
  if (base.endsWith('.jsonc')) return true
  if (minimatch(base, 'tsconfig*.json', { dot: true })) return true
  if (normalized === '.vscode' || normalized.startsWith('.vscode/')) return true
  if (normalized.includes('/.vscode/')) return true
  if (normalized === '.devcontainer' || normalized.startsWith('.devcontainer/')) return true
  if (normalized.includes('/.devcontainer/')) return true
  return false
}

/**
 * Minimal gitignore-style matcher for .design-status-ignore.
 * Supports comments, negation (!), rooted (/) patterns, directory trailing /,
 * and unanchored basenames matching at any depth.
 */
function parseIgnoreRules(text) {
  const rules = []
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (line.trim().length === 0) continue
    if (line.startsWith('#')) continue

    let negated = false
    if (line.startsWith('!')) {
      negated = true
      line = line.slice(1)
    }

    if (!line.endsWith('\\')) {
      line = line.replace(/[ \t]+$/u, '')
    } else {
      line = line.slice(0, -1) + ' '
    }

    if (line.length === 0) continue
    rules.push({ negated, pattern: line })
  }
  return rules
}

function pathMatchesGitignorePattern(filePath, pattern) {
  const normalized = normalizePath(filePath)
  let pat = pattern
  const directoryOnly = pat.endsWith('/')
  if (directoryOnly) pat = pat.slice(0, -1)

  const matchOptions = { dot: true, nocomment: true, nonegate: true }
  const candidates = []

  if (pat.startsWith('/')) {
    const rooted = pat.slice(1)
    candidates.push(rooted)
    if (directoryOnly) candidates.push(`${rooted}/**`)
  } else if (!pat.includes('/')) {
    candidates.push(pat)
    candidates.push(`**/${pat}`)
    if (directoryOnly) {
      candidates.push(`${pat}/**`)
      candidates.push(`**/${pat}/**`)
    }
  } else {
    candidates.push(pat)
    candidates.push(`**/${pat}`)
    if (directoryOnly) {
      candidates.push(`${pat}/**`)
      candidates.push(`**/${pat}/**`)
    }
  }

  return candidates.some((candidate) => minimatch(normalized, candidate, matchOptions))
}

function isIgnoredByRules(path, rules) {
  let ignored = false
  for (const rule of rules) {
    if (pathMatchesGitignorePattern(path, rule.pattern)) {
      ignored = !rule.negated
    }
  }
  return ignored
}

function loadIgnoreRules(root) {
  const absolutePath = resolve(root, IGNORE_FILE)
  if (!existsSync(absolutePath)) return []
  return parseIgnoreRules(readFileSync(absolutePath, 'utf8'))
}

function formatRuntimeViolation(path, contractId, status) {
  return [
    `${displayPath(path)}: contract '${contractId}' has status '${status}' in a runtime/release registry path.`,
    `  Runtime/release paths (${RUNTIME_HELP}) must not contain status starting with '${DESIGN_STATUS_PREFIX}'.`,
    `  Remediation: remove this contract from the registry, or change status after implementation/gate evidence lands.`,
  ].join('\n')
}

function formatUnauthorizedDesignViolation(path, contractId, status) {
  return [
    `${displayPath(path)}: contract '${contractId}' has status '${status}' but is not explicitly design-only.`,
    `  Allowed locations/markers: ${ALLOWED_LOCATIONS_HELP}.`,
    `  Remediation: move to ${DESIGN_ONLY_DIR} or set "${DESIGN_ONLY_MARKER}": true; promote status before shipping in runtime/release registries.`,
  ].join('\n')
}

function formatUnrecognizedContractWarning(path, contractId) {
  return [
    `warning: ${displayPath(path)}: unrecognized contract-like object with id '${contractId}'.`,
    `  Expected id matching ${CONTRACT_ID_PATTERN}.`,
    `  Remediation: fix the contract id shape, or remove id/status if this JSON is not a contract.`,
  ].join('\n')
}

function formatUnparseableJsonFailure(path, detail) {
  return [
    `${displayPath(path)}: unparseable JSON (${detail}).`,
    `  Tracked .json files on runtime/release paths must parse; silent skip is not allowed.`,
  ].join('\n')
}

function formatUnparseableJsonWarning(path, detail) {
  return [
    `warning: ${displayPath(path)}: unparseable JSON (${detail}).`,
    `  Non-runtime tracked .json files should parse; treating as warning.`,
  ].join('\n')
}

function formatUnreadableJson(path, detail) {
  return [
    `${displayPath(path)}: unreadable tracked JSON (${detail}).`,
    `  Tracked .json files must be regular UTF-8 files; silent skip is not allowed.`,
  ].join('\n')
}

function formatJsoncSkipNote(path, detail) {
  return `note: ${displayPath(path)}: skipped known-JSONC (unparseable: ${detail}).`
}

function formatIgnoreSkipNote(path) {
  return `note: ${displayPath(path)}: skipped by ${IGNORE_FILE}.`
}

function evaluateRecognizedContract(path, contract) {
  if (!isDesignStatus(contract.status)) return null

  if (isRuntimeOrReleasePath(path)) {
    return formatRuntimeViolation(path, contract.id, contract.status)
  }

  if (isDesignOnlyLocation(path) || hasDesignOnlyMarker(contract)) {
    return null
  }

  return formatUnauthorizedDesignViolation(path, contract.id, contract.status)
}

/**
 * Collect contract-like objects from:
 * - a single-contract root object
 * - a top-level array registry
 * - an id-keyed / name-keyed top-level map (`{ "x/v1": { id, status } }`)
 * - any single-wrapper key holding an array or map of contract-likes
 *   (`{ "contracts": [...] }`, `{ "registry": { ... } }`, etc.)
 *
 * Does not recurse into nested fields of a contract-like object
 * (e.g. unmetDependencies stay ignored).
 */
function collectContractLikes(parsed) {
  if (Array.isArray(parsed)) {
    return parsed.filter(isContractLike)
  }

  if (!isPlainObject(parsed)) return []

  if (isContractLike(parsed)) return [parsed]

  const collected = []
  for (const value of Object.values(parsed)) {
    if (isContractLike(value)) {
      collected.push(value)
      continue
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (isContractLike(entry)) collected.push(entry)
      }
      continue
    }
    if (isPlainObject(value)) {
      for (const nested of Object.values(value)) {
        if (isContractLike(nested)) collected.push(nested)
      }
    }
  }
  return collected
}

/**
 * @returns {{ failures: string[], warnings: string[], notes: string[] }}
 */
function scanFile(path, text) {
  const empty = { failures: [], warnings: [], notes: [] }
  if (!normalizePath(path).endsWith('.json')) return empty

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (isKnownJsoncPath(path)) {
      return { failures: [], warnings: [], notes: [formatJsoncSkipNote(path, detail)] }
    }
    if (isRuntimeOrReleasePath(path)) {
      return { failures: [formatUnparseableJsonFailure(path, detail)], warnings: [], notes: [] }
    }
    return { failures: [], warnings: [formatUnparseableJsonWarning(path, detail)], notes: [] }
  }

  const failures = []
  const warnings = []
  for (const contract of collectContractLikes(parsed)) {
    if (!hasValidContractId(contract)) {
      // Loose shape-match: warn on runtime paths only; never hard-fail.
      if (isRuntimeOrReleasePath(path)) {
        warnings.push(formatUnrecognizedContractWarning(path, contract.id))
      }
      continue
    }

    const finding = evaluateRecognizedContract(path, contract)
    if (finding !== null) failures.push(finding)
  }

  return { failures, warnings, notes: [] }
}

/**
 * @returns {{ kind: 'missing' } | { kind: 'text', text: string } | { kind: 'error', detail: string }}
 */
function readTrackedText(absolutePath) {
  let stats
  try {
    stats = lstatSync(absolutePath)
  } catch (error) {
    // Staged deletion / missing working-tree file: skip, do not abort the run.
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { kind: 'missing' }
    }
    throw error
  }

  if (stats.isSymbolicLink()) {
    return { kind: 'error', detail: 'symbolic link' }
  }

  if (!stats.isFile()) {
    return { kind: 'error', detail: `not a regular file (mode=${stats.mode})` }
  }

  const text = decodeText(readFileSync(absolutePath))
  if (text === null) {
    return { kind: 'error', detail: 'non-UTF-8 or NUL-containing contents' }
  }

  return { kind: 'text', text }
}

/**
 * @returns {{ failures: string[], warnings: string[], notes: string[] }}
 */
function scan(root) {
  const failures = []
  const warnings = []
  const notes = []
  const ignoreRules = loadIgnoreRules(root)

  for (const path of trackedFiles(root)) {
    if (!normalizePath(path).endsWith('.json')) continue

    if (isIgnoredByRules(path, ignoreRules)) {
      notes.push(formatIgnoreSkipNote(path))
      continue
    }

    const absolutePath = resolve(root, path)
    const read = readTrackedText(absolutePath)
    if (read.kind === 'missing') continue
    if (read.kind === 'error') {
      failures.push(formatUnreadableJson(path, read.detail))
      continue
    }

    const result = scanFile(path, read.text)
    failures.push(...result.failures)
    warnings.push(...result.warnings)
    notes.push(...result.notes)
  }

  return { failures, warnings, notes }
}

try {
  const root = parseRoot(process.argv.slice(2))
  const { failures, warnings, notes } = scan(root)

  for (const note of notes) console.error(note)
  for (const warning of warnings) console.error(warning)

  if (failures.length > 0) {
    for (const finding of failures) console.error(finding)
    console.error(`design-status policy violations: ${failures.length}`)
    process.exitCode = 1
  } else {
    console.log('design-status contract policy: ok')
    process.exitCode = 0
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`design-status contract policy failed: ${message}`)
  process.exitCode = 2
}
