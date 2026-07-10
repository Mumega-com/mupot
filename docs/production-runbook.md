# Production self-hosting runbook

This runbook is for an operator running one Mupot pot in their own Cloudflare
account. It covers production deploy, upgrade, backup, restore, rollback, and
incident response. For local browser validation, use
[`scripts/README.md`](../scripts/README.md).

Use placeholders until your real pot values are known:

```bash
export POT=acme
export CONFIG="wrangler.${POT}.toml"
export WORKER="mupot-${POT}"
export DB="mupot-${POT}"
export BUCKET="mupot-${POT}-blobs"
export BASE_URL="https://<your-pot-host>"
export BACKUP_DIR="backups/${POT}/$(date -u +%Y%m%dT%H%M%SZ)"
```

Do not put `wrangler.${POT}.toml`, `.dev.vars`, `.env`, backup SQL, R2
credentials, or secret value files in git.

## Required Cloudflare resources

The binding names are the contract. Resource names can vary by pot, but
`wrangler.${POT}.toml` must declare these bindings before production deploy:

| Binding | Cloudflare resource | Production note |
|---|---|---|
| `DB` | D1 database | Holds org, members, capabilities, tasks, approvals, loops, audit, fleet, and integration metadata. |
| `VEC` | Vectorize index | Semantic memory and recall. Match dimensions to the embedding model. |
| `BUS` | Queue producer/consumer plus DLQ | Internal async event bus. Configure the dead-letter queue. |
| `SESSIONS` | KV namespace | Dashboard sessions, OAuth nonce/state, replay guards, lightweight cache. |
| `OAUTH_KV` | KV namespace | OAuth 2.1 provider clients, grants, and access-token state. Keep separate from sessions. |
| `BLOBS` | R2 bucket | Files, exported artifacts, and larger objects. |
| `AI` | Workers AI binding | Default model/embedding binding. |
| `AGENT` | Durable Object binding | Per-agent state and alarms. |
| `SQUAD` | Durable Object binding | Per-squad coordination state and alarms. |
| `TASK_WORKFLOW` | Workflows binding | Durable task pipeline for gated execution. |

Provision a new pot:

```bash
npx wrangler login
scripts/provision-pot.sh "$POT"
cp wrangler.example.toml "$CONFIG"
```

Paste the printed resource IDs and names into `$CONFIG`, then review:

```bash
grep -nE 'name =|TENANT_SLUG|binding =|database_name|database_id|index_name|queue =|bucket_name' "$CONFIG"
npx wrangler deploy --dry-run --config "$CONFIG"
```

## Secret setup and rotation

Secrets are Worker secrets. Enter them through the Wrangler prompt; do not pass
secret values as command arguments.

Required for dashboard login:

```bash
npx wrangler secret put OAUTH_CLIENT_ID --config "$CONFIG"
npx wrangler secret put OAUTH_CLIENT_SECRET --config "$CONFIG"
```

