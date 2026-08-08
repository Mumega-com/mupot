# Hermes for the DME pot — GKE Autopilot prep

**Status: PREP ONLY.** Nothing here has been provisioned, built, pushed,
or applied. This branch (`kasra/hermes-gke-dme`, off `origin/main`) is
artifacts + exact commands for Kasra-core to execute; kasra-devops does
not create clusters, push images, or apply manifests.

## Read in this order

1. **`DESIGN.md`** — what this is, why long-poll not webhook, and the
   honest "is GKE even right for this" assessment (short answer for the
   relay alone: no, Cloud Run is — read it for the real reasoning and the
   scope-collision finding with the existing `agent-host/` runtime).
2. **`SECRETS.md`** — Secret Manager + Workload Identity design; no real
   secret value exists anywhere in this branch.
3. **`COST.md`** — the arithmetic: ~$10-15 total over 27 days, and why the
   $300 isn't actually the constraint.
4. **`COMMANDS.md`** — the exact, ordered, copy-pasteable command sequence
   with expected output at each step.
5. **`TEARDOWN.md`** — the exit, written before the entrance.

## Files

```
Dockerfile          # node:22-alpine, non-root, zero npm dependencies
package.json         # name/engines only — no dependencies to audit
src/server.mjs       # the whole relay: ~230 lines, no framework
k8s/
  00-namespace.yaml
  10-serviceaccount.yaml   # Workload Identity KSA<->GSA binding point
  20-deployment.yaml       # Autopilot-sized requests/limits + probes
  30-service.yaml          # ClusterIP only — no public ingress needed
  40-networkpolicy.yaml    # default-deny ingress, narrow egress
  kustomization.yaml
```

## One-paragraph summary of what this does

Hermes long-polls Telegram for updates on the DME bot, forwards each raw
update to `https://mupot-dme-temp.weathered-scene-2272.workers.dev/im/webhook`
with a shared secret header, and relays the pot's `{ok, reply}` back to the
Telegram chat. The pot alone resolves `chat_id -> Member -> capabilities`;
Hermes never sees or logs anything more than it needs to move bytes.
