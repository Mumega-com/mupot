# SOS-Conformant Mupot Addon Packages Design

**Status:** Approved direction
**Date:** 2026-07-17
**Depends on:** `2026-07-15-addon-framework-design.md`
**Reference package:** Marketing & CRO Monitor

## 1. Goal

Make the existing Mupot addon rail conform explicitly to the SOS plugin boundary and
Mupot substrate contract without invalidating live tenant installations or their
receipts.

The first deliverable is a package-level contract that:

- declares the Mupot substrate port version used by an addon package;
- keeps addon packages declarative and free of direct persistence, secret, auth, and
  request-context dependencies;
- preserves the existing `mupot.addon/v1` lifecycle manifest and its SHA-256 identity;
- makes Marketing & CRO Monitor the first conformant package;
- supplies a reusable conformance test for the next business addon.

## 2. Existing Contracts Remain Authoritative

This design does not introduce a new kernel or lifecycle model. It composes contracts
that already exist:

- SOS owns agent identity, capabilities, bus communication, audit, and runtime profiles.
- Mupot owns tenant membership, addon lifecycle, connector bindings, flights, gates,
  receipts, and the operator console.
- `mupot.addon/v1` remains the tenant lifecycle and authority manifest.
- department manifests remain the source of metric and organizational declarations.
- connectors remain sealed host ports; packages name slots and adapter kinds, never
  credentials.
- trusted host implementations resolve D1, Worker bindings, and connector credentials at
  execution boundaries. Package manifests cannot access those implementations directly.

SOS host runtime profiles and Mupot addon packages remain separate concepts. A Hermes,
Codex, Claude, or local-script profile describes a teammate runtime. An addon package
describes a business capability installed in a pot. An addon may later require a runtime
profile, but it does not own or redefine SOS onboarding.

## 3. Approaches Considered

### 3.1 Add `mupotPortVersion` directly to `mupot.addon/v1`

This is visually simple but changes canonical manifest JSON and therefore the immutable
SHA-256 stored on every installation, binding generation, monitor run, and receipt. The
live Marketing & CRO installation would fail digest checks because addon upgrade and
receipt migration are intentionally not implemented yet.

### 3.2 Replace Mupot manifests with the SOS plugin manifest

This would erase useful product semantics such as departments, connector slots, loops,
approval policies, retention, and console sections. SOS and Mupot operate at different
layers; forcing one schema to serve both would weaken both contracts.

### 3.3 Add a package manifest around the existing lifecycle manifest

This is the selected approach. The package manifest is the loader and substrate boundary.
The nested addon manifest remains the tenant authority and lifecycle identity. The
registry validates and hashes both, but existing installation matching continues to use
the unchanged lifecycle digest until a separately designed upgrade migration exists.

## 4. Package Contract

The additive contract is intentionally small:

```ts
interface AddonPackageManifestV1 {
  schema: 'mupot.addon-package/v1'
  mupotPortVersion: '1'
  addon: AddonManifestV1
}
```

`mupotPortVersion` identifies the sealed host-port contract available to the package. It
is independent from `mupotCompatibility`, which remains the compatible Mupot product
release range. Port v1 is additive-only. A breaking host-port change requires a new port
version and a parent-owned migration shim before packages can register against it.

Validation follows the current fail-closed manifest discipline:

- only the three declared top-level fields are accepted;
- the object must be canonical data with no accessors, symbols, hidden properties, or
  custom prototype behavior;
- the nested lifecycle manifest must pass `validateAddonManifest`;
- the package's supported port version must match a host-supported version;
- native/external trust semantics continue to come from the nested manifest;
- canonical package JSON and SHA-256 are stable across property insertion order.

## 5. Registry and Digest Semantics

The addon registry registers `AddonPackageManifestV1`, not an unwrapped lifecycle
manifest. A catalog entry exposes:

- the frozen package;
- the nested frozen lifecycle manifest;
- `mupotPortVersion`;
- `packageSha256` for package/catalog evidence;
- the existing `manifestSha256` for tenant lifecycle evidence.

The registry rejects an unsupported port version before resolving departments, metrics,
or console renderers. It deep-clones and freezes both package and nested manifest. There
is still no replace, clear, or unregister operation on the production registry.