Required only when exposing the Google-backed MCP OAuth 2.1 provider:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID --config "$CONFIG"
npx wrangler secret put GOOGLE_CLIENT_SECRET --config "$CONFIG"
```

Optional, depending on integrations:

```bash
npx wrangler secret put GITHUB_TOKEN --config "$CONFIG"
npx wrangler secret put AI_GATEWAY_TOKEN --config "$CONFIG"
npx wrangler secret put GHL_API_KEY --config "$CONFIG"
npx wrangler secret put GHL_LOCATION_ID --config "$CONFIG"
npx wrangler secret put GHL_WEBHOOK_SECRET --config "$CONFIG"
npx wrangler secret put LOOP_SECRET_<name> --config "$CONFIG"
```

Check names, not values:

```bash
npx wrangler secret list --config "$CONFIG"
```

Rotate a secret by revoking the old credential at the upstream provider, then
overwriting the Worker secret:

```bash
npx wrangler secret put GHL_WEBHOOK_SECRET --config "$CONFIG"
npx wrangler secret list --config "$CONFIG"
```

Delete a no-longer-used secret:

```bash
npx wrangler secret delete LOOP_SECRET_<name> --config "$CONFIG"
```

Run production validation after every secret rotation.

## Initial deploy

Apply D1 migrations before first live traffic:

```bash
npx wrangler d1 migrations apply "$DB" --remote --config "$CONFIG"
```

Deploy once, set secrets if Wrangler required the Worker to exist first, then
deploy again:

```bash
npx wrangler deploy --config "$CONFIG" --message "initial ${POT} production deploy"
npx wrangler secret list --config "$CONFIG"
npx wrangler deploy --config "$CONFIG" --message "production secrets configured"
```

Register OAuth redirect URLs with the identity provider before inviting users:

```text
Dashboard login: https://<your-pot-host>/auth/callback
MCP OAuth provider: https://<your-pot-host>/oauth/google-callback
```

## Upgrade path

Prefer the update guard when the pot is listed in `pots.manifest.json`:

```bash
git fetch origin
git status -sb
npm install
npm test
npm run typecheck
node scripts/mupot-update.mjs "$POT"
```

The bare `mupot-update` run is a dry run. It checks pending migrations,
destructive migration patterns, required bindings, source ref, and health
configuration without mutating the pot.

Apply only after reading the dry-run:

```bash
node scripts/mupot-update.mjs "$POT" --apply
```

If the pot is not in `pots.manifest.json`, use the manual path:

```bash
git fetch origin
git status -sb
npm install
npm test
npm run typecheck
npx wrangler d1 migrations list "$DB" --remote --config "$CONFIG"
npx wrangler d1 migrations apply "$DB" --remote --config "$CONFIG"
npx wrangler deploy --config "$CONFIG" --message "upgrade ${POT} to $(git rev-parse --short HEAD)"
```

Do not apply a migration to production until a D1 backup exists for the current
production state.

## Backup

Create the backup directory:

```bash
mkdir -p "$BACKUP_DIR"
git rev-parse HEAD > "$BACKUP_DIR/git-sha.txt"
cp "$CONFIG" "$BACKUP_DIR/"
cp pots.manifest.json "$BACKUP_DIR/" 2>/dev/null || true
npx wrangler secret list --config "$CONFIG" > "$BACKUP_DIR/worker-secret-names.json"
```

The secret-name export is an inventory only. It does not contain secret values.
Keep actual secret values in your password manager or cloud secret manager.

Export D1 schema and data:

```bash
npx wrangler d1 export "$DB" --remote --config "$CONFIG" --output "$BACKUP_DIR/d1.sql" -y
npx wrangler d1 export "$DB" --remote --config "$CONFIG" --output "$BACKUP_DIR/d1-schema.sql" --no-data -y
```

Back up R2. Wrangler can copy known objects:

```bash
npx wrangler r2 object get "${BUCKET}/path/to/object" --remote --file "$BACKUP_DIR/r2/path/to/object"
```

For whole-bucket backup, use R2's S3-compatible API with a dedicated R2 token
and an S3 client profile:

```bash
export CF_ACCOUNT_ID="<cloudflare-account-id>"
export R2_PROFILE="cloudflare-r2"
aws s3 sync "s3://${BUCKET}" "$BACKUP_DIR/r2/" \
  --endpoint-url "https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  --profile "$R2_PROFILE"
