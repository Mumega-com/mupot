# Mupot Runtime Starter

This is the operator runbook for a customer-owned Mupot runtime. It installs the
same sterile runtime on macOS with launchd or Linux with systemd, keeps credentials
in the host secret store, and produces a copied bundle that can be verified after
transfer.

The starter supports two topologies:

- **Co-resident:** Hermes and Codex run on one host under one pair of user services.
- **Distributed:** each host filters the same starter manifest to its local agent;
  for example, Hermes on a Mac and Codex on a VPS.
- **Kubernetes:** a customer-owned cluster runs the same profile and inbox
  contracts behind a hardened pod supervisor.

Generate the exact host plan instead of assembling a second command path:

```bash
npm run fleet:starter -- --plan --manifest fleet-runtime/starter.example.json
npm run fleet:starter -- --plan --manifest fleet-runtime/starter.example.json --agent manager
npm run fleet:starter -- --plan --manifest fleet-runtime/starter.example.json --agent builder
```

## Credential Boundary

Private agent keys stay under `$HOME/.fleet/agents` with mode `0600`. The panel
JWK on the host is public material. Export `MUPOT_AGENT_TOKEN_<AGENT>` and
`MUPOT_OWNER_TOKEN` only in the interactive process or inject them from a secret
manager. Do not put bearer values in JSON config, receipts, plist/unit
environments, shell history, or evidence attachments.

## Install Without Activation

Use an absolute Node path and retain the install receipt:

```bash
mkdir -p "$HOME/.fleet/receipts"
node fleet-runtime/install.mjs \
  --service-manager auto \
  --node "$(command -v node)" \
  > "$HOME/.fleet/receipts/install.json"
```

The first run creates editable templates and normally reports `warn`. Edit
`daemon.json`, `inbox-handler.json`, `control.json`, and `flights.json`; install
the private agent keys and public panel key; run `trust-bootstrap.mjs`; then rerun
the same non-destructive install command so `install.json` records the configured
layout. Installation renders definitions but does not load them unless
`--activate` is supplied.

## macOS With launchd

Run lifecycle commands as the logged-in user. No `sudo` is required:

```bash
node fleet-runtime/service-manager.mjs install --service-manager launchd \
  --node "$(command -v node)" \
  > "$HOME/.fleet/receipts/service-install.json"
node "$HOME/.fleet/runtime/service-manager.mjs" status --service-manager launchd \
  > "$HOME/.fleet/receipts/service.json"
node "$HOME/.fleet/runtime/host-receipt.mjs" \
  --require-services --service-manager launchd \
  --node "$(command -v node)" \
  > "$HOME/.fleet/receipts/host.json"
```

The equivalent one-command install path is
`node fleet-runtime/install.mjs --activate --service-manager launchd --node "$(command -v node)"`, but the
separate install and activation steps are preferable when collecting proof.

## Linux With systemd

Install and query the systemd user services first:

```bash
node fleet-runtime/service-manager.mjs install --service-manager systemd \
  --node "$(command -v node)" \
  > "$HOME/.fleet/receipts/service-install.json"
node "$HOME/.fleet/runtime/service-manager.mjs" status --service-manager systemd \
  > "$HOME/.fleet/receipts/service.json"
```

Logout continuity requires lingering. This is an explicit operator-authorized
host action, separate from the unprivileged installer:

```bash
loginctl enable-linger "$USER"
node "$HOME/.fleet/runtime/service-manager.mjs" status --service-manager systemd \
  > "$HOME/.fleet/receipts/service-after-linger.json"
node "$HOME/.fleet/runtime/host-receipt.mjs" \
  --require-services --service-manager systemd \
  --node "$(command -v node)" \
  > "$HOME/.fleet/receipts/host.json"
```

The installer can activate explicitly with
`node fleet-runtime/install.mjs --activate --service-manager systemd --enable-linger --node "$(command -v node)"`
only when the operator has intentionally selected that policy. It never invokes
`sudo`.

## Governed Start And Stop Evidence

