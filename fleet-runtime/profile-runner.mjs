import { spawn } from 'node:child_process'
import { validateAgentProfile } from './profile-contract.mjs'

function runtimeEnv(source = process.env, inheritedEnv = []) {
  const env = {}
  for (const key of [
    'HOME',
    'PATH',
    'TMPDIR',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'HERMES_HOME',
    'HERMES_WRITE_SAFE_ROOT',
    'HERMES_DISABLE_LAZY_INSTALLS',
    'HERMES_LAZY_INSTALL_TARGET',
    'HERMES_WEB_DIST',
    'HERMES_TUI_DIR',
    'PLAYWRIGHT_BROWSERS_PATH',
  ]) {
    if (typeof source[key] === 'string' && source[key]) env[key] = source[key]
  }
  for (const key of inheritedEnv) {
    if (typeof source[key] === 'string' && source[key]) env[key] = source[key]
  }
  return env
}

function validateBatch(profile, batch) {
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) return 'invalid_batch'
  if (batch.agent_id !== profile.agent_id) return 'agent_mismatch'
  if (!Array.isArray(batch.messages) || batch.messages.length < 1 || batch.messages.length > 100) return 'invalid_batch'
  const senders = new Set(profile.allowed_senders)
  const projects = new Set(profile.allowed_project_ids)
  const kinds = new Set(profile.run_for)
  for (const message of batch.messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return 'invalid_batch'
    if (message.kind === 'ack') return 'ack_loop'
    if (!senders.has(message.from_agent)) return 'unauthorized_sender'
    if (typeof message.project_id !== 'string' || !projects.has(message.project_id)) return 'project_denied'
    if (!kinds.has(message.kind)) return 'message_kind_denied'
  }
  return null
}

export function runAgentProfile(rawProfile, batch, options = {}) {
  const profile = validateAgentProfile(rawProfile)
  const invalid = validateBatch(profile, batch)
  if (invalid) return Promise.resolve({ ok: false, reason: invalid })

  const spawnImpl = options.spawnImpl ?? spawn
  return new Promise((resolve) => {
    let settled = false
    let child
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    try {
      child = spawnImpl(profile.command[0], profile.command.slice(1), {
        cwd: typeof options.cwd === 'string' ? options.cwd : undefined,
        env: runtimeEnv(options.env ?? process.env, profile.inherited_env ?? []),
        shell: false,
        detached: true,
        stdio: ['pipe', 'ignore', 'ignore'],
      })
    } catch {
      return resolve({ ok: false, reason: 'spawn_failed' })
    }
    const timer = setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* already exited */ }
      finish({ ok: false, reason: 'timeout' })
    }, profile.timeout_ms)
    child.on('error', () => finish({ ok: false, reason: 'spawn_failed' }))
    child.on('exit', (code) => finish(code === 0
      ? { ok: true, code: 0, activated_messages: batch.messages.length }
      : { ok: false, reason: 'exit_nonzero', code }))
    child.stdin.on('error', () => finish({ ok: false, reason: 'stdin_failed' }))
    try {
      child.stdin.end(JSON.stringify(batch) + '\n')
    } catch {
      finish({ ok: false, reason: 'stdin_failed' })
    }
  })
}
