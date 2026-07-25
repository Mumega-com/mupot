# Exact command sequence — Kasra-core executes, in order

Every command is copy-pasteable. Steps that touch a real secret value are
marked **⚠ SECRET** — those are typed/pasted interactively, never placed in
a file, a `--flag=value` (visible in shell history / `ps`), or a heredoc.

Region: **`northamerica-northeast2` (Toronto)** — same metro as York
Region, Ontario; lowest realistic latency for this tenant. Fallback:
`northamerica-northeast1` (Montreal) if Toronto lacks Autopilot capacity
(step 0b checks this).

Project: **`mumegaproject`** (NOT the stale `mumega-com` the active gcloud
config currently points at — step 0a fixes that for this shell).

## 0. Fix stale config + sanity-check region support

```bash
# 0a — point this shell at the right project (does not touch global config
# permanently unless you also run `gcloud config set project`; using
# --project on every command below is the safer, explicit form, but set it
# once here too so bare `gcloud` commands during manual debugging don't
# silently hit the wrong (inaccessible) mumega-com project):
gcloud config set project mumegaproject
# Expect: "Updated property [core/project]."

# 0b — confirm Autopilot is offered in Toronto before committing to it:
gcloud container get-server-config --region=northamerica-northeast2 --project=mumegaproject
# Expect: a validMasterVersions/validNodeVersions list, no error. If this
# errors ("not found" / "not supported"), use northamerica-northeast1
# (Montreal) for every --region flag below instead.
```

## 1. Enable the one missing API (container/run/artifactregistry are already on)

```bash
gcloud services enable secretmanager.googleapis.com --project=mumegaproject
# Expect: silent success (or near-instant "Operation finished").
```

## 2. Artifact Registry repo

```bash
gcloud artifacts repositories create dme-hermes \
  --project=mumegaproject \
  --repository-format=docker \
  --location=northamerica-northeast2 \
  --description="DME Hermes relay images"
# Expect: "Created repository [dme-hermes]."

gcloud auth configure-docker northamerica-northeast2-docker.pkg.dev
# Expect: adds a credHelper entry to ~/.docker/config.json for that host.
```

## 3. Dedicated GCP ServiceAccount for Workload Identity

```bash
gcloud iam service-accounts create dme-hermes-relay \
  --project=mumegaproject \
  --display-name="DME Hermes relay (Workload Identity)"
# Expect: "Created service account [dme-hermes-relay]."
```

## 4. Create the two secrets — ⚠ SECRET, interactive only

```bash
# Telegram bot token. Run this, PASTE the token when the terminal waits
# for stdin, then press Enter then Ctrl-D (EOF). Do NOT use echo/printf/a
# heredoc — all of those land the value in shell history.
gcloud secrets create dme-hermes-telegram-bot-token \
  --project=mumegaproject \
  --replication-policy=automatic \
  --data-file=-
# Expect: "Created version [1] of the secret [dme-hermes-telegram-bot-token]."

# Pot IM webhook secret — same interactive pattern. This value must match
# whatever is set as the DME pot's IM_WEBHOOK_SECRET Worker secret
# (`wrangler secret put IM_WEBHOOK_SECRET` on the pot side) — generate a
# fresh random value if one doesn't already exist, e.g.
# `openssl rand -base64 32` run locally and never saved to a file, then
# paste that same value into BOTH this command and the wrangler one.
gcloud secrets create dme-hermes-im-webhook-secret \
  --project=mumegaproject \
  --replication-policy=automatic \
  --data-file=-
# Expect: "Created version [1] of the secret [dme-hermes-im-webhook-secret]."
```

## 5. Grant the GSA access to ONLY these two secrets (not project-wide)

```bash
for SECRET in dme-hermes-telegram-bot-token dme-hermes-im-webhook-secret; do
  gcloud secrets add-iam-policy-binding "$SECRET" \
    --project=mumegaproject \
    --member="serviceAccount:dme-hermes-relay@mumegaproject.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
done
# Expect: each prints the updated IAM policy binding for that one secret.
```

## 6. Bind the Kubernetes ServiceAccount to the GSA (Workload Identity)

Run this AFTER the cluster exists (step 7) and the namespace/KSA are
applied (step 9), since the binding references the Workload Identity Pool
member string that's stable regardless of order — but verifying the KSA
name matches `k8s/10-serviceaccount.yaml` (`dme-hermes-relay` in namespace
`dme-hermes`) is what makes this line correct:

```bash
gcloud iam service-accounts add-iam-policy-binding \
  dme-hermes-relay@mumegaproject.iam.gserviceaccount.com \
  --project=mumegaproject \
  --role="roles/iam.workloadIdentityUser" \
  --member="serviceAccount:mumegaproject.svc.id.goog[dme-hermes/dme-hermes-relay]"
# Expect: updated IAM policy printed, includes the new member.
```

