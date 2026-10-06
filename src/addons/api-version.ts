// The addon API contract version — the ONLY version addon manifests are
// compatibility-checked against (assertAddonRuntimeContract in registry.ts).
//
// This is deliberately separate from MUPOT_PUBLIC_API_VERSION (src/version.ts),
// the product release version reported by /health and MCP serverInfo. A product
// release no longer touches addon manifests, their digests, or any live
// addon_installations row.
//
// Bump rules (semver on the addon contract itself, not on the product):
//   patch  — a clarification or bug fix that does not change what a manifest
//            may declare or how the host interprets it.
//   minor  — additive: new optional manifest fields / new host capabilities an
//            existing manifest is free to ignore. Manifests pinned `^1.0.0`
//            keep registering.
//   major  — breaking: a manifest field is removed/re-meant or a host
//            invariant is tightened. Every manifest must be re-reviewed and
//            re-pinned (`addonApiCompatibility`), which does NOT change its
//            digest-bound identity (the field is excluded from the digest —
//            see canonicalManifestJson in contract.ts).
export const ADDON_API_VERSION = '1.0.0' as const
