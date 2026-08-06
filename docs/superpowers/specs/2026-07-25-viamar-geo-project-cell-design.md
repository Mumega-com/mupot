# Viamar GEO Project Cell Design

**Status:** Approved by Hadi on 2026-07-25 for a branch-only vertical slice.

**Product thesis:** DME sells interpreted SEO/GEO intelligence and recommendations to
Maryam's customers. Mupot is the governed control plane underneath that service. Viamar
is the first customer cell because its brand, website, search data, agent workflows, and
reporting history already exist.

## 1. Outcome

Deliver one truthful end-to-end Viamar baseline:

1. A project-scoped scanner runs from the Google-hosted Kubernetes environment.
2. The scanner asks bounded grounded Vertex queries about Viamar's markets.
3. The scanner writes structured events into Viamar's PostHog project.
4. The scanner sends a redacted completion receipt to the Viamar Mupot project.
5. Existing Project Activity and Evidence views surface the work without exposing
   credentials, private model reasoning, or another customer's data.

This slice proves the customer-cell pattern. It does not claim that the complete
multi-customer portal, automatic provisioning controller, or customer identity model is
finished.

## 2. Runtime boundary

Google is used for two purposes only:

- GKE hosts the portable agent/scanner workload.
- Vertex AI provides the grounded Google Search call.

The scanner is a Kubernetes workload packaged in the same Mupot Agent Host image family.
It is not a Cloud Run service and does not require BigQuery, GCS, or a second application
control plane.

The customer cell is replaceable:

```text
Mupot project
  -> dedicated scanner identity
  -> Kubernetes CronJob/Job
  -> Vertex grounded query
  -> customer PostHog project
  -> project-attributed Mupot receipt
```

Durable workflow state remains in Mupot and trend data remains in PostHog. The pod and its
filesystem are not the system of record.

## 3. Isolation model

Viamar receives:

- its existing isolated `viamar` pot as the current customer security boundary;
- one root Mupot project;
- one dedicated scanner agent identity;
- one Kubernetes ServiceAccount mapped to a narrowly scoped Google service account;
- one project-specific PostHog capture token mounted from a Kubernetes Secret;
- one scanner configuration containing only Viamar's public profile and prompts;
- one daily budget ledger on a project-specific persistent volume;
- one NetworkPolicy and bounded container security context.

A pod alone is not treated as an authorization boundary. Every retained Mupot receipt
must carry `project_id`, and the scanner identity must have access only to the Viamar
project. PostHog credentials are never shared across customer jobs.

Mupot's current connector/addon installation model is pot/tenant-scoped, not
project-scoped. The existing substrate also documents separate deployments and storage
per pot. Viamar therefore remains a separate pot for this slice; its root project is the
customer work container inside that boundary. Treating several external customers as
projects inside one DME pot becomes safe only after project-scoped customer membership
and connector binding exist.

Therefore the scanner does not resolve a broad tenant connector and then trust a caller
supplied project ID. The first slice mounts Viamar's capture token only inside Viamar's
cell. A later project-connector binding must add live project authorization before the
same dashboard can safely serve multiple customer connectors from one pot.

## 4. Query contract and budget

The model is fixed to `gemini-2.5-flash` and the Vertex location is fixed to `global`.
The Google project is explicit and cannot be inferred from ambient `gcloud` configuration.

The process enforces:

- a compiled maximum of 25 grounded queries per UTC day;
- a configuration limit that may lower, never raise, the compiled maximum;
- an exclusive local budget ledger claim before every external query;
- fail-closed behavior for malformed, unreadable, or locked budget state;
- `concurrencyPolicy: Forbid` at the Kubernetes scheduler boundary;
- no retry of a billable grounded call when the response outcome is uncertain.

The budget is charged before the call. A failed or ambiguous request consumes its claim.
This may under-use the budget, but it prevents a crash/retry loop from spending twice.

## 5. Event schema

Every attempted prompt produces one `$geo_scan` PostHog event:

```json
{
  "schema": "dme.geo-scan/v1",
  "scan_id": "uuid",
  "project_id": "00000000-0000-4000-8000-000000000000",
  "profile_id": "viamar",
  "prompt_id": "international-car-shipping-canada",
  "market": "Canada",
  "observed_at": "2026-07-25T00:00:00.000Z",
  "status": "ok",
  "target_domain": "viamar.ca",
  "target_cited": false,
  "answer_text": "bounded model answer",
  "web_search_queries": ["bounded query"],
  "cited_domains": ["example.com"],
  "citations": [
    {
      "title": "bounded title",
      "domain": "example.com",
      "uri": "https://example.com/bounded"
    }
  ],
  "tracked_competitors_named": ["Example Competitor"],
  "prompt_tokens": 100,
  "candidate_tokens": 200,
  "total_tokens": 300,
  "estimated_model_cost_micro_usd": 530,
  "grounding_cost_micro_usd": null,
  "cost_status": "billing_unreconciled",
  "model_rate_card": "vertex-gemini-2.5-flash-2026-07-25",
  "model": "gemini-2.5-flash"
}
```