```

Store backups outside the repo with restricted access. Treat D1 exports and R2
objects as production data.

## Restore

Prefer restore into a new D1 database, then cut traffic to the restored
database by updating `$CONFIG` and deploying. Restoring over an existing
production DB can fail on existing tables or duplicate rows and should be
reserved for a tested repair script.

```bash
export RESTORE_DB="mupot-${POT}-restore-$(date -u +%Y%m%d%H%M%S)"
npx wrangler d1 create "$RESTORE_DB"
```

Paste the new D1 id into a temporary restore config, then import:

```bash
export RESTORE_CONFIG="wrangler.${POT}.restore.toml"
cp "$CONFIG" "$RESTORE_CONFIG"
# Edit RESTORE_CONFIG: database_name = "$RESTORE_DB" and database_id = "<new id>"
npx wrangler d1 execute "$RESTORE_DB" --remote --config "$RESTORE_CONFIG" --file "$BACKUP_DIR/d1.sql" --yes
npx wrangler deploy --config "$RESTORE_CONFIG" --message "restore ${POT} D1 from ${BACKUP_DIR}"
```

Restore R2 from the whole-bucket backup:

```bash
aws s3 sync "$BACKUP_DIR/r2/" "s3://${BUCKET}" \
  --endpoint-url "https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  --profile "$R2_PROFILE"
```

Or restore a known object with Wrangler:

```bash
npx wrangler r2 object put "${BUCKET}/path/to/object" --remote --file "$BACKUP_DIR/r2/path/to/object"
```

Restore config state from git plus the saved `$CONFIG`. Restore secret values by
resetting them with `wrangler secret put`; do not expect backup files to contain
secret values.

## Rollback

Rollback code independently from data:

```bash
npx wrangler versions list --config "$CONFIG"
npx wrangler rollback --config "$CONFIG" --message "rollback ${POT}: <reason>"
```

Rollback to a specific Worker version when you know the target:

```bash
npx wrangler rollback <VERSION_ID> --config "$CONFIG" --message "rollback ${POT}: <reason>"
```

If a migration already ran, do not assume code rollback is enough. D1
migrations are production data changes. Use one of these paths:

1. Apply a forward repair migration and redeploy.
2. Restore the D1 backup into a new database and deploy a config pointing at it.
3. Keep the current DB and manually repair only after exporting another backup.

If a deploy failed before migrations ran, rollback the Worker version or deploy
the previous git ref. If a deploy failed after migrations ran, preserve the
failed state, export D1, and decide between forward repair and restore.

## Validation

Local/dev validation proves the code path in the local test config:

```bash
npm run migrate:local:test
npm run seed:local:test
npm run dev:local:test
npm run smoke:local
```

Save `tmp/local-smoke/report.json` plus the referenced screenshots with the
release evidence.

Production validation proves the deployed pot and its real bindings:

```bash
curl -fsS "$BASE_URL/health"
curl -fsS "$BASE_URL/mcp/health"
npx wrangler tail "$WORKER" --format pretty --status error
```

Then sign in as an owner and inspect:

- `/ops`: schema, runtime liveness, webhook/integration checks, recent failures.
- `/fleet`: runtime presence and control request status.
- `/members`: active members and revocable tokens.
- `/approvals`: pending gates and recent decisions.
- `/loops`: active, paused, and gated loops.

A production deploy is not healthy until the HTTP health endpoints pass, `/ops`
has no unexplained danger checks, an owner can log in, and the relevant runtime
worker can attach or check in.

## Fresh install evidence

Before a release candidate, prove the happy path from a fresh operator point of
view. Use a new or throwaway pot path, record redacted receipts, and do not
repair setup by editing D1 rows manually. If manual database edits are needed,
the receipt must fail.

Print the checklist:

```bash
npm run receipt:fresh-install:plan -- \
  --pot "$POT" \
  --base-url "$BASE_URL" \
  --operator "<operator-email-or-id>" \
  --out-dir "tmp/fresh-install/${POT}"
