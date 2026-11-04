import { describe, expect, it } from 'vitest'
import { hasWorkspaceAdmin, isOrgAdmin } from '../src/auth/capability'
import { isOrgOwnerAdmin } from '../src/mcp'
import type { AuthContext, Capability, CapabilityGrant } from '../src/types'

// mupot#2309 guard: the role LABEL fix is display-only. This table pins the permission answers
// as they were on origin/main (this file imports nothing the fix added, so it also runs on main).

function g(scope_type: CapabilityGrant['scope_type'], scope_id: string | null, capability: Capability): CapabilityGrant {
  return { member_id: 'm', scope_type, scope_id, capability }
}
function a(role: AuthContext['role'], capabilities: CapabilityGrant[] | undefined): AuthContext {
  return { userId: 'm', memberId: 'm', email: 'm@x.test', role, tenant: 't', channel: 'workspace', capabilities, boundAgentId: null }
}

// [label, auth, isOrgAdmin, hasWorkspaceAdmin, isOrgOwnerAdmin]
const MATRIX: Array<[string, AuthContext, boolean, boolean, boolean]> = [
  ['role owner, no caps', a('owner', []), true, false, true],
  ['role owner, caps undefined', a('owner', undefined), true, true, true],
  ['role admin, no caps', a('admin', []), true, false, true],
  ['role member, org owner grant', a('member', [g('org', null, 'owner')]), true, true, true],
  ['role member, org admin grant', a('member', [g('org', null, 'admin')]), true, true, true],
  ['role member, org lead grant', a('member', [g('org', null, 'lead')]), false, false, false],
  ['role member, squad owner grant', a('member', [g('squad', 's1', 'owner')]), false, false, false],
  ['role member, no caps', a('member', []), false, false, false],
  ['role member, caps undefined', a('member', undefined), false, false, false],
]

describe('capability results are unchanged (mupot#2309)', () => {
  it.each(MATRIX)('%s', (_label, auth, admin, wsAdmin, ownerAdmin) => {
    expect(isOrgAdmin(auth)).toBe(admin)
    expect(hasWorkspaceAdmin(auth)).toBe(wsAdmin)
    expect(isOrgOwnerAdmin(auth)).toBe(ownerAdmin)
  })
})
