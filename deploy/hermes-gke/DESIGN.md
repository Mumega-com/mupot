# Design notes — Hermes relay on GKE Autopilot (DME pot)

## What this actually is

A single stateless process that:
1. Long-polls `https://api.telegram.org/bot<token>/getUpdates` (outbound only).
2. For each update, `POST`s the raw update to the DME pot's `/im/webhook`
   with `X-Telegram-Bot-Api-Secret-Token: <IM_WEBHOOK_SECRET>` (outbound only).
3. If the pot replies `{ok: true, reply: "..."}`, calls Telegram's
   `sendMessage` with that text (outbound only).

**No inbound network path is required at all.** See "Webhook vs. long-poll"
below — this is a deliberate change from the README's implied webhook shape,
and it is the single biggest cost/complexity lever in this whole design.

## Webhook vs. long-poll (why I changed it)

`connectors/hermes/README.md` documents the Hermes → pot leg precisely
(`POST /im/webhook` + shared secret) but does not fix how Hermes hears from
Telegram — that's Hermes's own implementation choice. Telegram supports two
modes:

- **Webhook**: Telegram pushes updates to a public HTTPS URL you register.
  Requires Hermes to be reachable from the internet — on GKE that means an
  external HTTP(S) Load Balancer (Ingress or Gateway), a managed TLS
  certificate, and a static IP. The forwarding-rule fee for that LB alone is
  roughly **$18-20/mo**, before any data-processing charges — more than
  double the entire compute cost of the relay pod itself (see `COST.md`).
  It also puts a public listener on the internet for something that only
  ever needs to make outbound calls.
- **Long-poll** (`getUpdates`): Hermes calls Telegram, Telegram holds the
  connection open up to `timeout` seconds and returns as soon as an update
  exists. Latency is effectively the same as a webhook for a chat bot (no
  fixed polling interval — it's a held connection, not "check every N
  seconds"). Zero inbound network surface needed.

I built long-poll. It's cheaper, it's simpler (no Ingress/cert/static-IP
manifests to write or maintain), and it shrinks the attack surface kasra-
devops has to worry about to zero public listeners on this workload. The
Service in `k8s/30-service.yaml` is ClusterIP only — kept for
`kubectl port-forward` debugging, not because anything needs to reach it.

If push latency or Telegram API rate-limit behavior ever argues for webhook
mode instead, the switch is: add an Ingress/Gateway + managed cert, add a
`/telegram/webhook` HTTP handler back into `src/server.mjs` (a prior draft
of that handler is straightforward — validate Telegram's own
`X-Telegram-Bot-Api-Secret-Token` on the inbound side, forward the body
unchanged), and register the webhook URL with Telegram's `setWebhook`. Not
recommended for this workload's volume.

## Is GKE Autopilot even the right tool here? (asked to say plainly if not)

**For the workload as literally scoped in this brief — a single stateless
Telegram↔pot relay — no. Cloud Run is the better tool.** Concretely:

- **No cluster fee.** GKE Autopilot's $0.10/hr control-plane fee (~$73/mo)
  is covered right now by GKE's own $74.40/mo per-billing-account credit,
  but that credit is a single slot — the moment `mumegaproject` hosts a
  second Autopilot/zonal cluster for anything else, one of the two pays
  full price. Cloud Run has no cluster fee, full stop, ever.
- **Comparable compute billing, less to operate.** A Cloud Run service
  with `--min-instances=1 --no-cpu-throttling` (needed because the
  long-poll loop must run between requests, not just during them) and
  `--cpu=1 --memory=512Mi` bills in the same ballpark as the Autopilot pod
  costed in `COST.md` — but with none of: node image CVEs, Workload
  Identity Federation setup, NetworkPolicy YAML, `kubectl` access control,
  or a cluster to keep patched. Cloud Run's secret mounting
  (`--set-secrets`) is a single flag against the same Secret Manager
  secrets — same secret-handling guarantee, less plumbing.
- **If webhook mode is ever wanted**, Cloud Run gives you a public HTTPS
  URL with a managed cert *for free, by default* — the exact thing that
  costs ~$20/mo extra on GKE.
- **Where GKE would earn its keep**: if this pod needs to do more than
  relay — multiple long-running sidecar processes, shared local storage,
  genuine multi-container pod-level coordination. Which brings up the next
  point.

## The scope collision I found — please resolve before provisioning

The brief points at **GitHub issue #434** for "the working shape," and that
issue is about a *different, heavier* runtime than the README's relay:
`deploy/kubernetes/agent-host/` in this repo already contains a
`dme-hermes` **fleet-runtime agent host** — `nousresearch/hermes-agent`
base image, `/opt/hermes` workspace, a fleet-daemon + inbox-handler +
Ed25519 agent-signing-key + PVC for persistent `/home/mupot` state — built
for the Mac Kubernetes cluster to run ECC-installed DME agents (issue
#434's actual content: "install ECC's marketing kit... DME cursor operator
auto-adopts... **this pod is also intended to host DME's agents, not just
relay messages**").

That is a fundamentally different container than what I built here:
stateful, PVC-backed, signing-key-bearing, multi-file fleet-runtime
plumbing — not a small stateless relay. **Two real possibilities:**

1. The Telegram-relay function genuinely wants to be its own small,
   disposable, stateless service (what's in this branch) — in which case
   the existing `agent-host` manifests are for a *separate* concern (DME's
   agent runtime) and should migrate to GKE Autopilot on their own track,
   adapting their PVC (Autopilot supports dynamic PVs fine, just needs a
   StorageClass check) and their static-token secret mount (candidate to
   also move to Workload Identity while it's being touched).
2. Hadi actually wants ONE pod that both relays Telegram AND hosts DME's
   agents (matching issue #434 literally) — in which case what should move
   to GKE Autopilot is `agent-host/`, not a fresh build, and this branch's
   relay is redundant work that should be folded in or discarded.

**I built (1) because it's what the literal deliverable list in this brief
asked for** (Dockerfile + Deployment/Service + Secret Manager design for
"the Hermes runtime" per the README's definition), but I do not want to
hand you a second parallel "dme-hermes" without saying plainly that the
codebase already has a more complete answer for the *agent-hosting* half
of the job. Tell me which one you actually want live and I'll adjust —
this is exactly the kind of thing that's cheap to catch now and expensive
to catch after both are running.

## What I did NOT build

- No image push, no `gcloud container clusters create`, no `kubectl
  apply`. Per the hard constraint, this is prep only.
- No Secret Manager secrets created, no IAM bindings applied, no GSA
  created — `COMMANDS.md` has the exact commands; none have been run.
- No real secret value appears anywhere in this branch, by construction
  (`server.mjs` never accepts a secret as an env var or CLI arg — it only
  ever pulls from Secret Manager at runtime over Workload Identity).