Use one directory per local agent. The active control service remains the sole
consumer of the signed control inbox; `control-receipt.mjs --observe-state`
correlates each queued probe to the daemon's redacted state.

```bash
AGENT_ID=manager
AGENT_TOKEN_ENV=MUPOT_AGENT_TOKEN_MANAGER
OUT="$HOME/.fleet/receipts/$AGENT_ID"
mkdir -p "$OUT"
node "$HOME/.fleet/runtime/host-receipt.mjs" \
  --require-services --service-manager auto \
  --node "$(command -v node)" \
  > "$OUT/host.json"

node "$HOME/.fleet/runtime/cutover-probe.mjs" \
  --base-url https://YOUR-POT.example.com \
  --agent "$AGENT_ID" --agent-token-env "$AGENT_TOKEN_ENV" \
  --queue-inbox --control start \
  > "$OUT/probe-start.json"
node "$HOME/.fleet/runtime/control-receipt.mjs" --observe-state \
  --probe-receipt "$OUT/probe-start.json" --verb start \
  > "$OUT/control-start.json"
node "$HOME/.fleet/runtime/receipt-bundle.mjs" \
  --agent "$AGENT_ID" --out-dir "$OUT" \
  --install-receipt "$HOME/.fleet/receipts/install.json" \
  --probe-receipt "$OUT/probe-start.json" --skip-host --skip-control

node "$HOME/.fleet/runtime/continuous-runtime-receipt.mjs" \
  --agent "$AGENT_ID" --service-manager auto --require-control start \
  > "$OUT/continuous.json"

node "$HOME/.fleet/runtime/cutover-probe.mjs" \
  --base-url https://YOUR-POT.example.com \
  --agent "$AGENT_ID" --control stop \
  > "$OUT/probe-stop.json"
node "$HOME/.fleet/runtime/control-receipt.mjs" --observe-state \
  --probe-receipt "$OUT/probe-stop.json" --verb stop \
  > "$OUT/control-stop.json"
node "$HOME/.fleet/runtime/receipt-bundle.mjs" \
  --agent "$AGENT_ID" --out-dir "$OUT" \
  --probe-receipt "$OUT/probe-stop.json" \
  --skip-host --skip-runtime --skip-control
node "$HOME/.fleet/runtime/receipt-bundle.mjs" \
  --agent "$AGENT_ID" --out-dir "$OUT" --verify-only
```

The accepted daemon event must follow the probe timestamp, arrive within the
bounded collection window, match the admitted probe nonce hash, and come from
the PID recorded for the running control service.

## Lifecycle, Starter, And Copied Bundle

The supported service lifecycle is explicit:

```bash
node fleet-runtime/service-manager.mjs install --service-manager auto --node "$(command -v node)"
node fleet-runtime/service-manager.mjs reload --service-manager auto --node "$(command -v node)"
node fleet-runtime/service-manager.mjs status --service-manager auto
node fleet-runtime/service-manager.mjs uninstall --service-manager auto
```

After the start, continuous, and stop receipts pass, follow the generated starter
plan to create `starter-receipt.json`. Export and independently verify the copied
bundle:

```bash
node "$HOME/.fleet/runtime/receipt-bundle.mjs" \
  --out-dir "$OUT" --export-dir "$OUT-attach" --export
node "$HOME/.fleet/runtime/receipt-bundle.mjs" \
  --out-dir "$OUT-attach" --check-manifest
```

Attach only the copied bundle when `manifest.json`, `cutover-gate.json`,
`export-receipt.json`, and `manifest-check.json` all report `pass`.

## Kubernetes Agent Host

The Kubernetes template is under `deploy/kubernetes/agent-host`. The repository
does not create or retain the customer identity, private signing key, model
login, or cluster access. The DME operator owns those inputs and builds a
derived image that adds the Hermes executable to the credential-free Agent Host
base image.

1. Build and publish the credential-free base image from
   `fleet-runtime/Dockerfile.agent-host`. For the pinned Hermes release used by
   DME, build the audited derived image and its source-bound local provenance
   receipt directly from the repository root:

   ```bash
   node scripts/hermes-agent-host-image-provenance.mjs \
     --build-tag YOUR_REGISTRY/mupot-agent-host-hermes:0.23.0 \
     --output ./receipts/hermes-image-local.json
   ```

