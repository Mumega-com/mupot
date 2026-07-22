# DME integration runbook — clean pots to matching evidence

Operator runbook for reproducing Mumega↔DME cross-pot collaboration from **two
clean pots**. Pair it with the [DME integration release receipt](./releases/dme-integration.md),
which pins tested versions, checks, and evidence schemas.

Design background: [DME cross-pot collaboration](./superpowers/specs/2026-07-18-dme-cross-pot-collaboration-design.md).
Mumega-specific human gates (first paying tenant): [DME activation runbook](./dme-activation-runbook.md).
Kubernetes Host detail: [runtime starter](./runtime-starter.md) (Kubernetes section).

## Goal

From two empty sovereign pots, an operator can:

1. install and migrate the same `v0.24` code on both pots;
2. activate the `project-link` addon on both;
3. mint welded agent tokens with show-once handling;
4. choose an activation mode per runtime;
5. pair distinct projects with mutual signed links;
6. run one governed cross-pot flight;
7. verify matching destination-signed receipts;
8. roll back without overlapping consumers or leaking credentials.

## Topology (clean pots)

Use **distinct** project, squad, agent, link, and key IDs on each pot. Same-ID
mirroring is forbidden.

```text
Coordinator pot (example: mumega)
└── DME Integration          ← development / sanitized evidence only
    ├── Core Platform (admin)
    └── DME Delivery (write)

Customer pot (example: dme)
└── DME Operations
    └── DME Hermes Kubernetes ← customer operations; DME owns identity + secrets
```

Never copy customer records, marketing credentials, raw analytics, message
bodies, private prompts, or model memory into the coordinator project.

---

## Installation

### 1. Two clean pots on the same release

On each Cloudflare account (or two local configs):

```bash
npm install
npx wrangler login
scripts/provision-pot.sh "$POT"          # writes wrangler.$POT.toml + migrations
npx wrangler deploy --config "wrangler.$POT.toml"
bash scripts/secrets.sh --pot "$POT"     # or --bootstrap-owner for first owner
```

Both pots must report the same public API version after deploy:

```bash
curl -fsS "https://$COORDINATOR_HOST/health"
curl -fsS "https://$CUSTOMER_HOST/health"
# expect version "0.24.0" (see docs/releases/dme-integration.md)
```

Full binding contract and upgrade path: [SELF-HOST](./SELF-HOST.md),
[production runbook](./production-runbook.md).

### 2. Project-link signing key (per pot)

Each pot needs its **own** Ed25519 private OKP JWK as Worker secret
`PROJECT_LINK_SIGNING_KEY`. Never share a private key with the peer pot; only
the public key travels in the pairing payload.

```bash
# Generate offline; put ONLY the private JWK into the Worker secret store.
npx wrangler secret put PROJECT_LINK_SIGNING_KEY --config "wrangler.$POT.toml"
```

### 3. Activate the `project-link` addon on both pots

Owner/admin only. Lifecycle is install → configure → activate (same HTTP surface
as other native addons):

```bash
for ACTION in install configure activate; do
  curl -fsS -X POST \
    -H "Authorization: Bearer $OWNER_TOKEN" \
    -H "content-type: application/json" \
    "https://$HOST/api/addons/project-link/$ACTION"
done
```

Manifest: key `project-link`, version `1.0.0`, `mupotCompatibility: ^0.24.0`,
`trustClass: native_reviewed`. Disable preserves data; archive requires owner.

### 4. Clean local reproduction (no live credentials)

The dual-pot Vitest harness is the authoritative clean reproduction of pairing,
delivery, SSRF refusal, envelope security, and receipt matching:

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

---

## Token handling

### Mint path (mandatory)

Mint **only** through `mintAgentBoundToken` — dashboard
`POST /admin/agent-token/mint` or MCP `mint_agent_token`. That path:

- creates/reuses one canonical member envelope per agent;
- welds `member_tokens.agent_id` to the agent;
- caps capability at squad-scoped `member` or `observer` (never lead/admin/owner);
- stores only the token hash; shows the raw bearer **once**.

Do not hand-insert token rows. Do not reuse a coordinator token on the customer
pot (or the reverse). A runtime that talks to two pots uses two independently
minted profiles.

### Show-once and storage

- Copy the raw token into a secret manager or a read-only Kubernetes Secret /
  file mount at mint time.
- Never put bearer values in JSON config, receipts, argv, shell history, bus
  cleartext, ConfigMaps, or Git.
