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

function cloneFixture(): AddonManifestV1 {
  return JSON.parse(JSON.stringify(fixture)) as AddonManifestV1
}

function manifestWithRankGrant(
  scopeType: 'org' | 'department' | 'squad',
  scopeRef: string | null,
): AddonManifestV1 {
  return {
    ...fixture,
    authorityRequests: {
      rankGrants: [{ subjectRef: 'agent:fixture', capability: 'lead', scopeType, scopeRef, reason: 'test grant' }],
      surfaceGrants: [],
    },
  }
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

  it('rejects prototype, accessor, symbol, and non-enumerable manifest data', () => {
    expect(validateAddonManifest(Object.create(fixture))).toMatchObject({ ok: false })

    const accessorManifest = cloneFixture() as Record<string, unknown>
    Object.defineProperty(accessorManifest, 'key', { enumerable: true, get: () => fixture.key })
    expect(validateAddonManifest(accessorManifest)).toMatchObject({ ok: false })

    const symbolManifest = cloneFixture() as Record<string | symbol, unknown>
    symbolManifest[Symbol('hidden')] = true
    expect(validateAddonManifest(symbolManifest)).toMatchObject({ ok: false })

    const nonEnumerableManifest = cloneFixture() as Record<string, unknown>
    Object.defineProperty(nonEnumerableManifest, 'hidden', { enumerable: false, value: true })
    expect(validateAddonManifest(nonEnumerableManifest)).toMatchObject({ ok: false })
  })

  it('rejects non-canonical nested records and accepts null-prototype records', () => {
    const nullPrototypeManifest = Object.assign(Object.create(null), fixture)
    expect(validateAddonManifest(nullPrototypeManifest)).toMatchObject({ ok: true })

    const prototypeDepartment = cloneFixture()
    prototypeDepartment.departments = [Object.create(prototypeDepartment.departments[0])]
    expect(validateAddonManifest(prototypeDepartment)).toMatchObject({ ok: false })

    const accessorAuthority = cloneFixture()
    Object.defineProperty(accessorAuthority.authorityRequests, 'rankGrants', { enumerable: true, get: () => [] })
    expect(validateAddonManifest(accessorAuthority)).toMatchObject({ ok: false })

    const symbolMetric = cloneFixture()
    const metric = symbolMetric.metrics[0] as Record<string | symbol, unknown>
    metric[Symbol('hidden')] = true
    expect(validateAddonManifest(symbolMetric)).toMatchObject({ ok: false })

    const nonEnumerableRetention = cloneFixture()
    Object.defineProperty(nonEnumerableRetention.retention, 'hidden', { enumerable: false, value: true })
    expect(validateAddonManifest(nonEnumerableRetention)).toMatchObject({ ok: false })
  })

  it('requires scopeRef to match the scope type', () => {
    expect(validateAddonManifest(manifestWithRankGrant('org', null))).toMatchObject({ ok: true })
    expect(validateAddonManifest(manifestWithRankGrant('org', 'department:fixture'))).toMatchObject({ ok: false })
    expect(validateAddonManifest(manifestWithRankGrant('department', null))).toMatchObject({ ok: false })
    expect(validateAddonManifest(manifestWithRankGrant('department', ''))).toMatchObject({ ok: false })
    expect(validateAddonManifest(manifestWithRankGrant('squad', null))).toMatchObject({ ok: false })
  })

  it('rejects sparse and non-canonical arrays throughout the manifest', () => {
    const sparseStringArray = cloneFixture()
    sparseStringArray.eventSubscriptions = ['addon.installed']
    sparseStringArray.eventSubscriptions.length = 2
    expect(validateAddonManifest(sparseStringArray)).toMatchObject({ ok: false })

    const sparseNestedStringArray = cloneFixture()
    sparseNestedStringArray.connectorRequirements = [{
      slot: 'source',
      accepts: ['native'],
      required: true,
      capability: 'read',
      bindingKind: 'either',
    }]
    sparseNestedStringArray.connectorRequirements[0].accepts.length = 2
    expect(validateAddonManifest(sparseNestedStringArray)).toMatchObject({ ok: false })

    const sparseRecordArray = cloneFixture()
    sparseRecordArray.departments.length = 2
    expect(validateAddonManifest(sparseRecordArray)).toMatchObject({ ok: false })

    const accessorRecordArray = cloneFixture()
    Object.defineProperty(accessorRecordArray.departments, '0', {
      enumerable: true,
      get: () => fixture.departments[0],
    })
    expect(validateAddonManifest(accessorRecordArray)).toMatchObject({ ok: false })

    const symbolRecordArray = cloneFixture()
    symbolRecordArray.departments[Symbol('hidden')] = true
    expect(validateAddonManifest(symbolRecordArray)).toMatchObject({ ok: false })

    const extraRecordArray = cloneFixture()
    Object.defineProperty(extraRecordArray.departments, 'hidden', { enumerable: true, value: true })
    expect(validateAddonManifest(extraRecordArray)).toMatchObject({ ok: false })
  })

  it('produces a stable digest independent of object insertion order', async () => {
    const reordered = Object.fromEntries(Object.entries(fixture).reverse()) as AddonManifestV1
    expect(Object.keys(reordered)).toEqual([...Object.keys(fixture)].reverse())
    expect(Object.keys(reordered)).not.toEqual(Object.keys(fixture))
    expect(canonicalManifestJson(reordered)).toBe(canonicalManifestJson(fixture))
    expect(await manifestSha256(reordered)).toBe(await manifestSha256(fixture))
  })
})