2. Publish the DME-owned derived image and pin the Deployment image by digest,
   not by tag. The derived image contains `/usr/local/bin/hermes`, runs as
   `10000:10000`, matching the pinned Hermes image and existing DME PVC, and
   sets the Hermes home and write-safe root to
   `/home/mupot`; it contains no Mupot or model credential. After publishing,
   pull the immutable registry reference and generate the release provenance
   bound to that digest:

   ```bash
   docker pull YOUR_REGISTRY/mupot-agent-host-hermes@sha256:IMAGE_DIGEST
   node scripts/hermes-agent-host-image-provenance.mjs \
     --image YOUR_REGISTRY/mupot-agent-host-hermes@sha256:IMAGE_DIGEST \
     --image-digest sha256:IMAGE_DIGEST \
     --output ./receipts/hermes-image.json
   ```
3. Replace the project and endpoint placeholders in a private copy of
   `config.example.json`.
4. Register the welded agent's Ed25519 public key in its DME pot. Deliver only
   the matching private JWK through the cluster secret manager as Secret
   `dme-hermes-signing-key`, key `dme-hermes-k8s.key`. Never pass it on a command
   line, place it in a ConfigMap, or write it to Git. The projected file must be
   owned by `root:10000` with mode `0440`; the runtime accepts that exact trusted
   group state (and owner-owned `0600` for non-Kubernetes hosts) and rejects all
   other ownership/mode combinations.
5. Keep the DME-owned Hermes home on PVC `dme-hermes-data` and the audited
   operator plugin in ConfigMap `dme-mupot-plugin`. The Deployment mounts them
   at `/home/mupot` and `/home/mupot/plugins/mupot`. It mounts the welded
   operator token from the Host-only Secret `dme-mupot-agent-host`, key `token`, at the exact
   read-only path `/run/secrets/mupot-agent/token`; no token value is accepted
   in an environment variable, config, or rendered YAML. The profile explicitly
   declares `inherited_env: [MUPOT_AGENT_TOKEN_FILE, MUPOT_PLUGIN_MODE]`. The
   fixed adapter validates that path, reads the bounded secret, and provides the
   token only to the Hermes child. The daemon probe receives neither the token
   nor its file path; unrelated provider keys and environment secrets are
   stripped. The profile
   invokes `hermes-inbox-adapter.mjs`, which validates the bounded project batch
   and runs Hermes as a quiet, six-turn, single-query process. The adapter sends
   the prompt over stdin through a fixed Python bridge, so project messages are
   not exposed in process arguments and batches larger than Linux's per-argument
   limit remain valid. Raw JSON is not mistaken for interactive terminal input.
   The profile's 120-second deadline is nested inside a 150-second daemon
   supervisor deadline. A profile timeout kills the detached adapter process
   group before the message can be peeked again.
6. Apply the shipped `dme-hermes-agent-host` Deployment at its safe default of
   zero replicas. Do not start it while the legacy `mupot-subscriber` container
   can poll the same welded identity. Remove that subscriber from the existing
   DME Hermes Deployment and verify the dashboard and Telegram containers remain
   ready. Run the read-only cutover preflight immediately afterward; it fails if
   any workload or pod still contains `mupot-subscriber`, if a Host pod exists,
   or if the preserved DME Deployment or any admitted DME pod contains
   application containers other than `hermes` and `telegram-gateway`, any
   ephemeral container, or any init container other than the optional
   `seed-profile` initializer. When present, `seed-profile` must match its
   approved digest-pinned execution contract exactly; restartable init
   containers are rejected:

   ```bash
   node scripts/kubernetes-agent-host-cutover-preflight.mjs \
     > ./receipts/cutover-preflight.json
   ```

   Keep the Host Deployment at zero replicas. The release receipt accepts only
   a passing preflight observed within the last five minutes and bound to the
   exact cluster context, namespace UID, resource UIDs, and resource versions.
   Activation is performed later by the guarded operator command, never by
   applying a one-replica manifest.
   Before removing the legacy subscriber, keep the welded agent's inbox consumer
   mode at its default `bearer_only`. Stop the legacy Deployment and wait until
   every legacy pod has terminated, verify the registered key through
   `inbox_consumer_status`, then use an owner/admin credential to call
   `set_agent_inbox_consumer` with `mode: "signed_only"`, the current
   `expected_generation`, and an operator reason. The D1 policy is embedded in
   the inbox claim SQL: after that CAS transition, bearer HTTP, MCP, and Hermes
   plugin inbox reads are refused while only Ed25519 Host reads signed by the
   exact key fingerprint pinned by that transition are accepted. Key rotation
   therefore requires a deliberate fenced transition; replacing the active key
   cannot silently transfer inbox authority.
   The Host and legacy subscriber must use separate bearer Secrets; the Host-only
   credential is `dme-mupot-agent-host`.