```

The bundle directory must contain these redacted step receipts:

| File | Proves |
|---|---|
| `provision-resources.json` | Wrangler auth, D1, Vectorize, Queue, DLQ, KV, OAuth KV, R2, and config were created or found. |
| `secrets-configured.json` | Required Worker secrets were configured by name without exposing secret values. |
| `migrations-applied.json` | Remote migrations applied and no pending migration drift remains. |
| `worker-deployed.json` | Dry-run passed, deploy succeeded, and the deployed URL is known. |
| `owner-setup.json` | The fresh operator logged in, became owner, completed setup, and needed no manual DB edits. |
| `post-setup-validation.json` | Health, MCP health, owner dashboard login, and setup-complete UI passed without manual DB edits. |

Each step receipt must use:

```json
{
  "receipt_type": "mupot-fresh-install-step/v1",
  "step": "owner_setup",
  "status": "pass",
  "started_at": "2026-07-09T20:00:00.000Z",
  "completed_at": "2026-07-09T20:03:00.000Z",
  "target": {
    "pot": "acme",
    "base_url": "https://acme.example.com",
    "operator": "owner@example.com",
    "cloudflare_account": "redacted account label",
    "worker": "mupot-acme",
    "db": "mupot-acme",
    "config": "wrangler.acme.toml"
  },
  "commands": [
    { "command": "redacted command or command id", "ok": true, "exit_code": 0 }
  ],
  "evidence": {
    "required_key": true,
    "no_manual_db_edits": true
  }
}
```

Check the completed bundle:

```bash
npm run receipt:fresh-install:check -- \
  --out-dir "tmp/fresh-install/${POT}" \
  --pot "$POT" \
  --base-url "$BASE_URL" \
  --operator "<operator-email-or-id>" \
  > "tmp/fresh-install/${POT}/fresh-install-check.json"

npm run receipt:fresh-install:check -- \
  --summary \
  --out-dir "tmp/fresh-install/${POT}" \
  --pot "$POT" \
  --base-url "$BASE_URL" \
  --operator "<operator-email-or-id>"
```

The fresh install is release evidence only when `fresh-install-check.json`
reports `receipt_type:"mupot-fresh-install/v1"` and `status:"pass"`.

## Staging recovery rehearsal

Before a release candidate, run the recovery path on a staging pot and save an
attachable evidence bundle. This is the operational reliability gate for
`v0.23.0`; do not run it first against production.

Print the checklist:

```bash
npm run receipt:staging-recovery:plan -- \
  --pot "$POT" \
  --base-url "$BASE_URL" \
  --out-dir "tmp/staging-recovery/${POT}"
```

The bundle directory must contain these redacted step receipts. Run them in
this order without overlap so each step starts after the previous step ends:

| File | Proves |
|---|---|
| `backup.json` | D1 export, config inventory, secret-name inventory, and source git SHA exist before mutation |
| `upgrade.json` | the source SHA differs from the target SHA, migrations were applied, and the staging Worker deployed the target SHA |
| `restore.json` | the backup restored into a new D1 database and the restored pot validated |
| `rollback.json` | Worker rollback reached the source SHA, validated, and then recovered to the target SHA |
| `queue-dlq.json` | Queue delivery, DLQ capture, and idempotency behavior were observed |
| `failure-reporting.json` | `/ops`, tail output, or release logs exposed an injected failure |
| `final-validation.json` | health, MCP health, owner login, and agent presence passed after recovery |

Each step receipt must use:

```json
{
  "receipt_type": "mupot-staging-recovery-step/v1",
  "step": "upgrade",
  "status": "pass",
  "started_at": "2026-07-09T20:00:00.000Z",
  "completed_at": "2026-07-09T20:03:00.000Z",
  "target": {
    "pot": "staging",
    "base_url": "https://staging.example.com",
    "worker": "mupot-staging",
    "db": "mupot-staging",
    "git_sha": "<deployed git sha>"
  },
  "commands": [
    { "command": "redacted command or command id", "ok": true, "exit_code": 0 }
  ],
  "evidence": {
    "required_key": true
  }
}
```

Do not include tokens, webhook secrets, private keys, cookies, or password
values in the receipts. Environment variable names, secret names, redacted
placeholders, command ids, hashes, and artifact paths are acceptable.

The backup evidence must include `source_git_sha`. Upgrade evidence must include
the same value as `previous_git_sha` and the release candidate as `deployed_sha`.
Rollback evidence must include that source SHA as `rolled_back_to_sha` and the
candidate SHA as `recovered_to_sha`. The checker rejects a no-op upgrade,
out-of-order or overlapping steps, and rollback evidence that does not return to
both expected revisions.

Check the completed bundle:

```bash
npm run receipt:staging-recovery:check -- \
  --out-dir "tmp/staging-recovery/${POT}" \
  --pot "$POT" \
  --base-url "$BASE_URL" \
  > "tmp/staging-recovery/${POT}/staging-recovery-check.json"

