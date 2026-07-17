# Mupot Addon Package v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a compatibility-safe, versioned Mupot microkernel package contract and make Marketing & CRO Monitor the first conformant addon package without changing its live lifecycle digest.

**Architecture:** Introduce a small package manifest around the existing `mupot.addon/v1` lifecycle manifest. The registry validates and hashes both layers, while tenant installations continue to use the unchanged lifecycle digest. Declarative package files are separated from trusted host registration and protected by an import-boundary conformance test.

**Tech Stack:** TypeScript 5.6, Vitest 4, Hono, Cloudflare Workers, Web Crypto SHA-256, TypeScript compiler API for static import inspection.

## Global Constraints

- Mupot remains independent; no external agent-network imports, schemas, runtime assumptions, or service dependencies.
- Mupot's Cloudflare microkernel owns identity, capability RBAC, pub/sub, audit, and versioned ports.
- The current supported addon substrate port version is exactly `"1"`.
- `mupot.addon/v1` lifecycle manifest JSON, version `1.0.0`, and SHA-256 must not change for Marketing & CRO Monitor.
- No D1 migration or production data rewrite is allowed in this slice.
- Package files cannot import raw `Env`, Cloudflare persistence, auth, routes, connectors, tasks, flights, gates, audit writers, bus publishers, dashboards, or network clients.
- Existing imports of `FixtureAddon` and `MarketingCroMonitorAddon` remain valid through compatibility re-exports.
- Native runtime and adapter code remains compiled, reviewed host code; arbitrary third-party JavaScript is not loaded into the Worker.

---

## Roadmap and Estimate

| Milestone | Deliverable | Focused engineering | Agentic elapsed estimate |
| --- | --- | ---: | ---: |
| M1 | Package schema, validator, canonical hash | 3-4 hours | 1.5-2.5 hours |
| M2 | Fixture and Marketing package extraction | 3-4 hours | 1.5-2.5 hours |
| M3 | Registry dual-digest integration | 4-6 hours | 2-4 hours |
| M4 | Static package-boundary conformance | 2-3 hours | 1-2 hours |
| M5 | Operator evidence API | 2-3 hours | 1-2 hours |
| M6 | Full verification, review, PR, deployment proof | 4-6 hours | 2-4 hours |
| **Total** | **Production-ready package v1** | **18-26 hours** | **9-16 hours** |

The realistic calendar estimate is **two focused working days** with Codex plus reviewer capacity, or **three to four working days** for one engineer including review and deployment windows. The estimate includes a 20% integration buffer for the global registry's top-level registration and the 57 current fixture/Marketing references. It excludes addon upgrades, package signing, third-party package execution, marketplace billing, and DME activation.

### Later Product Roadmap

| Phase | Scope | Estimate after Package v1 |
| --- | --- | ---: |
| v1.1 | Upgrade planning, authority diff, resumable migration, rollback receipts | 5-8 engineering days |
| v1.2 | Package author template, validator CLI, local fixture harness, documentation | 4-6 engineering days |
| v1.3 | External MCP package identity, signature verification, revocation, isolated runtime health | 8-12 engineering days |
| v1.4 | Tenant catalog, commercial entitlements, publisher review, billing hooks | 10-15 engineering days |

These later phases should begin only after the unchanged Marketing/CRO package produces a verified Mumega outcome and installs on a second pot with tenant-owned bindings.

---

### Task 1: Add the Package Contract

**Estimate:** 3-4 hours

**Files:**
- Create: `src/addons/package-contract.ts`
- Create: `tests/addon-package-contract.test.ts`
- Read: `src/addons/contract.ts`

**Interfaces:**
- Consumes: `AddonManifestV1`, `validateAddonManifest`, `canonicalManifestJson`.
- Produces: `MUPOT_ADDON_PORT_VERSION`, `AddonPackageManifestV1`, `AddonPackageValidationResult`, `validateAddonPackage`, `canonicalAddonPackageJson`, `addonPackageSha256`.

- [ ] **Step 1: Write the failing package contract tests**