7. Render the `dme-hermes-agent-host` ConfigMap's `daemon.json` and
   `inbox-handler.json` from `config.example.json`, then apply the ConfigMap,
   Deployment, and NetworkPolicy. The Kubernetes package runs in on-demand Host
   mode and deliberately does not start a second control-inbox consumer.
8. Export the exact plugin ConfigMap data, render an immutable content-addressed
   copy, and replace `replace-with-immutable-plugin-config-map` in both the Host
   Deployment and smoke Job with its generated name. Then render
   `plugin-smoke-job.yaml` with the same immutable image digest, and run it while
   the Host remains at zero replicas. Apply the exact smoke NetworkPolicy first;
   it selects only the smoke pod and denies all ingress and egress. The Job has
   no Mupot token, mounts no customer PVC, and does not consume an inbox; it
   proves that Hermes discovers
   `mupot` `0.3.0` as enabled and that the mounted operator source declares
   toolset `mupot-operator`. Collect the result through the evidence command,
   which binds the log to the live Job UID, pod UID, exact execution-contract
   hash, completion time, and runtime image ID. Raw logs alone are not release
   evidence.

   ```bash
   kubectl -n dme-hermes get configmap dme-mupot-plugin -o json \
     | jq '{apiVersion,kind,metadata:{name:.metadata.name},data}' \
     > ./rendered/plugin-config-map-source.json
   node scripts/kubernetes-hermes-plugin-smoke-evidence.mjs \
     --render-plugin-config-map ./rendered/plugin-config-map-source.json \
     --output ./rendered/plugin-config-map.json
   PLUGIN_CONFIG_MAP="$(jq -r '.metadata.name' ./rendered/plugin-config-map.json)"
   # Render both manifest placeholders to $PLUGIN_CONFIG_MAP before validation.
   kubectl -n dme-hermes apply -f ./rendered/plugin-config-map.json
   kubectl -n dme-hermes apply -f ./rendered/plugin-smoke-network-policy.yaml
   kubectl -n dme-hermes apply -f ./rendered/plugin-smoke-job.yaml
   kubectl -n dme-hermes wait --for=condition=complete job/dme-hermes-plugin-smoke --timeout=60s
   node scripts/kubernetes-hermes-plugin-smoke-evidence.mjs \
     --job-manifest ./rendered/plugin-smoke-job.yaml \
     --plugin-config-map ./rendered/plugin-config-map.json \
     --image-digest sha256:REPLACE_WITH_IMAGE_DIGEST \
     --output ./receipts/hermes-plugin-smoke-evidence.json
   kubectl -n dme-hermes delete job dme-hermes-plugin-smoke
   kubectl -n dme-hermes delete -f ./rendered/plugin-smoke-network-policy.yaml
   # Refresh the resource-version snapshot after all temporary smoke objects are gone.
   node scripts/kubernetes-agent-host-cutover-preflight.mjs \
     > ./receipts/cutover-preflight.json
   ```

Before rollout, generate a redacted receipt from the rendered files:

