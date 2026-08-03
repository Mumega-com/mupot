import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'

/**
 * Design-status contract policy (#603 / rework of #604).
 *
 * Rule:
 * - Contract-like JSON objects (`id` + `status` strings) with
 *   `status: "design"` are allowed only in an explicit design-only location
 *   or with the approved machine-readable marker.
 * - Runtime/release registry paths must never carry `status: "design"`.
 * - Array/map/id-keyed registries and arbitrary single-wrapper maps are
 *   inspected; unrecognized contract-like ids hard-fail on runtime/release
 *   paths only; unreadable (symlink/non-UTF-8) and unparseable JSON are
 *   reported (never silently skipped).
 *
 * Allowed design locations/markers:
 * - path under `docs/design-contracts/`
 * - top-level `"designOnly": true` on the contract object
 *
 * Nested `status` fields (e.g. unmetDependencies) are ignored — only
 * root-level contract objects and registry entries are policy-relevant.
 */

const CONTRACT_ID_PATTERN = /^[a-z][a-z0-9-]*\/v[0-9]+$/
const DESIGN_STATUS = 'design'
const DESIGN_ONLY_DIR = 'docs/design-contracts/'
const DESIGN_ONLY_MARKER = 'designOnly'

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
  return contract[DESIGN_ONLY_MARKER] === true
}

function formatRuntimeViolation(path, contractId) {
  return [
    `${displayPath(path)}: contract '${contractId}' has status '${DESIGN_STATUS}' in a runtime/release registry path.`,
    `  Runtime/release paths (${RUNTIME_HELP}) must not contain status '${DESIGN_STATUS}'.`,
    `  Remediation: remove this contract from the registry, or change status after implementation/gate evidence lands.`,
  ].join('\n')
}

function formatUnauthorizedDesignViolation(path, contractId) {
  return [
    `${displayPath(path)}: contract '${contractId}' has status '${DESIGN_STATUS}' but is not explicitly design-only.`,
    `  Allowed locations/markers: ${ALLOWED_LOCATIONS_HELP}.`,
    `  Remediation: move to ${DESIGN_ONLY_DIR} or set "${DESIGN_ONLY_MARKER}": true; promote status before shipping in runtime/release registries.`,
  ].join('\n')
}

function formatUnrecognizedContract(path, contractId) {
  return [
    `${displayPath(path)}: unrecognized contract-like object with id '${contractId}'.`,
    `  Expected id matching ${CONTRACT_ID_PATTERN}.`,
    `  Remediation: fix the contract id shape, or remove id/status if this JSON is not a contract.`,
  ].join('\n')
}

function formatUnparseableJson(path, detail) {
  return [
    `${displayPath(path)}: unparseable JSON (${detail}).`,
    `  Tracked .json files must parse; silent skip is not allowed.`,
  ].join('\n')
}

function formatUnreadableJson(path, detail) {
  return [
    `${displayPath(path)}: unreadable tracked JSON (${detail}).`,
    `  Tracked .json files must be regular UTF-8 files; silent skip is not allowed.`,
  ].join('\n')
}

function evaluateContract(path, contract) {
  if (contract.status !== DESIGN_STATUS) return null

  if (isRuntimeOrReleasePath(path)) {
    return formatRuntimeViolation(path, contract.id)
  }

  if (isDesignOnlyLocation(path) || hasDesignOnlyMarker(contract)) {
    return null
  }

  return formatUnauthorizedDesignViolation(path, contract.id)
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

function scanFile(path, text) {
  if (!normalizePath(path).endsWith('.json')) return []

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return [formatUnparseableJson(path, detail)]
  }

  const findings = []
  for (const contract of collectContractLikes(parsed)) {
    if (!hasValidContractId(contract)) {
      // Ordinary fixtures often use id+status shapes; only hard-fail on
      // runtime/release paths where a bad contract id is policy-relevant.
      if (isRuntimeOrReleasePath(path)) {
        findings.push(formatUnrecognizedContract(path, contract.id))
      }
      continue
    }

    const finding = evaluateContract(path, contract)
    if (finding !== null) findings.push(finding)
  }

  return findings
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

function scan(root) {
  const findings = []

  for (const path of trackedFiles(root)) {
    if (!normalizePath(path).endsWith('.json')) continue

    const absolutePath = resolve(root, path)
    const read = readTrackedText(absolutePath)
    if (read.kind === 'missing') continue
    if (read.kind === 'error') {
      findings.push(formatUnreadableJson(path, read.detail))
      continue
    }

    findings.push(...scanFile(path, read.text))
  }

  return findings
}

try {
  const root = parseRoot(process.argv.slice(2))
  const findings = scan(root)
  if (findings.length > 0) {
    for (const finding of findings) console.error(finding)
    console.error(`design-status policy violations: ${findings.length}`)
    process.exitCode = 1
  } else {
    console.log('design-status contract policy: ok')
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`design-status contract policy failed: ${message}`)
  process.exitCode = 2
}
