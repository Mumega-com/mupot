// mupot - secure drops (W2) MCP tools. Contract: docs/architecture/secure-moments.md ("W2: secure drops").
//
//   host_key_register   the AGENT registers its host's X25519 PUBLIC key (agent-bound caller only; one live key per agent).
//   credential_request  the AGENT asks for a named credential; returns a one-time secure link + the host key fingerprint.
//   secure_drop_pull    the AGENT lists sealed ciphertext for its own live host key (and revoke instructions).
//   secure_drop_ack     the AGENT confirms the host wrote the file; the ciphertext is deleted (single use).
//   secure_drop_revoke  a human with authority over the agent marks a delivered credential for shredding.
//
// NO TOOL HERE RETURNS OR ACCEPTS A SECRET. The secret travels browser -> mupot -> host as HPKE ciphertext only;
// this server has no decrypt path. All five tools are not advertised, and refuse before any read or write, while
// SECURE_DROP is off or secure moments are unusable.
import type { AuthContext, Env } from '../types'
import { issueMomentLink } from '../secure-moments/issue'
import { memberIsActiveHuman } from '../access/identity'
import { secureDropStatus, DROP_TTL_DEFAULT_MINUTES, DROP_TTL_MAX_MINUTES, DROP_TTL_MIN_MINUTES } from '../secure-drop/config'
import { groupFingerprint, isValidDropName, parseHostPublicKey } from '../secure-drop/keys'
import { loadAgent, mayGovernAgent, type AgentRow } from '../secure-drop/authority'
import { notifyGovernorsOfHostKey } from '../secure-drop/notify'
import {
  abandonRequest, ackDrop, attachMoment, createDropRequest, findRevokeCandidates, listPendingDrops, listPendingRevokes, loadLiveHostKey,
  purgeExpiredDrops, registerHostKey, revokeDrop,
} from '../secure-drop/store'
import { type ToolSpec, type ToolOutcome, fail, done } from './index'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CONTROL_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

/** The flag/config refusal, shared by every tool (and by invokeTool before argument handling). */
export function secureDropRefusal(env: Env): ToolOutcome | null {
  const st = secureDropStatus(env)
  if (st.state === 'off') return fail(403, 'secure_drop_disabled', 'Secure drops are not enabled on this pot.')
  if (st.state === 'misconfigured') return fail(409, 'secure_drop_misconfigured', st.reason)
  return null
}

/** An agent-bound caller and its (active) agent row; anything else is refused. The agent id comes from the token, never args. */
async function agentCaller(auth: AuthContext, env: Env): Promise<{ ok: true; agent: AgentRow; memberId: string | null } | { ok: false; out: ToolOutcome }> {
  const off = secureDropRefusal(env)
  if (off) return { ok: false, out: off }
  if (!auth.boundAgentId) return { ok: false, out: fail(403, 'agent_bound_required', 'only an agent-bound token may call this tool; a host key belongs to the agent itself') }
  const agent = await loadAgent(env, auth.boundAgentId)
  if (!agent) return { ok: false, out: fail(403, 'agent_not_found') }
  if (agent.status !== 'active') return { ok: false, out: fail(403, 'agent_not_active') }
  return { ok: true, agent, memberId: auth.memberId ?? null }
}