```ts
import { describe, expect, it } from 'vitest'
import { FixtureAddon } from '../src/addons/modules/fixture'
import {
  MUPOT_ADDON_PORT_VERSION,
  addonPackageSha256,
  canonicalAddonPackageJson,
  validateAddonPackage,
  type AddonPackageManifestV1,
} from '../src/addons/package-contract'

const fixturePackage: AddonPackageManifestV1 = {
  schema: 'mupot.addon-package/v1',
  mupotPortVersion: '1',
  addon: FixtureAddon,
}

describe('addon package contract', () => {
  it('accepts a canonical package around a valid lifecycle manifest', () => {
    expect(MUPOT_ADDON_PORT_VERSION).toBe('1')
    expect(validateAddonPackage(fixturePackage)).toEqual({ ok: true, package: fixturePackage })
  })

  it('rejects unknown, hidden, accessor, symbolic, and malformed fields', () => {
    expect(validateAddonPackage({ ...fixturePackage, extra: true })).toMatchObject({
      ok: false,
      reason: 'invalid_package_object',
    })
    expect(validateAddonPackage({ ...fixturePackage, mupotPortVersion: 'v1' })).toMatchObject({
      ok: false,
      reason: 'invalid_port_version',
      path: 'mupotPortVersion',
    })

    const accessor = { ...fixturePackage } as Record<string, unknown>
    Object.defineProperty(accessor, 'schema', { enumerable: true, get: () => 'mupot.addon-package/v1' })
    expect(validateAddonPackage(accessor)).toMatchObject({ ok: false })

    const symbolic = { ...fixturePackage } as Record<string | symbol, unknown>
    symbolic[Symbol('hidden')] = true
    expect(validateAddonPackage(symbolic)).toMatchObject({ ok: false })

    const hidden = { ...fixturePackage } as Record<string, unknown>
    Object.defineProperty(hidden, 'hidden', { enumerable: false, value: true })
    expect(validateAddonPackage(hidden)).toMatchObject({ ok: false })
  })

  it('returns the nested lifecycle validation path', () => {
    expect(validateAddonPackage({
      ...fixturePackage,
      addon: { ...FixtureAddon, key: 'INVALID' },
    })).toMatchObject({ ok: false, reason: 'invalid_addon_manifest', path: 'addon.key' })
  })

  it('canonicalizes property order and produces a stable package digest', async () => {
    const reordered = {
      addon: FixtureAddon,
      mupotPortVersion: '1',
      schema: 'mupot.addon-package/v1',
    } as AddonPackageManifestV1
    expect(canonicalAddonPackageJson(reordered)).toBe(canonicalAddonPackageJson(fixturePackage))
    expect(await addonPackageSha256(reordered)).toBe(await addonPackageSha256(fixturePackage))
    expect(await addonPackageSha256(fixturePackage)).toMatch(/^[a-f0-9]{64}$/)
  })
})
```

- [ ] **Step 2: Run the contract test and verify RED**

Run: `npx vitest run tests/addon-package-contract.test.ts`

Expected: FAIL because `src/addons/package-contract.ts` does not exist.

- [ ] **Step 3: Implement the package contract**