npm run receipt:staging-recovery:check -- \
  --summary \
  --out-dir "tmp/staging-recovery/${POT}" \
  --pot "$POT" \
  --base-url "$BASE_URL"
```

The rehearsal is release evidence only when
`staging-recovery-check.json` reports
`receipt_type:"mupot-staging-recovery-rehearsal/v1"` and `status:"pass"`.
Attach the bundle and the check receipt to the release issue.

## Incident response

### Leaked Worker secret

1. Revoke the leaked credential at the provider first.
2. Replace the Worker secret:

```bash
npx wrangler secret put <SECRET_NAME> --config "$CONFIG"
npx wrangler secret list --config "$CONFIG"
```

3. Rotate related webhooks or OAuth client credentials at the provider.
4. Run production validation and review `/ops` plus `wrangler tail`.

### Compromised runtime host

Stop the host, remove its Mupot credentials from disk, and revoke its active
token or signed attach key.

List live member/agent tokens:

```bash
npx wrangler d1 execute "$DB" --remote --config "$CONFIG" --json \
  --command "SELECT id, member_id, label, channel, agent_id, created_at FROM member_tokens WHERE revoked_at IS NULL ORDER BY created_at;"
```

Revoke a known token id:

```bash
npx wrangler d1 execute "$DB" --remote --config "$CONFIG" \
  --command "UPDATE member_tokens SET revoked_at = datetime('now') WHERE id = '<token_id>';"
```

Remove a signed attach public key when that runtime host should no longer be
trusted:

```bash
npx wrangler d1 execute "$DB" --remote --config "$CONFIG" \
  --command "DELETE FROM agent_keys WHERE tenant = '${POT}' AND agent_id = '<agent_id>';"
```

Mint a fresh token only after the host is rebuilt and reviewed. Verify `/fleet`
shows the old runtime as stopped/dead and the new runtime as the expected agent.

### Broken webhooks

Rotate the platform webhook secret, update the provider's webhook configuration,
and redeploy only if config vars changed:

```bash
npx wrangler secret put GHL_WEBHOOK_SECRET --config "$CONFIG"
npx wrangler tail "$WORKER" --format pretty --status error
```

Check `/ops` for webhook and integration status. Keep inbound webhooks
fail-closed until the provider is sending signed requests with the new secret.

### Bad agent output

Contain the action first:

- Reject pending customer-facing work in `/approvals`.
- Pause or kill the affected loop in `/loops` or `/brain`.
- Pause the affected agent from the agent admin view.
- Revoke the runtime token if the host or model prompt is suspected compromised.

If the UI is unavailable, pause a known loop id directly:

```bash
npx wrangler d1 execute "$DB" --remote --config "$CONFIG" \
  --command "UPDATE loops SET status = 'paused', updated_at = datetime('now') WHERE tenant = '${POT}' AND id = '<loop_id>' AND status = 'active';"
```

Capture task ids, approval ids, runtime host, logs, and screenshots before
repairing. Re-enable only after a reviewer confirms the prompt, tool grants,
and downstream integration state.

## References

- Cloudflare D1 import/export docs: <https://developers.cloudflare.com/d1/best-practices/import-export-data/>
- Cloudflare R2 S3-compatible API docs: <https://developers.cloudflare.com/r2/api/s3/api/>
- Wrangler command help verified locally with `wrangler 4.102.0`.