## 7. Create the Autopilot cluster

```bash
gcloud container clusters create-auto dme-hermes \
  --project=mumegaproject \
  --region=northamerica-northeast2 \
  --release-channel=regular
# Expect: takes ~8-10 minutes. Ends with a table showing the cluster
# NAME/LOCATION/MASTER_VERSION/STATUS=RUNNING. Workload Identity is ON by
# default on Autopilot — no extra flag needed, but worth confirming:
gcloud container clusters describe dme-hermes \
  --project=mumegaproject --region=northamerica-northeast2 \
  --format="value(workloadIdentityConfig.workloadPool)"
# Expect: "mumegaproject.svc.id.goog"
```

## 8. Get cluster credentials + confirm no stale Telegram webhook is registered

```bash
gcloud container clusters get-credentials dme-hermes \
  --project=mumegaproject --region=northamerica-northeast2
# Expect: "kubeconfig entry generated" + sets current kubectl context.

kubectl cluster-info
# Expect: prints the Kubernetes control plane / DNS endpoint URLs, no error.
```

```bash
# ⚠ SECRET-adjacent (uses the bot token in a URL, over HTTPS, to Telegram's
# own API — do this from a terminal where the command itself won't be
# logged anywhere persistent; do not paste this into any chat/bus message):
curl -s "https://api.telegram.org/bot<PASTE_TOKEN_HERE_THEN_CLEAR_HISTORY>/getWebhookInfo"
# Expect: {"ok":true,"result":{"url":"", ...}}  <- url MUST be empty.
# If url is non-empty, a webhook is currently registered for this bot and
# getUpdates (long-poll) will fail with 409 until it's cleared:
curl -s "https://api.telegram.org/bot<TOKEN>/deleteWebhook"
# Expect: {"ok":true,"result":true,"description":"Webhook was deleted"}
```

## 9. Build and push the image

```bash
cd deploy/hermes-gke
docker build -t northamerica-northeast2-docker.pkg.dev/mumegaproject/dme-hermes/relay:0.1.0 .
# Expect: builds in seconds (node:22-alpine pull + two COPY layers, no
# npm install — zero dependencies).

docker push northamerica-northeast2-docker.pkg.dev/mumegaproject/dme-hermes/relay:0.1.0
# Expect: layers push, ends with a digest line: "0.1.0: digest: sha256:... size: ..."
```

**Pin the digest** (don't trust the mutable tag for what actually runs):

```bash
DIGEST=$(gcloud artifacts docker images describe \
  northamerica-northeast2-docker.pkg.dev/mumegaproject/dme-hermes/relay:0.1.0 \
  --format="value(image_summary.digest)")
echo "$DIGEST"
# Then edit k8s/20-deployment.yaml's `image:` line to
# .../relay@$DIGEST instead of the :0.1.0 tag before applying.
```

## 10. Apply the manifests

```bash
kubectl apply -k k8s/
# Expect, in order:
#   namespace/dme-hermes created
#   serviceaccount/dme-hermes-relay created
#   deployment.apps/dme-hermes-relay created
#   service/dme-hermes-relay created
#   networkpolicy.networking.k8s.io/dme-hermes-relay created
```

## 11. Verify

```bash
kubectl -n dme-hermes get pods -w
# Expect: dme-hermes-relay-xxxxxxxxxx-xxxxx  1/1  Running  within ~30-60s
# (Autopilot needs to provision compute for the first pod in a new
# namespace — the first schedule can take a minute or two longer than a
# Standard cluster with warm nodes.)

kubectl -n dme-hermes logs deploy/dme-hermes-relay --tail=50
# Expect JSON lines like:
#   {"level":"info","msg":"secrets loaded","telegram_bot_token_chars":46,"webhook_secret_chars":44,...}
#   {"level":"info","msg":"hermes relay up (long-poll mode)","health_port":8080,...}
# NEVER a line containing an actual token/secret value — only lengths.

kubectl -n dme-hermes port-forward svc/dme-hermes-relay 8080:8080 &
curl -s localhost:8080/healthz   # Expect: ok
curl -s -o /dev/null -w "%{http_code}\n" localhost:8080/readyz   # Expect: 200
kill %1
```

**End-to-end**: message the DME Telegram bot from a chat_id already mapped
to a mupot Member. Expect a reply within a couple seconds. Check
`kubectl -n dme-hermes logs -f deploy/dme-hermes-relay` shows a
`"relayed to pot"` line with `pot_status: 200` for that message.
