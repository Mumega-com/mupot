# Secret handling design

Two real secrets exist for this workload:

| Secret | Used for | Secret Manager name (proposed) |
|---|---|---|
| Telegram bot token | `getUpdates` (poll) + `sendMessage` (reply) calls to `api.telegram.org` | `dme-hermes-telegram-bot-token` |
| Pot IM webhook secret | `X-Telegram-Bot-Api-Secret-Token` header when Hermes calls the pot's `/im/webhook` | `dme-hermes-im-webhook-secret` |

**Neither is ever**: baked into the image, committed to this repo, passed
as a plain env var in the Deployment manifest, written to a ConfigMap, or
logged (see `server.mjs`'s `log()` — it only ever logs secret *lengths*,
never values, to prove at a glance a value didn't leak into a log line by
accident).

## Design: GCP Secret Manager + Workload Identity, fetched at runtime

1. **GCP Secret Manager** holds the two secret values (created out-of-band
   by Kasra-core/Hadi — see `COMMANDS.md` steps 4-5 — never via this
   branch's manifests).
2. **Workload Identity Federation for GKE** binds the pod's Kubernetes
   ServiceAccount (`dme-hermes-relay`, namespace `dme-hermes`,
   `k8s/10-serviceaccount.yaml`) to a dedicated GCP ServiceAccount
   (`dme-hermes-relay@mumegaproject.iam.gserviceaccount.com`, created in
   `COMMANDS.md` step 3). No JSON key file ever exists.
3. That GSA is granted `roles/secretmanager.secretAccessor` scoped to
   **only those two secret resources** (per-secret IAM policy binding, not
   a project-wide role — `COMMANDS.md` step 5). If this pod is ever
   compromised, the blast radius is "can read these two values," not "can
   read every secret in the project."
4. At boot, `src/server.mjs` calls the node's metadata-concealment proxy
   (`http://metadata.google.internal/.../token`) to get a short-lived GSA
   access token, then calls the Secret Manager REST API directly (two
   plain `fetch()` calls, zero npm dependency — see the "no supply chain"
   note in `Dockerfile`) to pull `versions/latest` of each secret into
   process memory. Values live in memory only, never touch disk.
5. Values are **re-pulled every 30 minutes** (`SECRET_REFRESH_MS`) so a
   rotation (see step below) takes effect within half an hour without a
   redeploy — while keeping the last-known-good value in memory if a
   refresh attempt fails, so a transient Secret Manager blip doesn't take
   the relay down.

## Why not a Kubernetes Secret object instead?

A k8s `Secret` (even one populated via the Secret Manager CSI driver) still
ends up as a base64 blob mounted into the pod's filesystem or injected as
an env var visible in `kubectl describe pod` / `/proc/<pid>/environ` to
anyone with pod-exec access. Fetching straight from Secret Manager into
process memory means the value never has a filesystem or `kubectl`-visible
form on the cluster side at all — the only readable copy is in this one
process's RAM, and only while it's running. This is the same posture
that's on the standing devps debt list for the bus-bridge cleartext-keyring
problem on the Hetzner host (`~/.claude/agents/kasra-devops.md`'s "Standing
debts" — 85 secrets in cleartext environ there); no reason to build a new
service on this host's opposite lesson.

## Rotation

- **Telegram bot token**: rotate via @BotFather (`/revoke`), then
  `gcloud secrets versions add dme-hermes-telegram-bot-token
  --data-file=-` with the new value (never as a CLI arg — see
  `COMMANDS.md` step 4 for the exact non-argv-leaking form). Live within
  30 minutes, no redeploy, no pod restart.
- **IM webhook secret**: rotate the pot's `IM_WEBHOOK_SECRET` Worker
  secret (`wrangler secret put IM_WEBHOOK_SECRET`) and the Secret Manager
  copy **together** — they must match, or every relayed message gets
  `401`'d by the pot until both sides agree.

## What I did NOT do

I did not create any secret, GSA, or IAM binding — those are provisioning
actions gated to Kasra-core (see `COMMANDS.md`). Nothing in this branch
contains a real secret value; every "secret" reference in the YAML is a
Secret Manager *resource name* (public-safe metadata), never a value.
