import { describe, expect, it } from 'vitest'
import {
  canonicalManifestJson,
  manifestSha256,
  validateAddonManifest,
  type AddonManifestV1,
} from '../src/addons/contract'

const fixture: AddonManifestV1 = {
  schema: 'mupot.addon/v1',
  key: 'fixture-addon',
  name: 'Fixture Addon',
  version: '1.0.0',
  publisher: 'mumega',
  trustClass: 'native_reviewed',
  mupotCompatibility: '^0.23.0',
  kind: 'native',
  description: 'Lifecycle fixture with no authority.',
  departments: [{ moduleKey: 'fixture', required: true }],
  agentTemplates: [],
  connectorRequirements: [],
  authorityRequests: { rankGrants: [], surfaceGrants: [] },
  metrics: [{ descriptorKey: 'fixture.pings', ownerDepartment: 'fixture' }],
  playbooks: [],
  loops: [],
  consoleSections: [{ rendererKey: 'fixture', path: '/departments/fixture', title: 'Fixture', navIcon: 'flask-conical' }],
  eventSubscriptions: [],
  approvalPolicies: [],
  healthChecks: [],
  retention: { disablePreservesData: true, purgeRequiresOwner: true },
}

describe('addon contract', () => {
  it('accepts the zero-authority fixture', () => {
    expect(validateAddonManifest(fixture)).toEqual({ ok: true, manifest: fixture })
  })

  it('rejects unknown fields and wildcard surfaces', () => {
    expect(validateAddonManifest({ ...fixture, surprise: true })).toMatchObject({ ok: false })
    expect(validateAddonManifest({
      ...fixture,
      authorityRequests: { rankGrants: [], surfaceGrants: [{ subjectRef: 'agent:x', capability: 'mcp:*', reason: 'bad' }] },
    })).toMatchObject({ ok: false, reason: 'invalid_surface_capability' })
  })

  it('produces a stable digest independent of object insertion order', async () => {
    const reordered = JSON.parse(JSON.stringify(fixture)) as AddonManifestV1
    expect(canonicalManifestJson(reordered)).toBe(canonicalManifestJson(fixture))
    expect(await manifestSha256(reordered)).toBe(await manifestSha256(fixture))
  })
})