- Kubernetes Host mounts the DME welded token as a read-only file from a
  DME-owned Secret (`dme-mupot-agent-host`). The Host, probe shell, and inbox
  dispatcher never receive the bearer as an environment variable.

### DME Host allowlist (tool surface)

When minting the Kubernetes Host identity, keep the tool allowlist narrow
(Codex design). Typical allowlist:

`boot_context`, `orient`, `status`, `check_in`, `peers`,
`inbox_consumer_status`, `project_get`, `project_squad_list`, `task_list`,
`task_board`, `task_update`, `flight_get`, `flight_list`, `flight_land`, `send`.

No memory tools on that member (would break the one-project ceiling). Zero org
grants; one project-squad member grant; separate Ed25519 signing key.

### Revocation

Revoke the token row (dashboard / admin path). Re-mint is safe after a clean
revoke. Revoking either runtime token or either project link stops future
delivery without deleting prior receipts.

---

## Activation modes

Authority does not change across modes — only how the runtime wakes.

| Mode | Where | Behavior |
|------|--------|----------|
| **On demand** | Desktop Hermes / Codex session | Operator opens a session; MCP tools load at session start (restart after connection install). Reads inbox and project tasks when asked. |
| **Supervised background** | macOS LaunchAgent / Linux systemd subscriber | Narrow subscriber peeks one durable inbox item, persists it, invokes the welded profile, persists the response, sends a correlated reply, then consumes. Rejects unauthorized senders; preserves `request_id` / `in_reply_to`. |
| **Kubernetes Host** | Customer cluster (`deploy/kubernetes/agent-host`) | Zero-replica install → cutover preflight → plugin smoke → release receipt → guarded activation to one replica. Inbox fence CAS `bearer_only` → `signed_only` before scale-up. Never overlap Host and legacy `mupot-subscriber`. |

Installer / Host commands and receipts: [runtime starter](./runtime-starter.md).

---

## Project pairing

### Contract

On **each** pot, an owner/admin creates one active link via `createProjectLink`
(service API — never raw `INSERT INTO project_links`). Required fields:

| Field | Rule |
|-------|------|
| `id` | Opaque local link id (distinct from peer) |
| `local_project_id` / `local_squad_id` / `local_agent_id` / `local_key_id` | Local identities with write access |
| `remote_pot` | Peer `TENANT_SLUG` (must differ from local) |
| `remote_project_id` / `remote_link_id` / `remote_agent_id` / `remote_key_id` | Peer's corresponding ids |
| `remote_public_key` | Peer's **public** Ed25519 JWK |
| `remote_base_url` | Public `https://` origin only (no userinfo, path, query, fragment, non-443 port, private/special-use hosts) |
| `capabilities` | Subset of `project.task.write`, `project.evidence.write` |
| `approved_evidence_origins` | HTTPS origins allowed for evidence URLs (required when evidence write is granted) |
| `stale_after_seconds` | Integer in `[30, 86400]` |

Mutual pairing means pot A stores B's public key and base URL, and pot B stores
A's. Delivery dials:

`POST {remote_base_url}api/project-links/{remote_link_id}/deliver`

### Allowed envelope (summary)

Signed `mupot.project-link-envelope/v1` may carry pot/project/agent/key ids,
correlation / task / flight / request ids, sanitized task fields, evidence hash
+ media type + authorized URL, capability, expiry, and idempotency key.

It must **not** carry raw customer data, access tokens, API keys, private
prompts, full transcripts, contact lists, or analytics exports. Envelope
validation fails closed on credential-shaped / sensitive strings
(`prohibited_content`).

### Destination reauthorization

The destination pot re-checks RBAC and link state before every atomic write.
Matching hashes alone are **not** authentication — the destination Ed25519
receipt signature is.

---

## Evidence verification

After one governed Mumega→DME (or fixture→fixture) flight, keep the correlation
id and dispatch time. Prove matching receipts from **both** project Evidence
APIs with independently scoped read-only token **files** (never argv):

```bash
npm run --silent receipt:project-link-flight -- \
  --source-url "https://$COORDINATOR_HOST" \
  --source-pot "$COORDINATOR_POT" \
  --source-project "$COORDINATOR_PROJECT_ID" \
  --source-token-file /run/secrets/coordinator-project-reader/token \
  --destination-url "https://$CUSTOMER_HOST" \
  --destination-pot "$CUSTOMER_POT" \
  --destination-project "$CUSTOMER_PROJECT_ID" \
  --destination-token-file /run/secrets/customer-project-reader/token \
  --correlation "$CORRELATION_ID" \
  --not-before "$FLIGHT_DISPATCH_ISO" \
  --output ./receipts/project-link-flight.json
```

