# Cross-Platform Runtime Installer and Two-Agent Starter

Status: approved for implementation design on 2026-07-13

## Context

Mupot v0.23.0 has one production-proven runtime. Canonical Hermes
`d288d8c0-e84d-4a40-a843-8cf10a07fe87` heartbeats, drains its signed
Mupot inbox, completes retained tasks, and receives signed lifecycle control.
Flight #351 proved that loop on Hadi's Mac.

The product gap is reproducibility. `fleet-runtime/install.mjs` installs
systemd user units, but the working macOS launchd definitions were assembled
manually. The current host receipt validates files and optional runtime probes;
it does not prove that the heartbeat and control services are installed,
loaded, and continuously advancing. A historical one-shot Host-Go receipt can
therefore coexist with `Runtime online: 0`.

Issue #352 owns the installer gap. Epic #249 owns expansion from one live
runtime to a Mupot-native squad and eventual per-agent SOS retirement.

## Goal

Turn the proven runtime into a repeatable, owner-operated installation that:

1. installs on a customer-owned macOS Mac Mini or Linux VPS;
2. supports explicit install, reload, status, and uninstall service lifecycles;
3. emits redacted evidence that the background runtime is continuously alive;
4. boots a two-agent squad that coordinates through Mupot rather than SOS; and
5. packages the verified configuration as a forkable customer starter.

The first customer-facing path remains CLI-based. A signed `.pkg`, GUI
installer, hosted control plane, and unattended secret provisioning are not
part of this phase.

## Design Principles

- **One product contract, platform adapters underneath.** macOS and Linux
  expose the same commands and receipt types.
- **Explicit activation.** File installation remains non-destructive unless
  the operator passes `--activate` or calls the service command.
- **No credentials in service definitions.** Services receive only paths,
  `HOME`, and a minimal executable `PATH`; keys stay in mode-0600 files.
- **Data-preserving uninstall.** Unloading services never deletes identities,
  private keys, configs, inboxes, job results, or receipts.
- **Condition-based evidence.** Continuous-runtime proof observes advancing
  state rather than sleeping for an arbitrary soak duration.
- **Fail closed.** Unknown platforms, conflicting legacy flags, stale service
  definitions, dead processes, non-advancing heartbeat state, or mismatched
  tenant identity produce failed receipts.

## Architecture

### 1. Installer

`fleet-runtime/install.mjs` remains the layout bootstrap and gains:

```text
--service-manager auto|systemd|launchd|none
--activate
--launchd-dir <path>
--systemd-dir <path>
--node <absolute-path>
--enable-linger
```

`auto` resolves to `launchd` on `darwin`, `systemd` on `linux`, and
fails on unsupported platforms unless the operator explicitly selects
`none`. The default remains `auto`.

Compatibility rules:

- existing Linux invocations continue installing systemd definitions;
- `--skip-systemd` remains a deprecated alias for
  `--service-manager none`;
- `--skip-systemd` conflicts with an explicit non-`none` manager;
- `--systemd-dir` is accepted only for `systemd`;
- `--launchd-dir` is accepted only for `launchd`;
- `--enable-linger` is accepted only for `systemd` and is never implied;
- existing config files remain preserved unless `--force-config` is used.

The installer creates mode-0700 `logs` and `state` directories in addition
to the current runtime, agents, handlers, inbox, and receipts directories.
Service files are rendered from structured definitions rather than copied as
ad hoc text.

### 2. Service Manager

A new `fleet-runtime/service-manager.mjs` exposes:

```text
service-manager.mjs install
service-manager.mjs reload
service-manager.mjs status
service-manager.mjs uninstall
```

Common options select the manager, prefix, definition directory, Node binary,
and dry-run mode. Platform-specific code is isolated behind a small adapter
contract:

```text
render(context) -> service definitions
install(context, runner) -> command outcomes
reload(context, runner) -> command outcomes
status(context, runner) -> normalized service states
uninstall(context, runner) -> command outcomes
```

Command execution is injected so unit tests never manipulate the developer's
real service manager.

#### launchd adapter

The launchd adapter manages these user services:

- `com.mumega.mupot-fleet-daemon`
- `com.mumega.mupot-fleet-control`

Definitions use:

- absolute `ProgramArguments` for Node, runtime script, and config;
- `RunAtLoad=true`, `KeepAlive=true`, and background process type;
- `HOME` plus a minimal non-secret `PATH`;
- stdout and stderr under `~/.fleet/logs`;
- no shell wrapper and no credential environment variables.

Runtime operations target the current user's `gui/<uid>` domain.
`install` bootstraps absent services, `reload` bootouts any loaded old
definition then bootstraps the new definition, and `uninstall` bootouts
loaded services before removing only the plist files. Already-loaded and
already-unloaded states are handled idempotently.