const toolHostKeyRegister: ToolSpec = {
  name: 'host_key_register',
  scope: 'the calling agent registers its host X25519 public key for sealed credential delivery (agent-bound only; rotation revokes the old key and drops sealed to it)',
  min: 'member',
  args: '{ public_key: string (43-char base64url of the raw 32-byte X25519 public key) }',
  inputSchema: {
    type: 'object',
    properties: { public_key: { type: 'string', description: 'Raw 32-byte X25519 public key, base64url without padding (43 characters). Never a private key.' } },
    required: ['public_key'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const who = await agentCaller(auth, env)
    if (!who.ok) return who.out
    const key = await parseHostPublicKey(args.public_key)
    if (!key) return fail(400, 'invalid_public_key', 'public_key must be the 43-character base64url of a 32-byte X25519 public key that is not a small-order point')
    const r = await registerHostKey(env, { agentId: who.agent.id, memberId: who.memberId, key })
    if (!r.ok) {
      return r.reason === 'key_was_revoked'
        ? fail(409, 'host_key_was_revoked', 'this key was registered and revoked before; generate a new one')
        : fail(409, 'host_key_conflict', 'another registration for this agent landed first; retry')
    }
    // A new or rotated key tells the agent's governors (the stolen-token re-key signal). An unchanged key says nothing.
    const notice = r.unchanged
      ? { governors: 0, delivered: 0 }
      : await notifyGovernorsOfHostKey(env, { agent: who.agent, byMemberId: who.memberId, fingerprint: r.fingerprint, rotated: r.rotated, keyId: r.id })
    return done({
      ok: true,
      agent_id: who.agent.id,
      agent_slug: who.agent.slug,
      host_key_id: r.id,
      governors_found: notice.governors,
      governors_notified: notice.delivered,
      fingerprint: r.fingerprint,
      fingerprint_grouped: groupFingerprint(r.fingerprint),
      rotated: r.rotated,
      unchanged: r.unchanged,
      note: r.rotated ? 'The previous key is revoked; open requests and unpulled ciphertext sealed to it were closed. The agent\'s governors were notified.' : 'Compare this fingerprint with the one secure-drop.mjs keygen printed. Humans must compare against a value from the host operator out of band, never one the agent relays.',
    })
  },
}

const toolCredentialRequest: ToolSpec = {
  name: 'credential_request',
  scope: 'the calling agent asks a human for a named credential; returns a one-time secure link and the host key fingerprint (never returns or accepts a secret)',
  min: 'member',
  args: '{ name: string (safe filename slug), purpose: string, scope_hint?: string, ttl_minutes?: number (5-1440, default 60) }',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Lower-case slug [a-z0-9_-], up to 63 characters, starting with a letter or digit. The file is written to ~/.mupot/secrets/<agent id>/<name> on the agent host.' },
      purpose: { type: 'string', description: 'Why the credential is needed (shown to the human in an untrusted box; up to 280 characters). Never put a secret here.' },
      scope_hint: { type: 'string', description: 'Optional: the scope or permission the credential should carry (up to 200 characters).' },
      ttl_minutes: { type: 'number', description: 'How long the link stays open: 5 to 1440 minutes, default 60.' },
    },
    required: ['name', 'purpose'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const who = await agentCaller(auth, env)
    if (!who.ok) return who.out
    if (!isValidDropName(args.name)) return fail(400, 'invalid_name', 'name must match [a-z0-9][a-z0-9_-]{0,62}')
    const purpose = typeof args.purpose === 'string' ? args.purpose.trim() : ''
    if (purpose.length < 1 || purpose.length > 280 || CONTROL_RE.test(purpose)) return fail(400, 'invalid_purpose', 'purpose must be 1 to 280 printable characters')
    let scopeHint: string | null = null
    if (args.scope_hint !== undefined && args.scope_hint !== null) {
      const h = typeof args.scope_hint === 'string' ? args.scope_hint.trim() : ''
      if (h.length < 1 || h.length > 200 || CONTROL_RE.test(h)) return fail(400, 'invalid_scope_hint', 'scope_hint must be 1 to 200 printable characters')
      scopeHint = h
    }
    let ttl = DROP_TTL_DEFAULT_MINUTES
    if (args.ttl_minutes !== undefined && args.ttl_minutes !== null) {
      if (typeof args.ttl_minutes !== 'number' || !Number.isInteger(args.ttl_minutes) || args.ttl_minutes < DROP_TTL_MIN_MINUTES || args.ttl_minutes > DROP_TTL_MAX_MINUTES) {
        return fail(400, 'invalid_ttl', `ttl_minutes must be an integer from ${DROP_TTL_MIN_MINUTES} to ${DROP_TTL_MAX_MINUTES}`)
      }
      ttl = args.ttl_minutes
    }
    const hostKey = await loadLiveHostKey(env, who.agent.id)
    if (!hostKey) return fail(409, 'host_key_required', 'register a host key first: run secure-drop.mjs keygen, then secure-drop.mjs register (or host_key_register)')
    const created = await createDropRequest(env, { agentId: who.agent.id, memberId: who.memberId, hostKey, name: args.name, purpose, scopeHint, ttlMinutes: ttl })
    if (!created.ok) {
      if (created.reason === 'delivery_pending') return fail(409, 'delivery_pending', 'a sealed credential with this name is waiting to be pulled; pull it first')
      if (created.reason === 'too_many_open') return fail(429, 'too_many_open_requests', 'close or wait out your open credential requests first')
      return fail(409, 'request_conflict', 'another request for this name landed first; retry')
    }
    const link = await issueMomentLink(env, { kind: 'credential', subjectId: created.id, requesterAgentId: who.agent.id, subjectExpiresAtIso: created.expiresAt })
    if (!link || !(await attachMoment(env, created.id, link.momentId))) {
      await abandonRequest(env, created.id)
      return fail(503, 'link_unavailable', 'the secure link could not be issued; nothing was requested')
    }
    return done({
      ok: true,
      request_id: created.id,
      name: args.name,
      approve_url: link.url,
      host_key_fingerprint: groupFingerprint(hostKey.fingerprint),
      expires_at: created.expiresAt,
      note: 'Pending. Hand approve_url to a human. They compare the fingerprint, paste the secret into the page (sealed in their browser) and confirm with a passkey. Then run secure-drop.mjs pull on the host. This tool never returns a secret.',
    })
  },
}

