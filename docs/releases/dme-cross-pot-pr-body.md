# Draft PR Body — Cross-pot project collaboration + Host corrections

## Scope

This PR publishes the reviewed cross-pot integration branch after two independent peer audits and aligns with issue 428 (`Publish and merge the reviewed cross-pot release branch`).

### Included work slices

- migration 0057 (`migrations/0057_project_links.sql`) for signed cross-pot envelopes and project-link delivery/receipt provenance
- project-link addon implementation (manifest, envelope, service, routes) under `src/addons/project-link/*`
- project Activity/Evidence hardening via attributed projections and project-scoped endpoints in `src/projects/projections.ts`, `src/projects/index.ts`, `src/mcp/projects.ts`, `src/dashboard/projects.ts`
- Kubernetes Agent Host corrections, receipts, and smoke/cutover evidence checks in `deploy/kubernetes/agent-host/` and `scripts/kubernetes-agent-host-*.mjs`

## Evidence map

- `docs/releases/dme-integration.md`
- `docs/dme-integration-runbook.md`
- `docs/superpowers/specs/2026-07-18-dme-cross-pot-collaboration-design.md`

## Validation commands

```bash
npx tsc --noEmit
npx vitest run \
tests/project-link-addon.test.ts \
tests/project-link-routes.test.ts \
tests/project-link-ssrf.test.ts \
tests/project-link-envelope-security.test.ts \
tests/project-projections.test.ts \
tests/send-target-confinement.test.ts \
tests/kubernetes-agent-host.test.ts \
tests/dme-integration-runbook.test.ts
```

```bash
node scripts/deploy.mjs --help >/tmp/deploy.help
node scripts/project-link-flight-evidence.mjs --help >/tmp/project-link-flight-evidence.help
node scripts/kubernetes-agent-host-receipt.mjs --help >/tmp/kubernetes-agent-host-receipt.help
node scripts/kubernetes-agent-host-activate.mjs --help >/tmp/kubernetes-agent-host-activate.help
```

## Reviewer requirements for merge

- Second peer audit findings addressed and green in this branch
- Human reviewer approval in GitHub PR
- Evidence receipts and receipts-driven proofs uploaded by operator