```bash
npm run --silent receipt:kubernetes-agent-host -- \
  --deployment ./rendered/deployment.yaml \
  --network-policy ./rendered/network-policy.yaml \
  --config ./rendered/config.json \
  --plugin-config-map ./rendered/plugin-config-map.json \
  --plugin-smoke-job ./rendered/plugin-smoke-job.yaml \
  --plugin-smoke-network-policy ./rendered/plugin-smoke-network-policy.yaml \
  --plugin-smoke-evidence ./receipts/hermes-plugin-smoke-evidence.json \
  --image-provenance ./receipts/hermes-image.json \
  --cutover-preflight ./receipts/cutover-preflight.json \
  --cluster-context "$(kubectl config current-context)" \
  --namespace-uid "$(kubectl get namespace dme-hermes -o jsonpath='{.metadata.uid}')" \
  --image-digest sha256:REPLACE_WITH_IMAGE_DIGEST \
  > ./receipts/kubernetes-agent-host.json
```

The receipt fails unless the image is immutable, pod execution is non-root and
read-only, privilege escalation and service-account token mounting are disabled,
resources and health probes are bounded, ingress is denied, egress uses the
trusted gateway, the exact DME signing-key mount is referenced, rendered daemon
and inbox configs match the declared package config, the project is explicit,
the profile enforces that exact project for every activated message, and all
rendered config objects use exact schemas without private JWKs or literal
credentials. It also requires exact, unique Hermes PVC, plugin, signing-key, and
token-file mounts; duplicate mounts, `subPath`, changed Secret names/keys,
literal tokens, undeclared child environment, or extra volume fields fail
closed. The image provenance binds the deployed digest to the reviewed
Dockerfile, complete copied runtime bundle, pinned Hermes base, non-root identity,
entrypoint, Hermes version, adapter import, and stdin-bridge callable-contract
smoke against the pinned Hermes CLI. The
plugin evidence binds an immutable content-addressed ConfigMap, including its
live UID and resource version, to non-consuming discovery in the
same immutable runtime image, the exact smoke Job execution contract, and a
fresh successful pod observation. The exact deny-all smoke NetworkPolicy is a
required artifact. The receipt
also requires a fresh live-cluster proof that the legacy subscriber is absent
and the new Host is inert before activation. The plugin ConfigMap, exact smoke
Job, smoke result, image provenance, and cutover preflight are recursively
checked for credential material. The receipt
records only artifact and profile digests, never the profile command, sender
list, private key path, token value, or private key value.
The passing release receipt requires the Host to remain at zero replicas. The
repository template and rendered release both remain inert, so applying either
cannot create two consumers.

Before applying, validate the rendered objects against the target namespace:

```bash
kubectl -n dme-hermes apply --dry-run=server \
  -f ./rendered/deployment.yaml \
  -f ./rendered/network-policy.yaml \
  -f ./rendered/plugin-config-map.json \
  -f ./rendered/plugin-smoke-network-policy.yaml \
  -f ./rendered/plugin-smoke-job.yaml
```

Cut over in this order: install the zero-replica Host and immutable plugin,
stop and remove the legacy subscriber, wait for zero legacy pods, CAS the welded
agent's inbox consumer from `bearer_only` to `signed_only`, generate the passing
release receipt, then run the guarded activation command. It verifies the live
fence and pinned active-key match through the exact Host-only agent credential,
compares the live resource versions
and immutable plugin identity to the preflight, scales with optimistic
concurrency, watches Pod events from the pre-scale list resource version so even
a transient return of the legacy consumer or admitted DME runtime drift is
detected, waits for readiness,
requires readiness to include a successful signed inbox operation, revalidates
the same fence generation and pinned key after startup, revalidates the source
runtime, and returns the Host to zero automatically if any post-scale check
changes or the overlap monitor fails. A scale request that times out is treated
as possibly applied and is also rolled back to confirmed zero Host pods.

```bash
node scripts/kubernetes-agent-host-activate.mjs \
  --preflight ./receipts/cutover-preflight.json \
  --smoke-evidence ./receipts/hermes-plugin-smoke-evidence.json \
  --release-receipt ./receipts/kubernetes-agent-host.json \
  --deployment ./rendered/deployment.yaml \
  --output ./receipts/activation.json
```