const toolSecureDropPull: ToolSpec = {
  name: 'secure_drop_pull',
  scope: 'the calling agent lists sealed credentials waiting for its live host key (ciphertext only) and revoke instructions',
  min: 'member',
  args: '{}',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async run(auth, env) {
    const who = await agentCaller(auth, env)
    if (!who.ok) return who.out
    const key = await loadLiveHostKey(env, who.agent.id)
    if (!key) return fail(409, 'host_key_required', 'no live host key is registered for this agent')
    await purgeExpiredDrops(env)
    const drops = await listPendingDrops(env, who.agent.id)
    const revokes = await listPendingRevokes(env, who.agent.id)
    return done({ ok: true, host_key_fingerprint: key.fingerprint, drops, revokes })
  },
}

const toolSecureDropAck: ToolSpec = {
  name: 'secure_drop_ack',
  scope: 'the calling agent confirms its host wrote a pulled credential (deletes the ciphertext) or shredded a revoked one; single use',
  min: 'member',
  args: '{ id: string }',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'The drop id from secure_drop_pull.' } },
    required: ['id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const who = await agentCaller(auth, env)
    if (!who.ok) return who.out
    if (typeof args.id !== 'string' || !UUID_RE.test(args.id)) return fail(400, 'invalid_id')
    const r = await ackDrop(env, { agentId: who.agent.id, memberId: who.memberId, id: args.id })
    if (!r) return fail(409, 'nothing_to_ack', 'no pending drop with this id for this agent (already acknowledged, expired, revoked, or not yours)')
    return done({ ok: true, id: args.id, result: r })
  },
}

const toolSecureDropRevoke: ToolSpec = {
  name: 'secure_drop_revoke',
  scope: 'a human with authority over the agent (squad admin or org admin) revokes a credential by name: open requests are cancelled, unpulled ciphertext is deleted, a delivered file is marked for the host to shred',
  min: 'member',
  args: '{ name: string, agent_id?: string (needed only when the name exists for several agents) }',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The credential name (the file name under ~/.mupot/secrets/<agent id>/ on the agent host).' },
      agent_id: { type: 'string', description: 'Only when the same name exists for more than one agent you govern.' },
    },
    required: ['name'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const off = secureDropRefusal(env)
    if (off) return off
    // Revoking is a human act of authority: never an agent-bound principal, whatever it holds.
    if (auth.boundAgentId || !auth.memberId) return fail(403, 'human_required', 'only a human member with authority over the agent may revoke a credential')
    if (!(await memberIsActiveHuman(env, auth.memberId))) return fail(403, 'human_required', 'only a human member with authority over the agent may revoke a credential')
    if (!isValidDropName(args.name)) return fail(400, 'invalid_name', 'name must match [a-z0-9][a-z0-9_-]{0,62}')
    let agentFilter: string | null = null
    if (args.agent_id !== undefined && args.agent_id !== null) {
      if (typeof args.agent_id !== 'string' || args.agent_id.length === 0 || args.agent_id.length > 64) return fail(400, 'invalid_agent_id')
      agentFilter = args.agent_id
    }
    const found = await findRevokeCandidates(env, args.name, agentFilter)
    // Only drops of agents the caller governs are visible to it: an unauthorised caller gets the same not_found.
    const governed = []
    const seen = new Map<string, boolean>()
    for (const d of found) {
      let ok = seen.get(d.agent_id)
      if (ok === undefined) {
        const agent = await loadAgent(env, d.agent_id)
        ok = agent !== null && (await mayGovernAgent(env, auth, agent))
        seen.set(d.agent_id, ok)
      }
      if (ok) governed.push(d)
    }
    if (governed.length === 0) return fail(404, 'not_found', 'no revocable credential with this name')
    if (new Set(governed.map((d) => d.agent_id)).size > 1) return fail(409, 'ambiguous_name', 'this name exists for several agents; pass agent_id')
    const effects: string[] = []
    for (const d of governed) {
      const eff = await revokeDrop(env, { drop: d, name: args.name, memberId: auth.memberId })
      if (eff) effects.push(eff)
    }
    if (effects.length === 0) return fail(409, 'nothing_to_revoke', 'the credential was already revoked or moved on')
    return done({ ok: true, name: args.name, effects, note: 'A delivered file is shredded by the host at its next pull; revoking never reaches the host synchronously.' })
  },
}

export const SECURE_DROP_TOOLS: ToolSpec[] = [toolHostKeyRegister, toolCredentialRequest, toolSecureDropPull, toolSecureDropAck, toolSecureDropRevoke]
