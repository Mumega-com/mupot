import { isAbsolute } from 'node:path'

export const AGENT_PROFILE_SCHEMA = 'mupot.agent-profile/v1'

const PROFILE_KEYS = Object.freeze([
  'schema',
  'agent_id',
  'adapter',
  'command',
  'allowed_senders',
  'run_for',
  'timeout_ms',
])
const ADAPTERS = new Set(['hermes', 'codex', 'claude-code', 'generic'])
const MESSAGE_KINDS = new Set(['message', 'request'])
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const SECRET_RE = /Bearer\s+\S+|\bmupot_[A-Za-z0-9_-]+\b|(?:authorization|token|private_key|secret)\s*[:=]/i

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value).sort()
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index])
}

function uniqueRefs(values, { min = 1, max = 64 } = {}) {
  if (!Array.isArray(values) || values.length < min || values.length > max) return null
  if (values.some((value) => typeof value !== 'string' || !REF_RE.test(value) || value === '*')) return null
  return new Set(values).size === values.length ? values.slice() : null
}

function commandArgv(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) return null
  if (value.some((part) => typeof part !== 'string' || part.length < 1 || part.length > 2048 || part.includes('\0'))) return null
  if (!isAbsolute(value[0]) || value.some((part) => SECRET_RE.test(part))) return null
  return value.slice()
}

export function normalizeAgentProfile(raw) {
  if (!exactKeys(raw, PROFILE_KEYS)) return null
  if (raw.schema !== AGENT_PROFILE_SCHEMA || !REF_RE.test(raw.agent_id ?? '')) return null
  if (!ADAPTERS.has(raw.adapter)) return null
  const command = commandArgv(raw.command)
  const allowedSenders = uniqueRefs(raw.allowed_senders)
  const runFor = uniqueRefs(raw.run_for, { min: 1, max: 2 })
  if (!command || !allowedSenders || !runFor || runFor.some((kind) => !MESSAGE_KINDS.has(kind))) return null
  if (!Number.isInteger(raw.timeout_ms) || raw.timeout_ms < 1000 || raw.timeout_ms > 600000) return null
  return {
    schema: AGENT_PROFILE_SCHEMA,
    agent_id: raw.agent_id,
    adapter: raw.adapter,
    command,
    allowed_senders: allowedSenders,
    run_for: runFor,
    timeout_ms: raw.timeout_ms,
  }
}

export function validateAgentProfile(raw) {
  const profile = normalizeAgentProfile(raw)
  if (!profile) throw new TypeError('invalid agent profile contract')
  return profile
}