This slice does not persist `packageSha256`. Existing installations, bindings, monitor
runs, and receipts continue matching `manifestSha256` byte-for-byte. Persisting package
identity belongs to the future addon-upgrade migration, where historical and replacement
versions can coexist explicitly.

## 6. Package and Host Layout

Files are separated by authority:

```text
src/addons/package-contract.ts
  Package schema, validation, canonical hash, supported port constant

src/addons/packages/*.ts
  Declarative package + lifecycle manifest data

src/addons/modules/*.ts
  Host registration, pre-registered console renderer wiring, compatibility re-exports

src/addons/service.ts, bindings.ts, marketing/*
  Trusted host lifecycle and adapter implementations
```

Package files may import type contracts and registered department manifest constants.
They may not import:

- Cloudflare persistence types or raw `Env`;
- addon lifecycle services or connector resolution/decryption;
- auth/session/request routing;
- dashboard renderers;
- tasks, flights, gates, audit writers, or bus publishers;
- arbitrary network clients.

This is an architectural confinement boundary inside one Worker bundle, not a process
sandbox. Native host implementations remain reviewed code. External/community code must
run outside the Worker and connect through the existing external MCP boundary.

## 7. Marketing & CRO Reference Package

The current `MarketingCroMonitorAddon` data moves unchanged into
`src/addons/packages/marketing-cro-monitor.ts` and is wrapped by
`MarketingCroMonitorAddonPackage` with port version `1`.

The lifecycle manifest's fields, version `1.0.0`, canonical JSON, and SHA-256 remain
unchanged. The host registration module continues to register the existing console
renderer and then registers the package. Existing imports of `MarketingCroMonitorAddon`
remain valid through a compatibility re-export.

The fixture addon receives the same treatment so the lifecycle receipt checker and the
package conformance harness exercise the same production registration path.

## 8. Conformance Harness

The automated harness proves:

1. A valid package registers and exposes both stable digests.
2. Missing, unknown, malformed, and unsupported package fields fail closed.
3. The nested lifecycle manifest is still validated by the existing contract.
4. Package and nested manifest values are deeply frozen after registration.
5. Marketing & CRO declares port version `1`, preserves its lifecycle digest, and remains
   read-only with zero requested authority.
6. Every file under `src/addons/packages/` stays inside an explicit import allowlist.
7. A synthetic second package can register without edits to identity, RBAC, audit, bus,
   schema, navigation, lifecycle service, or the Marketing package.

The static import test is deliberately narrow. It protects declarative package files,
not trusted host adapters. Host adapter behavior remains covered by lifecycle, binding,
source, tenant-isolation, no-secret, and receipt tests.

## 9. Error Handling

Package validation returns stable reason codes and optional field paths. Registry errors
use stable package-prefixed codes:

- `addon_package_invalid:<reason>`;
- `addon_port_incompatible`;
- existing nested runtime errors such as `addon_department_not_registered`.

No package validation failure writes tenant state or emits a lifecycle receipt because
registration happens before tenant installation is available.

## 10. Non-Goals

- changing live addon installation, binding, run, or receipt digests;
- implementing addon upgrade, rollback, signature verification, or marketplace trust;
- loading arbitrary third-party JavaScript into the Worker;
- merging SOS runtime profiles with business addon manifests;
- refactoring trusted Marketing source and lifecycle services into a new execution model;
- activating DME or adding write-capable Marketing/CRO operations.

Signature and sandbox metadata from the SOS plugin draft can be added to a future package
schema when external/community package distribution is enabled. They are not meaningful
security controls for compiled native packages in this slice.

## 11. Acceptance Criteria

- `AddonPackageManifestV1` is a validated, canonical, versioned public contract.
- the registry refuses packages whose substrate port version is unsupported;
- Marketing & CRO and the fixture register through package manifests;
- Marketing & CRO's existing lifecycle manifest SHA-256 does not change;
- package source files cannot import raw persistence, secret, auth, routing, or execution
  surfaces without failing the conformance suite;
- all existing addon, Marketing/CRO, typecheck, and full repository tests pass;
- no migration or production data rewrite is required.