#### systemd adapter

The systemd adapter preserves the existing unit names:

- `fleet-daemon.service`
- `fleet-control-daemon.service`

It renders absolute paths using the same context as launchd. Lifecycle actions
use `systemctl --user daemon-reload`, `enable --now`, `restart`,
`is-active`, `disable --now`, and a final `daemon-reload`.

Continuous Linux operation after an SSH/logout boundary requires systemd user
lingering. Status checks query `loginctl show-user <user> -p Linger`.
`--enable-linger` may call `loginctl enable-linger <user>` only as an
explicit operator action and records the outcome. Without lingering, service
installation may succeed but a continuous-runtime receipt fails with a precise
`linger_disabled` next step. The installer never invokes `sudo` itself.

### 3. Machine-Readable Runtime State

The heartbeat and control daemons atomically maintain redacted state:

- `~/.fleet/state/fleet-daemon.json`
- `~/.fleet/state/fleet-control.json`

Heartbeat state contains the daemon PID/start time, monotonically increasing
tick number, last tick time, configured interval, and per-agent probe,
heartbeat HTTP status, inbox count, and consume result. It never contains
message bodies, signatures, tokens, or key material.

Control state contains the daemon PID/start time, poll number, last poll time,
consumer identity, and the last redacted control outcome: agent ID, verb,
accepted/rejected state, and execution result. It never stores the signed
request or nonce.

Writes use a temporary mode-0600 file followed by atomic rename. A failed state
write is logged but cannot turn a failed heartbeat or control action into a
pass.

### 4. Receipts

#### Install receipt

`mupot-fleet-install-receipt/v1` remains backward compatible and adds:

- selected/resolved service manager;
- definition paths and hashes;
- Node and prefix paths;
- activation requested/performed;
- logs and state directories;
- explicit next lifecycle command.

#### Service receipt

`mupot-fleet-service-receipt/v1` is emitted by every service command. It
records:

- platform and service-manager identity;
- lifecycle action;
- expected definition hashes;
- normalized loaded/enabled/running/PID state for both services;
- the systemd linger state when applicable;
- redacted command exit outcomes;
- preserved-data declaration; and
- deterministic next steps on failure.

A successful `install` or `reload` receipt requires both services loaded and
running. A successful `uninstall` receipt requires both services unloaded and
definitions absent while the configured data directories still exist.

#### Continuous-runtime receipt

A new `continuous-runtime-receipt.mjs` emits
`mupot-fleet-continuous-runtime-receipt/v1`.

It first requires a passing service status. It then reads the heartbeat state,
waits until its tick advances within `interval + grace`, and requires:

- the service remains running;
- the selected agent probe is alive;
- signed heartbeat status is 2xx;
- the heartbeat timestamp is fresh under the pot TTL; and
- no failed inbox consume is reported for the observed tick.

It also requires the control daemon poll number to advance. An optional
`--require-control <verb>` binds a recent accepted control outcome for the
selected agent. This is condition-based bounded waiting, not a duration soak.

#### Host receipt

`host-receipt.mjs` gains:

```text
--require-services
--service-manager auto|systemd|launchd
--service-definition-dir <path>
```

When required, host readiness fails unless definitions match the current
runtime/config paths and both services are loaded and running. Existing calls
without `--require-services` retain their current behavior.

### 5. Forkable Starter Manifest

The customer starter is configuration and command planning, not a credential
bundle. A versioned manifest describes:

```json
{
  "version": 1,
  "tenant": "<tenant-slug>",
  "base_url": "<pot-url>",
  "service_manager": "auto",
  "agents": [
    {
      "agent_id": "<canonical-id>",
      "runtime": "hermes|codex|claude-code",
      "probe": "<host-local probe>",
      "handler": "<host-local handler>"
    }
  ],
  "control_consumer_agent_id": "<canonical-id>"
}
```

The generated plan uses placeholders for show-once tokens and public keys. It
never exports raw tokens, private keys, Cloudflare secrets, customer messages,
or existing Mumega identity data.

The manifest supports multiple agents on one host and agents distributed
across hosts. A single Mac Mini or VPS can therefore run the complete
two-agent starter when both runtime probes and handlers are local. The Mumega
reference proof deliberately uses one Mac and one VPS to verify both platform
adapters; that distribution is evidence coverage, not a product requirement.

The starter verifier requires install, service, host, continuous-runtime,
runtime inbox, lifecycle control, and copied-bundle manifest receipts before a
host can be labeled ready.

## Two-Agent Mumega Flight

After the installer lands, the first two-agent proof uses:

- Hermes on Hadi's Mac as the manager/reviewer runtime; and
- VPS Codex on the Mumega VPS as the implementation runtime.

