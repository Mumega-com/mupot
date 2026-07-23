# DME integration release receipt

**Status:** published operator evidence map for `v0.24.0` Project Operations
cross-pot collaboration (Mumega↔DME / clean dual-pot reproduction).

**Runbook:** [DME integration runbook](../dme-integration-runbook.md)

**Design:** [DME cross-pot collaboration](../superpowers/specs/2026-07-18-dme-cross-pot-collaboration-design.md)

This receipt does not mint live credentials or authorize production cutover. It
links the **tested versions**, **automated checks**, and **matching evidence
schemas** an operator must collect before calling an integration green.

## Tested versions

| Artifact | Version / pin | Source |
|----------|---------------|--------|
| Mupot package | `0.24.0` | `package.json` |
| Public API | `0.24.0` | `src/version.ts` → `MUPOT_PUBLIC_API_VERSION` |
| Project-link addon | `1.0.0` | `src/addons/project-link/manifest.ts` |
| Addon compatibility | `^0.24.0` | same manifest `mupotCompatibility` |
| Envelope schema | `mupot.project-link-envelope/v1` | `src/addons/project-link/envelope.ts` |
| Receipt payload | `mupot.project-link-receipt/v1` | `src/addons/project-link/service.ts` |
| Receipt proof projection | `mupot.project-link-receipt-proof/v1` | project Evidence |
| Hermes plugin (Host smoke) | `mupot` `0.3.0` / toolset `mupot-operator` | plugin ConfigMap + smoke Job |
| Migrations floor | `0057_project_links.sql` (+ later additive) | `migrations/` |

Both pots in a live pairing must report the same public API version on
`GET /health` before pairing.

## Automated checks

Run from a clean checkout of this release:

```bash
npx tsc --noEmit
npx vitest run \
  tests/project-link-addon.test.ts \
  tests/project-link-routes.test.ts \
  tests/project-link-ssrf.test.ts \
  tests/project-link-envelope-security.test.ts \
  tests/send-target-confinement.test.ts \
  tests/kubernetes-agent-host.test.ts \
  tests/dme-integration-runbook.test.ts
```

| Check | Proves |
|-------|--------|
| `tests/project-link-addon.test.ts` | Dual-pot install/configure/activate, mutual pairing, deliver, revoke, matching receipts |
| `tests/project-link-routes.test.ts` | `POST /api/project-links/:linkId/deliver` HTTP surface |
| `tests/project-link-ssrf.test.ts` | Private/special-use `remote_base_url` refused; redirect-refuse on dial |
| `tests/project-link-envelope-security.test.ts` | Domain-separated signatures; prohibited customer/credential content |
| `tests/send-target-confinement.test.ts` | Welded-token send confinement (no existence oracle) |
| `tests/kubernetes-agent-host.test.ts` | Host manifest, smoke, cutover preflight, release receipt invariants |
| `tests/dme-integration-runbook.test.ts` | This receipt and the operator runbook stay discoverable and complete |

Optional product-surface evidence (local pots):

```bash
npm run migrate:local:test
npm run seed:local:test
npm run smoke:local
npm run conformance:runtime:local
```

## Matching evidence (machine schemas)

Collect redacted artifacts under an operator-owned `./receipts/` directory. Never
embed bearer tokens, private JWKs, or customer payloads.

| Evidence file | Schema / receipt type | Producer | Pass condition |
|---------------|----------------------|----------|----------------|
| `project-link-flight.json` | `mupot.project-link-flight-evidence/v1` | `npm run receipt:project-link-flight` | `status:"pass"`; matching hashes + destination signature on both pots |
| `kubernetes-agent-host.json` | `mupot-kubernetes-agent-host-receipt/v1` | `npm run receipt:kubernetes-agent-host` | `status:"pass"`; Host still zero replicas |
| `hermes-plugin-smoke-evidence.json` | embeds `mupot.hermes-plugin-smoke/v1` | `npm run receipt:kubernetes-hermes-plugin-smoke` | smoke discovery pass bound to image + ConfigMap |
| `cutover-preflight.json` | cutover preflight type from `kubernetes-agent-host-cutover-preflight.mjs` | `node scripts/kubernetes-agent-host-cutover-preflight.mjs` | legacy subscriber absent; Host inert; fresh ≤5 min |
| `activation.json` | guarded activation output | `npm run activate:kubernetes-agent-host` | `status:"pass"` after fence + readiness |
| `rollback-ready.json` / `rollback-complete.json` | preflight `--mode` | cutover preflight script | Host inert; fence `bearer_only` before legacy restore completes |

### Flight evidence command (both pots)

```bash
npm run --silent receipt:project-link-flight -- \
  --source-url https://COORDINATOR_HOST \
  --source-pot COORDINATOR_POT \
  --source-project COORDINATOR_PROJECT_ID \
  --source-token-file /run/secrets/coordinator-project-reader/token \
  --destination-url https://CUSTOMER_HOST \
  --destination-pot CUSTOMER_POT \
  --destination-project CUSTOMER_PROJECT_ID \
  --destination-token-file /run/secrets/customer-project-reader/token \
  --correlation CORRELATION_ID \
  --not-before FLIGHT_DISPATCH_ISO \
  --output ./receipts/project-link-flight.json
```

Hashes that must match across pots for a green flight:

- `shared_receipt_sha256`
- `envelope_sha256`
- `evidence_sha256` (non-null for evidence actions)
- destination `receipt_key_id` + `receipt_signature`

## Integration green definition

Call the integration **reproducible and green** only when all are true:

1. Versions in the table above agree on both pots (or the dual-pot Vitest harness).
2. Automated checks listed above pass on the release SHA.
3. `mupot.project-link-flight-evidence/v1` reports `status:"pass"` for the watched correlation.
4. When the Kubernetes Host is in scope: Host release receipt pass at zero replicas, then guarded activation pass — or a rehearsed rollback with `rollback-complete`.
5. No token, private key, or customer payload appears in any retained receipt.

## Related Mumega activation gates

Human-authorized first-tenant gates (deploy, mint, watched flight) remain in
[docs/dme-activation-runbook.md](../dme-activation-runbook.md). This receipt is
the versioned evidence map those gates consume; it does not replace Gate A–D
owner approval.