```ts
import {
  canonicalManifestJson,
  validateAddonManifest,
  type AddonManifestV1,
} from './contract'

export const MUPOT_ADDON_PORT_VERSION = '1' as const

export interface AddonPackageManifestV1 {
  schema: 'mupot.addon-package/v1'
  mupotPortVersion: string
  addon: AddonManifestV1
}

export type AddonPackageValidationResult =
  | { ok: true; package: AddonPackageManifestV1 }
  | {
      ok: false
      reason: 'invalid_package_object' | 'invalid_schema' | 'invalid_port_version' | 'invalid_addon_manifest'
      path?: string
    }

function fail(
  reason: Extract<AddonPackageValidationResult, { ok: false }>['reason'],
  path?: string,
): AddonPackageValidationResult {
  return path === undefined ? { ok: false, reason } : { ok: false, reason, path }
}

function isCanonicalPackageObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== 'string')) return false
  if (keys.length !== 3 || !['schema', 'mupotPortVersion', 'addon'].every((key) => keys.includes(key))) return false
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable === true && 'value' in descriptor && descriptor.get === undefined && descriptor.set === undefined
  })
}

export function validateAddonPackage(value: unknown): AddonPackageValidationResult {
  if (!isCanonicalPackageObject(value)) return fail('invalid_package_object')
  if (value.schema !== 'mupot.addon-package/v1') return fail('invalid_schema', 'schema')
  if (typeof value.mupotPortVersion !== 'string' || !/^[1-9]\d*$/.test(value.mupotPortVersion)) {
    return fail('invalid_port_version', 'mupotPortVersion')
  }
  const addonValidation = validateAddonManifest(value.addon)
  if (!addonValidation.ok) {
    return fail(
      'invalid_addon_manifest',
      addonValidation.path === undefined ? 'addon' : `addon.${addonValidation.path}`,
    )
  }
  return {
    ok: true,
    package: {
      schema: 'mupot.addon-package/v1',
      mupotPortVersion: value.mupotPortVersion,
      addon: addonValidation.manifest,
    },
  }
}

export function canonicalAddonPackageJson(packageManifest: AddonPackageManifestV1): string {
  return `{"addon":${canonicalManifestJson(packageManifest.addon)},"mupotPortVersion":${JSON.stringify(packageManifest.mupotPortVersion)},"schema":"mupot.addon-package/v1"}`
}

export async function addonPackageSha256(packageManifest: AddonPackageManifestV1): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalAddonPackageJson(packageManifest))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
```

- [ ] **Step 4: Run package and existing manifest tests and verify GREEN**

Run: `npx vitest run tests/addon-package-contract.test.ts tests/addon-contract.test.ts`

Expected: both files pass with no changed lifecycle-manifest assertions.

- [ ] **Step 5: Commit the contract**

```bash
git add src/addons/package-contract.ts tests/addon-package-contract.test.ts
git commit -m "feat(addons): define versioned package contract"
```

---

### Task 2: Extract Declarative Fixture and Marketing Packages

**Estimate:** 3-4 hours

**Files:**
- Create: `src/addons/packages/fixture.ts`
- Create: `src/addons/packages/marketing-cro-monitor.ts`
- Modify: `src/addons/modules/fixture.ts`
- Modify: `src/addons/modules/marketing-cro-monitor.ts`
- Modify: `tests/addon-contract.test.ts`

**Interfaces:**
- Consumes: `AddonPackageManifestV1` from Task 1 and the existing lifecycle manifest objects.
- Produces: `FixtureAddonPackage`, `MarketingCroMonitorAddonPackage`, plus compatibility exports `FixtureAddon` and `MarketingCroMonitorAddon`.

- [ ] **Step 1: Add a failing package-export and digest-preservation test**

```ts
import { manifestSha256 } from '../src/addons/contract'
import {
  MarketingCroMonitorAddon,
  MarketingCroMonitorAddonPackage,
} from '../src/addons/packages/marketing-cro-monitor'

it('wraps the unchanged marketing lifecycle manifest in port v1', async () => {
  expect(MarketingCroMonitorAddonPackage).toEqual({
    schema: 'mupot.addon-package/v1',
    mupotPortVersion: '1',
    addon: MarketingCroMonitorAddon,
  })
  expect(await manifestSha256(MarketingCroMonitorAddonPackage.addon)).toBe(
    '329f52b894d675991e66fc1ceb511dd3e30be608f2593756e59b8e34e4590570',
  )
  expect(MarketingCroMonitorAddonPackage.addon.version).toBe('1.0.0')
})
```

- [ ] **Step 2: Run the export test and verify RED**

Run: `npx vitest run tests/addon-contract.test.ts`

Expected: FAIL because `src/addons/packages/marketing-cro-monitor.ts` does not exist.

- [ ] **Step 3: Move the fixture lifecycle data and add its package wrapper**

Move the existing `FixtureAddon` object from `src/addons/modules/fixture.ts` into
`src/addons/packages/fixture.ts` without changing any field or array order, then append:

```ts
export const FixtureAddonPackage: AddonPackageManifestV1 = {
  schema: 'mupot.addon-package/v1',
  mupotPortVersion: MUPOT_ADDON_PORT_VERSION,
  addon: FixtureAddon,
}
```

The package file imports only `FixtureModule`, `AddonManifestV1`,
`AddonPackageManifestV1`, and `MUPOT_ADDON_PORT_VERSION`.

