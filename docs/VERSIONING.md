# Versioning policy

Pre-1.0 semver. The version answers one question for an operator or an agent: "did
anything I can observe change?"

| Bump | When | Examples |
|---|---|---|
| PATCH `0.x.Y` | Bug fixes, security fixes, dependency advisories, docs. No new tool, route, migration or addon. | A broken form field, a bind-count fix, an override bump. |
| MINOR `0.X.0` | Any new MCP tool, REST route, dashboard surface, migration, addon, or behaviour an agent or operator can observe. Also any removal or tightening, because pre-1.0 has no separate major: flag it **Breaking** in the changelog. | `task_get`, a new receipts table, an allowlist that hides tools. |
| `1.0.0` | Hadi's call. Requires frozen public contracts (see ROADMAP). | |

UI/UX polish, documentation and skills text do not by themselves move the version.

## Source of truth

`package.json` `"version"`. `/health`, MCP `serverInfo.version` and the OpenAPI info block
report `MUPOT_PUBLIC_API_VERSION` in `src/version.ts`; a test
(`tests/dme-integration-runbook.test.ts`) requires the two to be equal, so they move
together. Addon `mupotCompatibility` pins are separate (below).

## Every release

1. One release PR bumps `package.json`, `package-lock.json` (root `version`),
   `src/version.ts`, and moves `[Unreleased]` in `CHANGELOG.md` into a dated
   `## [X.Y.Z] — YYYY-MM-DD` section, in the same commit. A fresh empty `[Unreleased]`
   stays on top.
2. After merge: annotated tag `vX.Y.Z` on the merged commit, then deploy, then read
   `/health` and record it in ROADMAP "Current version".
3. A tag, a deploy and a merge are separate approvals. This document does not grant any.

## What CI already enforces

`release-truth` (`.github/workflows/ci.yml`, `scripts/release-truth-policy.mjs`) reads
`CHANGELOG.md`, `ROADMAP.md`, `docs/releases/next-flights.md`, `docs/releases/v0.30.0.md`
and fails on:

- R1: a line asserting current `main` that carries a commit SHA;
- R2: a "current source version" claim that differs from `package.json`;
- R3: a "latest tagged stable release" claim that differs from the newest `vX.Y.Z` tag;
- R4: a production SHA stated without a "last recorded deploy" style label.

It does not check that the changelog has a section for the `package.json` version, nor
that `src/version.ts` and the addon pins agree beyond the runtime registry check. Those
are owed by the release PR author; a parity check is a candidate follow-up.

## Addon compatibility pins: why a bump is not just a bump

`assertAddonRuntimeContract` (`src/addons/registry.ts`) lets a **native** addon pinned
`^0.N.0` run on `0.(N+1).x` only (one-minor grace); **external_isolated** addons (mcpwp
office) get strict caret semver, i.e. on 0.x a `^0.31.0` pin accepts only `0.31.x`.
`matchesRegisteredIdentity` byte-compares each live installation's `manifest_sha256` and
`mupot_compatibility` with the registered manifest, and an immutability trigger blocks
ordinary updates. So a MINOR bump that leaves a pin outside its window makes the Worker
throw `addon_mupot_incompatible` at boot, and moving the pin drifts every live
installation unless a backfill migration (precedents: 0089, 0181) moves identity in the
same deploy.

Consequences for the policy:

- A MINOR release that touches `src/version.ts` is a runtime release. It needs the pin
  bumps plus a backfill migration, reviewed like any migration.
- A PATCH release never changes a pin and stays inside every window.
- Recommended follow-up (not done here): decouple addon compatibility from the exact
  host minor (compare against a separate `ADDON_API_VERSION` that moves only when the
  addon contract changes), so ordinary MINOR releases stop forcing identity migrations.

## Status of 0.32.0

The 0.32.0 changelog section is written. The bump is held back because of the pin
mechanics above: it needs its own runtime PR (version, five native pins to `^0.31.0`,
office pin to `^0.32.0`, backfill migration, digest test in the style of
`tests/addon-manifest-backfill-0181.test.ts`) and a read-only check of live
`addon_installations` before deploy.