Accept only when `project-link-flight.json` reports:

- `schema: "mupot.project-link-flight-evidence/v1"`
- `status: "pass"`
- matching `shared_receipt_sha256`, `envelope_sha256`, `evidence_sha256`
- matching destination `receipt_key_id` + `receipt_signature`

Kubernetes Host release (before activation) requires a passing
`mupot-kubernetes-agent-host-receipt/v1` that recursively checks plugin smoke
(`mupot.hermes-plugin-smoke/v1` evidence), image provenance, and cutover
preflight. Commands: [runtime starter](./runtime-starter.md).

The aggregate version/check/evidence table lives in
[docs/releases/dme-integration.md](./releases/dme-integration.md).

---

## Troubleshooting

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| `addon_inactive` / 410 on deliver | Addon not activated on destination | Re-run install→configure→activate on that pot |
| `invalid_link` at create | Bad URL, private host, capability set, or key | Fix `remote_base_url` / public key / capabilities; never bypass with SQL |
| `invalid_signature` / 401 | Wrong peer public key or envelope tampering | Re-export public keys; re-pair; do not reuse revoked keys |
| `mapping_mismatch` / 403 | Project/link/agent ids disagree | Re-check mutual pairing table; ids must be distinct across pots |
| `capability_denied` / 403 | Requested capability not on link or squad | Narrow envelope capability or widen link capabilities deliberately |
| `link_revoked` / 410 | Link revoked on either side | Re-create a new link id; do not revive revoked rows |
| `prohibited_content` | Credential-shaped or sensitive string in envelope | Sanitize title/progress/evidence URL; never ship tokens |
| `send_target_not_visible` | Welded token cannot see recipient | Confirm squad/project grants; confinement is intentional |
| Flight evidence `fail` | Hash/signature mismatch or stale receipt | Confirm same correlation, `not-before`, and destination signature |
| Host activation rolls back to zero | Preflight/smoke/fence drift | Inspect `activation.json`; fix drift; never force one replica by hand |
| Two consumers active | Host + legacy subscriber overlap | Scale Host to zero; restore only after `rollback-ready` |

---

## Rollback

### Project link

1. Owner revokes the link on each pot (`revokeProjectLink` / admin path).
2. Revoke welded tokens that were minted only for the integration.
3. Prior receipts remain; remote status becomes stale after `stale_after_seconds`.

### Kubernetes Host

Roll back in reverse of cutover — never overlap consumers:

```bash
# Scale Host to zero and wait for termination, then:
node scripts/kubernetes-agent-host-cutover-preflight.mjs --mode rollback-ready \
  > ./receipts/rollback-ready.json
# Restore legacy mupot-subscriber only after rollback-ready passes.
# CAS inbox consumer signed_only → bearer_only with owner/admin credential.
node scripts/kubernetes-agent-host-cutover-preflight.mjs --mode rollback-complete \
  > ./receipts/rollback-complete.json
```

`rollback-complete` requires Host inert, live fence `bearer_only` at a positive
generation, and the legacy subscriber only in the preserved DME Deployment.

### Addon

`POST /api/addons/project-link/disable` stops delivery while preserving data.
`archive` is owner-only and ends the installation lifecycle.

### Pot deploy

Worker rollback is independent per pot (`npx wrangler rollback <VERSION_ID>`).
Revoke links before rolling either pot below `project-link` compatibility
`^0.24.0`.

---

## Operator checklist (clean pots)

- [ ] Both pots provisioned, migrated, and reporting `0.24.0`
- [ ] Distinct `PROJECT_LINK_SIGNING_KEY` on each pot
- [ ] `project-link` addon active on both
- [ ] Projects, squads, agents created with **distinct** ids
- [ ] Welded tokens minted via `mintAgentBoundToken`; secrets file-mounted only
- [ ] Mutual links created via `createProjectLink` (not raw SQL)
- [ ] Activation mode chosen; Host remains zero replicas until guarded activate
- [ ] One watched flight; `mupot.project-link-flight-evidence/v1` status `pass`
- [ ] Isolation denies (wrong project/recipient/forged receipt) exercised before retirement
- [ ] Rollback path rehearsed (`rollback-ready` / `rollback-complete` or link revoke)