- [ ] **Step 4: Move the Marketing lifecycle data and add its package wrapper**

Move `deepFreeze` and the complete existing `MarketingCroMonitorAddon` object from
`src/addons/modules/marketing-cro-monitor.ts` into
`src/addons/packages/marketing-cro-monitor.ts` without changing any manifest field,
value, array order, or version. Append:

```ts
export const MarketingCroMonitorAddonPackage = deepFreeze<AddonPackageManifestV1>({
  schema: 'mupot.addon-package/v1',
  mupotPortVersion: MUPOT_ADDON_PORT_VERSION,
  addon: MarketingCroMonitorAddon,
})
```

- [ ] **Step 5: Make host modules compatibility re-export the package data**

At the top of each host module, import and export both objects:

```ts
import { FixtureAddon, FixtureAddonPackage } from '../packages/fixture'
export { FixtureAddon, FixtureAddonPackage }
```

```ts
import {
  MarketingCroMonitorAddon,
  MarketingCroMonitorAddonPackage,
} from '../packages/marketing-cro-monitor'
export { MarketingCroMonitorAddon, MarketingCroMonitorAddonPackage }
```

Keep the existing renderer registration and, temporarily, the existing
`registerAddon(FixtureAddon)` / `registerAddon(MarketingCroMonitorAddon)` calls. Task 3
changes registry input atomically.

- [ ] **Step 6: Run contract, dashboard, and Marketing tests**

Run: `npx vitest run tests/addon-contract.test.ts tests/dashboard-addons.test.ts tests/dashboard-marketing-cro-monitor.test.ts`

Expected: all tests pass; existing module imports remain source-compatible.

- [ ] **Step 7: Commit package extraction**

```bash
git add src/addons/packages src/addons/modules tests/addon-contract.test.ts
git commit -m "refactor(addons): separate package data from host wiring"
```

---

### Task 3: Register Packages and Preserve Dual Digests

**Estimate:** 4-6 hours

**Files:**
- Modify: `src/addons/registry.ts`
- Modify: `src/addons/modules/fixture.ts`
- Modify: `src/addons/modules/marketing-cro-monitor.ts`
- Modify: `tests/addon-registry.test.ts`
- Modify: `tests/dashboard-addons.test.ts`

**Interfaces:**
- Consumes: `validateAddonPackage`, `addonPackageSha256`, `AddonPackageManifestV1`.
- Produces: package-only `AddonRegistry.register`, catalog fields `packageManifest`, `mupotPortVersion`, `packageSha256`, and unchanged `manifest` / `manifestSha256`.

- [ ] **Step 1: Rewrite registry tests to expect package-only registration**

```ts
import { MUPOT_ADDON_PORT_VERSION } from '../src/addons/package-contract'
import { FixtureAddon, FixtureAddonPackage } from '../src/addons/modules/fixture'
import {
  MarketingCroMonitorAddon,
  MarketingCroMonitorAddonPackage,
} from '../src/addons/modules/marketing-cro-monitor'

it('registers a deeply frozen package with separate package and lifecycle digests', async () => {
  const registry = createAddonRegistry()
  await registry.register(FixtureAddonPackage)
  const stored = registry.get(FixtureAddon.key)
  expect(stored?.packageManifest).not.toBe(FixtureAddonPackage)
  expect(stored?.manifest).toBe(stored?.packageManifest.addon)
  expect(stored?.mupotPortVersion).toBe(MUPOT_ADDON_PORT_VERSION)
  expect(stored?.packageSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(stored?.manifestSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(stored?.packageSha256).not.toBe(stored?.manifestSha256)
  expect(Object.isFrozen(stored?.packageManifest)).toBe(true)
  expect(Object.isFrozen(stored?.manifest.departments)).toBe(true)
})

it('rejects a well-formed package using an unsupported port version', async () => {
  const registry = createAddonRegistry()
  await expect(registry.register({
    ...FixtureAddonPackage,
    mupotPortVersion: '2',
  })).rejects.toThrow('addon_port_incompatible')
})
```

Update every registry mutation in `tests/addon-registry.test.ts` and the three dynamic
registrations in `tests/dashboard-addons.test.ts` to wrap the changed lifecycle manifest:

