// mupot — security_bar MCP tool: read the Security Bar level, and RAISE it (owner-only).
//
// Raising strictness is always allowed for the owner. LOWERING is not available here: it needs a fresh strong
// re-auth through a web session (E3, Athena), which an MCP caller does not have, so a lowering attempt over MCP is
// refused with step_up_required and a pointer to /admin/security-bar. The refusal is itself audited.
// Agents (bound tokens) can read nothing here beyond the level and can never write.

import { type ToolSpec, fail, done, str } from './index'
import { raiseLevel, requestLower, authIsOwner } from '../policy/admin'
import { barView } from '../policy/bar'
import { LEVEL_RANK, POLICY_LEVELS, isPolicyLevel } from '../policy/registry'

export const toolSecurityBar: ToolSpec = {
  name: 'security_bar',
  scope: 'org',
  min: 'authenticated',
  args: `{ set_level?: ${POLICY_LEVELS.map((l) => `"${l}"`).join('|')} } -- no args: read the current level. set_level: OWNER ONLY and can only RAISE strictness` +
    ' (onboarding < operating < under_attack). Lowering needs a fresh re-auth on the dashboard (/admin/security-bar) and a second owner or a delay.',
  inputSchema: {
    type: 'object',
    properties: { set_level: { type: 'string', enum: [...POLICY_LEVELS] } },
    additionalProperties: false,
  },
  async run(auth, env, args) {
    if (args.set_level === undefined) {
      const v = await barView(env)
      return done({ level: v.level, source: v.source, version: v.version, pending_lower: v.pending_lower })
    }
    const target = str(args.set_level)
    if (!isPolicyLevel(target)) return fail(400, 'invalid_level', { accepted: POLICY_LEVELS })
    if (!(await authIsOwner(env, auth))) return fail(403, 'forbidden', { need: 'org:owner' })
    const current = await barView(env)
    if (LEVEL_RANK[target] < LEVEL_RANK[current.level]) {
      // Audited refusal: requestLower logs lower_refused when the re-auth is absent (it always is over MCP).
      await requestLower(env, auth, target)
      return fail(403, 'step_up_required', {
        detail: 'lowering the Security Bar needs a fresh re-auth and a second owner (or a delay): do it on the dashboard',
        next: '/admin/security-bar',
      })
    }
    if (target === current.level) return done({ level: current.level, version: current.version, unchanged: true })
    const out = await raiseLevel(env, auth, target)
    if (!out.ok) return fail(out.error === 'conflict' ? 409 : 403, out.error)
    return done({ level: out.level, version: out.version })
  },
}

export const SECURITY_BAR_TOOLS: ToolSpec[] = [toolSecurityBar]
