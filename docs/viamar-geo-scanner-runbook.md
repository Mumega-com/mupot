# Viamar GEO Scanner Runbook

The Viamar GEO scanner is the first customer-cell proof for DME's SEO/GEO
intelligence service. It runs bounded grounded-search prompts from Google-hosted
Kubernetes, stores detailed events in Viamar's PostHog project, and sends one
redacted completion receipt to the Viamar Mupot project.

**Activation state:** preview, branch proof only. The checked-in CronJob is suspended,
uses a non-deployable example image tag, and contains no credentials. A live run needs
separate Hadi authorization for identity, secrets, image publication, cluster changes,
and customer-data use.

Design:
[Viamar GEO Project Cell](./superpowers/specs/2026-07-25-viamar-geo-project-cell-design.md).

## Boundary

Viamar remains its existing isolated pot. Its root project is the customer work
container inside that pot. This preserves today's real security boundary:

- separate Cloudflare deployment and storage;
- dedicated scanner agent identity;
- dedicated Kubernetes ServiceAccount;
- dedicated PostHog project token;
- project-attributed Mupot receipt;
- no DME, Mumega, or future-customer credential in the Viamar pod.

Do not place several external customers in one DME pot yet. Connector/addon bindings
are pot-scoped, while customer membership and connector authorization are not yet
project-scoped.

## Local branch proof

These checks do not call Google, PostHog, Mupot, Kubernetes, or customer systems:

```bash
node --test fleet-runtime/geo-scanner/*.test.mjs
npx vitest run tests/kubernetes-geo-scanner.test.ts
npm run typecheck
npm run receipt:kubernetes-geo-scanner
```

The checked-in receipt must report:

```json
{
  "schema": "mupot-kubernetes-geo-scanner-receipt/v1",
  "status": "plan",
  "project_id": "viamar",
  "image_digest": null
}
```

`plan` is intentional. Every check except `image_digest_pinned` must pass. It becomes
`pass` only after an authorized build publishes the exact derived Hermes image and the
manifest pins its immutable digest.

## Live prerequisites

The owner must provide and verify all of these before unsuspending the CronJob:

1. A Viamar root project exists in the Viamar pot.
2. A dedicated `viamar-geo-scanner` Mupot agent is welded to a token with access only
   to that project and permission to send the receipt to `viamar-geo-receipts`.
3. The Google service account
   `mumega-agent@mumegaproject.iam.gserviceaccount.com` exists with only the Vertex
   prediction permission required by the grounded call.
4. GKE Workload Identity binds that Google service account to Kubernetes
   ServiceAccount `viamar-geo-scanner` in the selected namespace.
5. Kubernetes Secret `viamar-posthog-capture` contains only Viamar's PostHog project
   capture token under key `token`.
6. Kubernetes Secret `viamar-geo-scanner-agent` contains only the dedicated
   agent-bound Mupot token under key `token`.
7. PVC `viamar-geo-scanner-state` is bound and empty or contains a valid
   `dme.geo-query-budget/v1` ledger.
8. The trusted egress gateway allows only the required HTTPS destinations:
   `aiplatform.googleapis.com`, Viamar's PostHog ingestion host, and the Viamar Mupot
   host.
9. The derived Hermes image has local provenance, is published, and is pinned by
   digest in the CronJob.
10. Maryam/Hadi approve the public Viamar prompt set and the destination PostHog
    project.

Secrets are mounted as read-only files. Never put token values in YAML, ConfigMaps,
shell history, issue comments, receipts, or logs.

## First-run sequence

The authorized operator:

1. Builds and publishes the derived Agent Host image.
2. Replaces the example image tag with the immutable digest.
3. Runs `npm run receipt:kubernetes-geo-scanner`; requires `status: "pass"`.
4. Applies the ServiceAccount, ConfigMap, PVC, CronJob, and NetworkPolicy in the
   Viamar namespace.
5. Keeps `spec.suspend: true`.
6. Starts one manual Job derived from the CronJob and watches it.
7. Confirms no more than three Vertex calls occurred.
8. Confirms exactly three `$geo_scan` events landed in Viamar's PostHog project.
9. Confirms one redacted `mupot.geo-scan-receipt/v1` acknowledgement appears in
   Viamar Project Activity/Evidence.
10. Reviews billing after Google reports actual cost. Until then the events and receipt
    remain `billing_unreconciled`.
11. Only after all checks pass, changes `spec.suspend` to `false`.

The scanner does not retry a grounded Vertex request. A timeout or ambiguous response
consumes its budget claim so an automated retry cannot double-spend.

## PostHog inspection

Filter events to:

```text
event = '$geo_scan'
properties.schema = 'dme.geo-scan/v1'
properties.project_id = 'viamar'
properties.profile_id = 'viamar'
```

Each prompt event distinguishes:

- `ok`: grounded answer exists;
- `empty`: the model returned no answer;
- `failed`: the request or response boundary failed;
- `budget_denied`: the daily cap prevented a call.

Only `ok` may set `target_cited` to true or false. Every other state uses null so the
trend never converts missing evidence into a fabricated zero.

Useful fields:

- `target_cited` for Viamar visibility trend;
- `cited_domains` for authority-domain share;
- `tracked_competitors_named` for known-competitor trend;
- `web_search_queries` for the searches Google actually grounded;
- `prompt_tokens`, `candidate_tokens`, and `estimated_model_cost_micro_usd` for the
  model-only estimate;
- `grounding_cost_micro_usd` and `cost_status` for later billing reconciliation.

## Cost reconciliation

The scanner calculates only a dated model-token estimate from Vertex
`usageMetadata`. It deliberately leaves grounding cost null.

Actual cost must be reconciled from Google Cloud Billing after its reporting delay:

1. select the exact UTC scan window;
2. attribute Vertex charges to the scanner's Google project/service account and
   grounded-query workload;
3. divide attributable cost by successful plus failed billable calls;
4. retain the billing source, window, currency, and reconciliation timestamp;
5. update reporting through a separate governed process.

Never overwrite historical raw scan events with a guessed cost.

## Stop, move, and recover

To stop safely, suspend the CronJob before changing images, identities, prompts,
network policy, credentials, or PVCs. Wait for any active Job to terminate.

To move the cell to another Kubernetes cluster:

1. suspend and drain the old CronJob;
2. export the public profile and the current non-secret budget ledger;
3. revoke the old scanner identity/token and Workload Identity binding;
4. recreate the ServiceAccount, Secret references, NetworkPolicy, and PVC on the new
   cluster;
5. restore the same UTC-day budget ledger, or wait until the next UTC day;
6. mint a new scanner identity rather than copying a live token;
7. pin the same verified image digest;
8. run one watched manual Job before enabling the schedule.

If the budget ledger is malformed or locked, the scanner fails closed. Preserve it for
inspection; do not delete it merely to make the scan run.

## Rollback

Suspend the CronJob. Do not repeat the Vertex query to repair a PostHog or Mupot sink
failure. Use the scan/event UUIDs to reconcile the existing outcome, then repair only
the missing sink through an explicitly reviewed recovery path.

Revoke the dedicated Mupot token and remove the Workload Identity binding if the pod or
namespace may be compromised. Rotate the PostHog capture token through PostHog and the
Kubernetes Secret boundary; never commit the replacement.