```ts
await registry.register({
  ...FixtureAddonPackage,
  addon: { ...FixtureAddon, key: 'changed-addon-key' },
})
```

- [ ] **Step 2: Run registry tests and verify RED**

Run: `npx vitest run tests/addon-registry.test.ts tests/dashboard-addons.test.ts`

Expected: FAIL because the registry still accepts an unwrapped lifecycle manifest and
does not expose package evidence.

- [ ] **Step 3: Change the registry contract to package-only input**

Use these exact public shapes in `src/addons/registry.ts`:

```ts
export interface AddonCatalogEntry {
  packageManifest: AddonPackageManifestV1
  manifest: AddonManifestV1
  mupotPortVersion: string
  packageSha256: string
  manifestSha256: string
}

export interface AddonRegistry {
  register(packageManifest: AddonPackageManifestV1): Promise<void>
  get(key: string): AddonCatalogEntry | undefined
  list(): AddonCatalogEntry[]
}
```

The `register` implementation must execute in this order:

```ts
const validation = validateAddonPackage(packageManifest)
if (!validation.ok) throw new Error(`addon_package_invalid:${validation.reason}`)
if (validation.package.mupotPortVersion !== MUPOT_ADDON_PORT_VERSION) {
  throw new Error('addon_port_incompatible')
}
assertAddonRuntimeContract(validation.package.addon)
const key = validation.package.addon.key
if (entries.has(key) || inFlightKeys.has(key)) throw new Error('addon_registry_duplicate_key')

inFlightKeys.add(key)
try {
  const immutablePackage = deepFreeze(structuredClone(validation.package))
  const [packageDigest, lifecycleDigest] = await Promise.all([
    addonPackageSha256(immutablePackage),
    manifestSha256(immutablePackage.addon),
  ])
  entries.set(key, Object.freeze({
    packageManifest: immutablePackage,
    manifest: immutablePackage.addon,
    mupotPortVersion: immutablePackage.mupotPortVersion,
    packageSha256: packageDigest,
    manifestSha256: lifecycleDigest,
  }))
} finally {
  inFlightKeys.delete(key)
}
```

Change the production helper to:

```ts
export function registerAddon(packageManifest: AddonPackageManifestV1): Promise<void> {
  return productionRegistry.register(packageManifest)
}
```

- [ ] **Step 4: Switch production host registration to package objects**

```ts
await registerAddon(FixtureAddonPackage)
```

```ts
await registerAddon(MarketingCroMonitorAddonPackage)
```

- [ ] **Step 5: Run registry, service, route, and dashboard tests**

Run: `npx vitest run tests/addon-registry.test.ts tests/addon-service.test.ts tests/addon-routes.test.ts tests/dashboard-addons.test.ts`

Expected: all tests pass; lifecycle services continue reading `entry.manifest` and
`entry.manifestSha256` unchanged.

- [ ] **Step 6: Commit registry integration**

```bash
git add src/addons/registry.ts src/addons/modules tests/addon-registry.test.ts tests/dashboard-addons.test.ts
git commit -m "feat(addons): register versioned package manifests"
```

---

### Task 4: Enforce the Declarative Package Boundary

**Estimate:** 2-3 hours

**Files:**
- Create: `tests/addon-package-boundary.test.ts`
- Read: `src/addons/packages/*.ts`

**Interfaces:**
- Consumes: TypeScript compiler API and package source files.
- Produces: a reusable test that rejects imports outside the package-data allowlist.

- [ ] **Step 1: Write the boundary test with an intentionally forbidden fixture**