Both agents receive canonical Mupot identities, agent-bound least-privilege
member tokens, Ed25519 keys, host configs, and passing per-host receipts.
Neither agent is considered cut over merely because its service intent says
`running`.

The real project flight is: **produce and verify the forkable customer runtime
starter**.

Mupot owns the complete workflow:

1. a goal and governed flight are created in Mupot;
2. VPS Codex receives the Linux install/verification task through its signed
   Mupot inbox;
3. Hermes receives the macOS verification and starter-review task through its
   signed Mupot inbox;
4. both task results are retained in Mupot;
5. the gate evaluates the Mac and VPS receipt bundles;
6. the accountable owner records the verdict; and
7. the flight lands only after both tasks and the gate are complete.

GitHub may hold code and redacted artifacts, but SOS is not the task,
acknowledgement, memory, or gate transport for this flight. SOS wiring is
removed only for an agent whose own cutover gate passes.

## Error Handling and Rollback

- Rendering or validation failure performs no service-manager mutation.
- Partial install attempts collect all command outcomes and return a failed
  receipt with exact cleanup/retry steps.
- launchd reload failure attempts to restore the prior valid definition when
  its hash and content were captured before mutation.
- systemd reload failure leaves definitions in place and reports service state;
  it does not delete configs or keys.
- Uninstall refuses unknown labels/units and never recursively deletes the
  runtime prefix.
- Receipt generation redacts command arguments classified as credentials and
  rejects output containing known secret patterns.
- A daemon can restart under KeepAlive, but continuous proof passes only after
  state advances again.

## Delivery Slices

The goal spans host installation, runtime evidence, and a production squad.
It is delivered as five independently reviewable slices rather than one large
change:

1. **Cross-platform service manager:** renderers, lifecycle commands,
   compatibility flags, install/service receipts, and documentation.
2. **Continuous-runtime evidence:** atomic daemon state, continuous receipt,
   and service-aware host receipt.
3. **macOS Host-Go:** install/reload/uninstall/reinstall on Hadi's Mac with a
   portable redacted evidence bundle.
4. **Linux second runtime:** systemd/linger Host-Go and VPS Codex Mupot-native
   task completion.
5. **Dyad starter flight:** the governed Hermes/VPS Codex project flight,
   forkable manifest, copied-bundle verification, browser evidence, and final
   independent review.

Each code slice uses its own exact-SHA review and CI gate. Later slices may
consume earlier merged behavior but cannot retroactively weaken their receipts.

## Testing

### Automated

- parser and compatibility tests for every new CLI option;
- deterministic platform selection with injected platform/UID/path inputs;
- golden launchd plist and systemd unit rendering tests;
- Linux linger-disabled, linger-enabled, and explicit enable-linger tests;
- path escaping and spaces-in-path tests;
- no-secret assertions over definitions and receipts;
- injected-runner lifecycle tests for install/reload/status/uninstall,
  including already-present and partially failed states;
- data-preservation tests for uninstall;
- atomic daemon-state writer tests;
- continuous receipt pass, timeout, stale, dead-probe, failed-heartbeat,
  failed-consume, stopped-service, and control-binding tests;
- host receipt compatibility and `--require-services` failure tests;
- starter manifest validation and secret-rejection tests;
- the full unit, fleet-runtime, plugin, typecheck, audit, and no-secrets suites.

### Real-host verification

macOS:

1. install definitions without activation;
2. activate both launchd services;
3. prove status and continuous-runtime receipts;
4. deliver and consume a signed inbox task;
5. execute signed start control;
6. reload both services and prove state advances;
7. uninstall and prove configs/keys/receipts remain;
8. reinstall and recover to runtime online.

Linux VPS:

1. install and activate both systemd user services;
2. verify user lingering survives the logout boundary;
3. prove the same host and continuous-runtime receipts;
4. deliver and complete a VPS Codex task;
5. reload and verify recovery.

Production browser verification must show two current runtimes, no new recent
failures, and links from the relevant task, gate, and audit records.

## Acceptance Criteria

The phase is complete only when all of the following are true:

1. #352 is merged with supported launchd installation and lifecycle commands.
2. macOS install, reload, uninstall, and recovery receipts pass on Hadi's Mac.
3. Linux install/reload receipts pass on the Mumega VPS.
4. Continuous-runtime receipts pass for Hermes and VPS Codex.
5. Both agents are simultaneously current in production Mupot.
6. A real two-agent Mupot flight completes with retained tasks, gate verdict,
   redacted receipt bundles, and no SOS transport dependency.
7. A copied forkable starter bundle passes its manifest and secret scans.
8. Authenticated production browser evidence confirms the two-runtime state.
9. Independent review reports no blockers.

Until every item has direct evidence, the broader goal remains active.
