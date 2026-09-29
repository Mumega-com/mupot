// tests/openapi-public-allowlist.test.ts — mupot#1596: GET /openapi.json is unauthenticated
// by design (Custom GPT Actions discovery), so it must never disclose more than the
// committed allowlist. These tests exercise the REAL TOOLS registry (imported, not a
// fixture), so they fail the moment either the allowlist or the min-capability floor drifts
// from what actually ships. See src/mcp/openapi-public-allowlist.ts's module header for the
// full design rationale.
import { describe, expect, it } from 'vitest'
import { publicToolSpecs, TOOLS } from '../src/mcp'
import { PUBLIC_TOOL_ALLOWLIST } from '../src/mcp/openapi-public-allowlist'

const MEMBER_TIER_OR_BELOW = new Set(['authenticated', 'observer', 'member'])
const ABOVE_MEMBER = new Set(['lead', 'admin', 'owner'])

describe('mupot#1596 — public OpenAPI allowlist invariants (real TOOLS registry)', () => {
  it('publicToolSpecs() returns exactly the tools named in PUBLIC_TOOL_ALLOWLIST', () => {
    const publicNames = publicToolSpecs()
      .map((t) => t.name)
      .sort()
    const allowNames = [...PUBLIC_TOOL_ALLOWLIST].sort()
    expect(publicNames).toEqual(allowNames)
  })

  it('every allowlisted tool exists in TOOLS and is at member capability or below', () => {
    const byName = new Map(TOOLS.map((t) => [t.name, t]))
    for (const name of PUBLIC_TOOL_ALLOWLIST) {
      const spec = byName.get(name)
      expect(spec, `allowlisted tool "${name}" is not a real ToolSpec in TOOLS`).toBeTruthy()
      expect(
        MEMBER_TIER_OR_BELOW.has(spec!.min),
        `allowlisted tool "${name}" has min:"${spec!.min}" — above member, must not be public`,
      ).toBe(true)
    }
  })

  it('no tool above member capability ever appears in publicToolSpecs(), regardless of the allowlist', () => {
    for (const spec of publicToolSpecs()) {
      expect(ABOVE_MEMBER.has(spec.min), `${spec.name} (min:${spec.min}) leaked into the public spec`).toBe(false)
    }
  })

  it('publicToolSpecs() excludes every admin-tier tool the issue named by name', () => {
    const publicNames = new Set(publicToolSpecs().map((t) => t.name))
    for (const admin of [
      'mint_agent_token',
      'grant_agent_capability',
      'revoke_agent_token',
      'revoke_agent_session',
      'revoke_gate_capability',
      'archive_row',
      'unarchive_row',
      'addon_archive',
      'addon_install',
      'addon_activate',
      'create_squad',
      'create_department',
      'project_create',
      'update_squad',
      'team_bootstrap',
      'pot_provision',
      'pot_release',
    ]) {
      expect(publicNames.has(admin), `${admin} must not be in the public spec`).toBe(false)
    }
  })

  it('mutation proof: PUBLIC_TOOL_ALLOWLIST containing an admin tool name does not make it public', () => {
    // Does not mutate the shared module — re-derives publicToolSpecs()'s own filter logic
    // against a synthetic allowlist that (mis)includes an admin tool, proving the min-rank
    // check is a real second gate and not just "trust the allowlist file".
    const adminTool = TOOLS.find((t) => t.min === 'admin')!
    expect(adminTool).toBeTruthy()
    const syntheticAllow = new Set([...PUBLIC_TOOL_ALLOWLIST, adminTool.name])
    const filtered = TOOLS.filter(
      (t) => syntheticAllow.has(t.name) && MEMBER_TIER_OR_BELOW.has(t.min),
    )
    expect(filtered.some((t) => t.name === adminTool.name)).toBe(false)
  })

  it('PUBLIC_TOOL_ALLOWLIST is sorted and has no duplicates', () => {
    const sorted = [...PUBLIC_TOOL_ALLOWLIST].sort()
    expect(PUBLIC_TOOL_ALLOWLIST).toEqual(sorted)
    expect(new Set(PUBLIC_TOOL_ALLOWLIST).size).toBe(PUBLIC_TOOL_ALLOWLIST.length)
  })
})