```ts
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ALLOWED_IMPORTS = [
  /^\.\.\/contract$/,
  /^\.\.\/package-contract$/,
  /^\.\.\/\.\.\/departments\/modules\/[a-z0-9-]+$/,
]

function importSpecifiers(source: string, filename: string): string[] {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  return file.statements
    .filter(ts.isImportDeclaration)
    .map((statement) => statement.moduleSpecifier)
    .filter(ts.isStringLiteral)
    .map((literal) => literal.text)
}

function forbiddenImports(source: string, filename = 'package.ts'): string[] {
  return importSpecifiers(source, filename).filter(
    (specifier) => !ALLOWED_IMPORTS.some((allowed) => allowed.test(specifier)),
  )
}

describe('addon package source boundary', () => {
  it('detects raw environment, persistence, connector, and dashboard imports', () => {
    const source = [
      "import type { Env } from '../../types'",
      "import type { D1Database } from '@cloudflare/workers-types'",
      "import { useConnectorById } from '../../connectors/service'",
      "import { render } from '../../dashboard/addons'",
    ].join('\n')
    expect(forbiddenImports(source)).toEqual([
      '../../types',
      '@cloudflare/workers-types',
      '../../connectors/service',
      '../../dashboard/addons',
    ])
  })

  it('keeps every production package inside the explicit import allowlist', () => {
    const directory = join(process.cwd(), 'src', 'addons', 'packages')
    const failures = readdirSync(directory)
      .filter((name) => name.endsWith('.ts'))
      .flatMap((name) => {
        const imports = forbiddenImports(readFileSync(join(directory, name), 'utf8'), name)
        return imports.map((specifier) => `${name}: ${specifier}`)
      })
    expect(failures).toEqual([])
  })
})
```

- [ ] **Step 2: Run the boundary test and verify it catches a temporary forbidden import**

Temporarily add `import type { Env } from '../../types'` to one package file, run:

`npx vitest run tests/addon-package-boundary.test.ts`

Expected: FAIL listing the package filename and `../../types`. Remove only that temporary
line and rerun.

- [ ] **Step 3: Verify GREEN and commit the harness**

Run: `npx vitest run tests/addon-package-boundary.test.ts tests/addon-package-contract.test.ts`

Expected: both files pass.

```bash
git add tests/addon-package-boundary.test.ts
git commit -m "test(addons): enforce declarative package boundary"
```

---

### Task 5: Expose Package Compatibility as Operator Evidence

**Estimate:** 2-3 hours

**Files:**
- Modify: `src/addons/routes.ts`
- Modify: `tests/addon-routes.test.ts`
- Modify: `scripts/addon-lifecycle-receipt.mjs`
- Modify: `tests/addon-lifecycle-receipt.test.ts`

**Interfaces:**
- Consumes: `AddonCatalogEntry.packageSha256` and `mupotPortVersion`.
- Produces: owner/admin evidence fields `packageSha256` and `mupotPortVersion`; lifecycle receipt validation pins both.

- [ ] **Step 1: Add failing evidence assertions**

Extend the existing owner/admin `GET /api/addons/:key/evidence` test:

```ts
expect(body).toMatchObject({
  packageSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  mupotPortVersion: '1',
  installedVersion: '1.0.0',
})
expect(body.packageSha256).not.toBe(body.manifestSha256)
```

Extend the lifecycle receipt fixture and validator with:

```js
package_sha256: 'c'.repeat(64),
mupot_port_version: '1',
```

and reject a malformed package digest or a port version other than `1`.

- [ ] **Step 2: Run route and receipt tests and verify RED**

Run: `npx vitest run tests/addon-routes.test.ts tests/addon-lifecycle-receipt.test.ts`

Expected: FAIL because package evidence is not returned or validated.

- [ ] **Step 3: Add package fields to the owner/admin evidence response**

```ts
return c.json({
  businessStateSha256: await getBusinessStateSha256(c.env),
  packageSha256: entry.packageSha256,
  manifestSha256: entry.manifestSha256,
  mupotPortVersion: entry.mupotPortVersion,
  installedVersion: entry.manifest.version,
  mupotCompatibility: entry.manifest.mupotCompatibility,
  publisher: entry.manifest.publisher,
  trustClass: entry.manifest.trustClass,
})
```

- [ ] **Step 4: Pin package evidence in the lifecycle receipt checker**

Read `packageSha256` and `mupotPortVersion` from the evidence endpoint, emit them as
`package_sha256` and `mupot_port_version`, and validate:

```js
if (!/^[a-f0-9]{64}$/.test(receipt.package_sha256 ?? '')) errors.push('package_sha256_invalid')
if (receipt.mupot_port_version !== '1') errors.push('mupot_port_version_unsupported')
```

