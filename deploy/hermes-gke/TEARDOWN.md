# Teardown — written before the entrance, on purpose

Order matters: kill the running workload first, then the credentials that
let it run, then the cluster, then the registry, so nothing is left able
to act after you start pulling things down.

```bash
# 1. Stop the workload (fast, reversible — just re-apply to bring it back)
kubectl delete -k k8s/
# Expect: deletes networkpolicy, service, deployment, serviceaccount,
# namespace (in reverse-ish order) — namespace deletion cascades anything
# left inside it. This alone stops all spend from the pod's compute
# request within seconds.

# 2. Revoke Workload Identity + Secret Manager access (credential cleanup)
gcloud iam service-accounts remove-iam-policy-binding \
  dme-hermes-relay@mumegaproject.iam.gserviceaccount.com \
  --project=mumegaproject \
  --role="roles/iam.workloadIdentityUser" \
  --member="serviceAccount:mumegaproject.svc.id.goog[dme-hermes/dme-hermes-relay]"

for SECRET in dme-hermes-telegram-bot-token dme-hermes-im-webhook-secret; do
  gcloud secrets remove-iam-policy-binding "$SECRET" \
    --project=mumegaproject \
    --member="serviceAccount:dme-hermes-relay@mumegaproject.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
done

gcloud iam service-accounts delete \
  dme-hermes-relay@mumegaproject.iam.gserviceaccount.com \
  --project=mumegaproject --quiet

# 3. Delete the secrets themselves (only once you're sure nothing else
# needs them — e.g. rotate the pot's IM_WEBHOOK_SECRET Worker secret to a
# fresh value FIRST if abandoning this only on the Hermes side but keeping
# the pot's webhook route enabled for some other relay)
gcloud secrets delete dme-hermes-telegram-bot-token --project=mumegaproject --quiet
gcloud secrets delete dme-hermes-im-webhook-secret --project=mumegaproject --quiet

# 4. Delete the cluster (stops the $0.10/hr control-plane fee accrual,
# though it was covered by the free credit anyway — still, no cluster
# means no surface at all)
gcloud container clusters delete dme-hermes \
  --project=mumegaproject --region=northamerica-northeast2 --quiet
# Expect: takes a few minutes, ends with "Deleting cluster dme-hermes...done."

# 5. Delete the Artifact Registry repo (images + all tags/digests)
gcloud artifacts repositories delete dme-hermes \
  --project=mumegaproject --location=northamerica-northeast2 --quiet

# 6. Tell Telegram to stop expecting anything (if getUpdates was ever
# polling, nothing needs unregistering — there's no webhook to remove. If
# webhook mode was switched to at some point, also run:
#   curl -s "https://api.telegram.org/bot<TOKEN>/deleteWebhook"
```

## Verify it's actually gone

```bash
gcloud container clusters list --project=mumegaproject
# Expect: dme-hermes absent.
gcloud artifacts repositories list --project=mumegaproject --location=northamerica-northeast2
# Expect: dme-hermes absent.
gcloud secrets list --project=mumegaproject | grep dme-hermes
# Expect: no output.
gcloud iam service-accounts list --project=mumegaproject | grep dme-hermes
# Expect: no output.
```

Nothing here touches the DME pot itself (Cloudflare Worker) or its
`IM_WEBHOOK_SECRET` — abandoning the GKE side leaves the pot's `/im/webhook`
route intact and harmless (it just stops receiving traffic from this
relay; it was already gated by the shared secret and unmapped-chat_id
refusal regardless of what's calling it).