Bounds apply to answer text, arrays, strings, citations, and response body size. The
PostHog project token, Google access token, Mupot bearer token, and raw upstream error
body are never part of this object.

An empty or failed grounded response still creates an honest event with
`status: "empty"` or `status: "failed"`, empty evidence arrays, and a stable reason code.
It never fabricates a zero citation result.

`estimated_model_cost_micro_usd` is derived from returned model-token usage using an
explicit dated rate card. It is not called actual spend. Grounding cost remains null until
Cloud Billing reconciliation proves it. The first live run must report
`billing_unreconciled` rather than guessing.

## 6. Mupot receipt

After a run, the scanner sends one project-attributed `ack` message through
`POST /api/inbox/send` using its agent-bound token. The receipt contains only:

- schema and scan ID;
- project/profile IDs;
- counts of `ok`, `empty`, `failed`, and budget-denied prompts;
- total token counts and estimated model cost;
- PostHog event UUIDs or a digest;
- cost reconciliation status;
- observed start/end timestamps.

It does not duplicate answers, search queries, citations, secrets, or upstream error
bodies into Mupot. Detailed customer evidence remains in that customer's PostHog project.
The existing project projections provide the Activity/Evidence surface.

Receipt delivery is fail-closed for identity/project errors. A PostHog write followed by
a Mupot receipt failure is reported locally as incomplete; it is not retried by repeating
the Vertex query.

## 7. Viamar first profile

The checked-in Viamar configuration contains public, non-secret facts only:

- profile: `viamar`;
- target domain: `viamar.ca`;
- market: Canada / Greater Toronto Area;
- business category: international freight forwarding, vehicle shipping, and household
  goods moving;
- a small prompt set covering international movers, overseas vehicle shipping, and
  Canada-to-Europe household-goods shipping.

Existing GSC, GA4, Ads, CRM, WordPress, and lead data are not copied into this scanner.
They remain separate sources and can later enrich the DME report through guarded
project-scoped adapters.

## 8. Customer surface

For the first demonstration, Maryam uses the existing authenticated Mupot project page:

- Activity shows the attributed scan request and scanner receipt.
- Evidence shows the append-only completion receipt.
- PostHog-backed GEO detail is rendered only after a project-scoped read binding exists.

A polished customer login and white-labelled report are a later surface. Before inviting
external customers, Mupot needs a general principal-to-project membership model and
negative cross-customer authorization tests. Internal squads alone are not presented as
customer RBAC.

## 9. Delivery and gate

This work is branch-only:

- no deploy;
- no merge;
- no migration;
- no secret creation, reading, or rotation;
- no live customer-data access;
- no identity minting;
- no first real scan until Hadi separately authorizes the Google, PostHog, and Mupot
  runtime credentials.

Cursor is the independent gate. It receives the design/plan and exact commit, then returns
`GREEN` or `BLOCK` with evidence. The builder does not self-approve.

The checked-in UUID above is an explicit unresolved sentinel, not Viamar's live project
identity. The CronJob stays suspended and its executable receipt stays `plan` until an
authorized operator replaces it with the actual Viamar root-project UUID in both the
profile file and ConfigMap.

## 10. Acceptance criteria

- Configuration rejects an unexpected project/profile, unsafe host, excess prompts, and
  a query cap above the compiled maximum.
- The daily ledger prevents query 26 and survives a second process invocation on the same
  UTC day.
- Vertex calls use `googleSearch`, explicit project/location/model, a bounded timeout, and
  no token logging or persistence.
- Grounding metadata is normalized into the event schema with strict bounds.
- Empty and failed calls emit honest states, not zero-citation success.
- PostHog capture uses the project token only at call time and rejects redirects.
- The Mupot receipt is project-attributed, redacted, bounded, and sent only after event
  outcomes are known.
- Kubernetes manifests use a dedicated ServiceAccount, Secret mounts, persistent budget
  state, non-root/read-only security context, resource limits, and
  `concurrencyPolicy: Forbid`.
- Unit tests, Kubernetes artifact tests, typecheck, and the full repository suite pass.
- No credentials or real customer payloads are committed.