Do not replace or reinterpret `manifest_sha256`; both identities remain required.

- [ ] **Step 5: Run evidence tests and commit**

Run: `npx vitest run tests/addon-routes.test.ts tests/addon-lifecycle-receipt.test.ts`

Expected: both files pass, including authorization and no-secret response checks.

```bash
git add src/addons/routes.ts scripts/addon-lifecycle-receipt.mjs tests/addon-routes.test.ts tests/addon-lifecycle-receipt.test.ts
git commit -m "feat(addons): expose package compatibility evidence"
```

---

### Task 6: Verify the Reference Package and Release Boundary

**Estimate:** 4-6 hours

**Files:**
- Modify: `docs/superpowers/specs/2026-07-17-mupot-addon-microkernel-design.md`
- Modify: `docs/superpowers/plans/2026-07-17-mupot-addon-package-v1.md`
- Modify only if required by an existing release assertion: `docs/releases/v0.23.0-trusted-runtime.md`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: reviewed implementation, complete verification evidence, and deployment-ready PR.

- [ ] **Step 1: Run focused addon and Marketing/CRO verification**

Run:

```bash
npx vitest run \
  tests/addon-package-contract.test.ts \
  tests/addon-package-boundary.test.ts \
  tests/addon-contract.test.ts \
  tests/addon-registry.test.ts \
  tests/addon-bindings.test.ts \
  tests/addon-service.test.ts \
  tests/addon-routes.test.ts \
  tests/dashboard-addons.test.ts \
  tests/dashboard-marketing-cro-monitor.test.ts \
  tests/marketing-monitor-service.test.ts \
  tests/addon-lifecycle-receipt.test.ts \
  tests/marketing-monitor-lifecycle-receipt.test.ts
```

Expected: all focused files pass with no skipped tests.

- [ ] **Step 2: Run static and full-suite verification**

Run: `npm run typecheck`

Expected: exit 0 with no TypeScript diagnostics.

Run: `npm test`

Expected baseline: at least 211 test files and 3,532 tests pass, plus the new package
contract and boundary tests; zero failures.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 3: Run the no-write lifecycle evidence plan**

Run: `npm run receipt:addon-lifecycle:plan`

Expected: the plan lists package and lifecycle digests, port version `1`, the complete
fixture lifecycle, and no credential values.

- [ ] **Step 4: Update design and plan status with exact evidence**

Change the design status to `Implemented; deployment proof pending` and append a short
verification section containing the actual typecheck result, test file count, test count,
focused suite result, and lifecycle-plan result. Mark every completed plan checkbox.

- [ ] **Step 5: Request two-stage review**

First review contract compliance against
`docs/superpowers/specs/2026-07-17-mupot-addon-microkernel-design.md`; then review code
quality, migration safety, and test credibility. Resolve blocking findings before push.

- [ ] **Step 6: Commit verification documentation**

```bash
git add docs/superpowers/specs/2026-07-17-mupot-addon-microkernel-design.md docs/superpowers/plans/2026-07-17-mupot-addon-package-v1.md
git commit -m "docs(addons): record package v1 verification"
```

- [ ] **Step 7: Push and open the pull request**

```bash
git push -u origin codex/addon-standard-v0
gh pr create \
  --base main \
  --head codex/addon-standard-v0 \
  --title "feat(addons): add Mupot package microkernel contract" \
  --body "Adds a versioned Mupot-native addon package contract, dual package/lifecycle evidence, a declarative import boundary, and converts Fixture plus Marketing/CRO without changing live lifecycle digests. No external runtime dependency and no database migration."
```

Expected: CI passes and the PR reports no migration files.

---

## Completion Gate

Package v1 is complete only when:

- the production registry accepts package manifests and rejects unsupported port versions;
- Fixture and Marketing/CRO use the same package registration path;
- existing Marketing/CRO lifecycle digest checks continue to pass;
- package source-boundary tests prevent raw authority imports;
- operator evidence contains both package and lifecycle identities;
- typecheck, focused tests, full suite, and CI pass;
- a reviewer confirms there is no external agent-network dependency and no production data migration;
- the merged deployment serves the same active Marketing/CRO installation without
  `manifest_digest_drift`.