After `activation.json` reports `status:"pass"`, send one governed cross-pot
evidence flight and retain its correlation ID. Prove the resulting receipt from
both sovereign project Evidence APIs with independently scoped, read-only token
files. Never pass either token value as a command argument:

```bash
npm run --silent receipt:project-link-flight -- \
  --source-url https://mupot.mumega.com \
  --source-pot mumega \
  --source-project REPLACE_WITH_MUMEGA_PROJECT_ID \
  --source-token-file /run/secrets/mumega-project-reader/token \
  --destination-url https://REPLACE_WITH_DME_MUPOT_HOST \
  --destination-pot dme \
  --destination-project REPLACE_WITH_DME_PROJECT_ID \
  --destination-token-file /run/secrets/dme-project-reader/token \
  --correlation REPLACE_WITH_FLIGHT_CORRELATION_ID \
  --not-before REPLACE_WITH_FLIGHT_DISPATCH_ISO_TIME \
  --output ./receipts/project-link-flight.json
```

The live flight is accepted only when `project-link-flight.json` reports
`schema:"mupot.project-link-flight-evidence/v1"` and `status:"pass"`. The
verifier follows each project Evidence cursor, requires exactly one outbound
and one inbound receipt for the correlation, requires a non-null evidence hash,
rejects receipts older than the declared flight dispatch time or implausibly in
the future,
and compares the envelope hash, evidence hash, canonical receipt hash,
destination key id, and destination signature. The receipt records project
identifiers and public proof only; bearer values are never copied into it.

Roll back in reverse:
scale the Host to zero and wait for termination, generate a passing
`--mode rollback-ready` preflight, CAS the inbox consumer from `signed_only` to
`bearer_only`, restore the legacy subscriber, and generate
a passing `--mode rollback-complete` preflight. The completed receipt requires
the Host to remain inert, the live consumer fence to remain `bearer_only` at a
positive generation, and the legacy subscriber to exist only in the preserved
DME Deployment. Never overlap the two consumers.

```bash
node scripts/kubernetes-agent-host-cutover-preflight.mjs --mode rollback-ready \
  > ./receipts/rollback-ready.json
# Restore the legacy mupot-subscriber only after rollback-ready passes.
node scripts/kubernetes-agent-host-cutover-preflight.mjs --mode rollback-complete \
  > ./receipts/rollback-complete.json
```

## Data-Preserving Rollback And Recovery

Uninstall unloads only the known user services and removes only their known
definitions. It preserves configs, keys, runtime files, handlers, inboxes,
logs, state, and receipts under `$HOME/.fleet`.

```bash
node "$HOME/.fleet/runtime/service-manager.mjs" uninstall --service-manager auto \
  > "$HOME/.fleet/receipts/service-uninstall.json"
```

For recovery, rerun the non-destructive installer, activate the selected service
manager, queue a fresh governed `start`, and require new heartbeat/control counter
advancement. Old receipts do not prove a recovered process.

```bash
node fleet-runtime/install.mjs --activate --service-manager auto \
  --node "$(command -v node)" \
  > "$HOME/.fleet/receipts/recovery-install.json"
node "$HOME/.fleet/runtime/service-manager.mjs" reload --service-manager auto \
  --node "$(command -v node)" \
  > "$HOME/.fleet/receipts/recovery-reload.json"
node "$HOME/.fleet/runtime/cutover-probe.mjs" \
  --base-url https://YOUR-POT.example.com \
  --agent "$AGENT_ID" --control start \
  > "$OUT/probe-recovery-start.json"
node "$HOME/.fleet/runtime/control-receipt.mjs" --observe-state \
  --probe-receipt "$OUT/probe-recovery-start.json" --verb start \
  > "$OUT/control-recovery-start.json"
node "$HOME/.fleet/runtime/continuous-runtime-receipt.mjs" \
  --agent "$AGENT_ID" --service-manager auto --require-control start \
  > "$HOME/.fleet/receipts/recovery-continuous.json"
```
