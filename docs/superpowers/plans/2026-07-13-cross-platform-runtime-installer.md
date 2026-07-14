# Cross-Platform Runtime Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the proven Mupot runtime into a repeatable owner-operated installation that boots and proves a two-agent squad on customer-owned macOS or Linux hosts.

**Architecture:** Keep `fleet-runtime/install.mjs` as the non-destructive layout bootstrap, then route service rendering and lifecycle operations through injected launchd and systemd adapters. Both daemons atomically publish redacted state; service, host, and continuous-runtime receipts consume that state and fail closed. A sterile starter manifest packages configuration and evidence requirements without credentials, and the final Mumega flight proves the complete Hermes-on-Mac plus Codex-on-VPS workflow through Mupot tasks, gates, and retained evidence.

**Tech Stack:** Node.js ESM, Node test runner, macOS launchd, Linux systemd user services, Ed25519-signed Mupot runtime APIs, JSON receipts, Vitest/TypeScript application tests, Playwright browser verification, GitHub Actions.

## Global Constraints

- Keep `mupot-fleet-install-receipt/v1` backward compatible; all new receipt types use the exact `/v1` names approved in the design.
- Default `--service-manager` is `auto`: resolve `darwin` to `launchd`, `linux` to `systemd`, and reject unsupported platforms unless `none` is explicit.
- `--skip-systemd` remains a deprecated alias for `--service-manager none` and conflicts with an explicit non-`none` manager.
- Installation writes service definitions but performs no service-manager mutation without `--activate` or an explicit lifecycle command.
- Service definitions contain absolute Node/runtime/config paths, `HOME`, and a minimal `PATH`; they contain no tokens, private keys, or credential environment variables.
- Runtime, agent, handler, inbox, log, state, and receipt directories are mode `0700`; daemon state and receipts are mode `0600`.
- Uninstall removes only known service definitions and unloads only known labels/units. It preserves configs, keys, runtime files, inboxes, job results, logs, state, and receipts.
- `--enable-linger` is systemd-only, explicit, and never invokes `sudo`.
- Continuous proof is bounded by observed state advancement, never by a fixed-duration soak.
- No real credential value enters Git, a service definition, command output, test fixture, receipt, starter manifest, or evidence attachment.
- The primary checkout at `/Users/hadi/Documents/mupot` remains untouched; all implementation uses `/Users/hadi/Documents/mupot/.worktrees/macos-launchd-installer`.
- Each code task follows red-green-refactor, receives independent review, and lands as its own commit.

## File Map

- Create `fleet-runtime/runtime-state.mjs`: atomic mode-0600 JSON state writer and state reader.
- Create `fleet-runtime/service-context.mjs`: service names, option validation, platform selection, absolute-path context, hashes, and normalized status types.
- Create `fleet-runtime/launchd-service-manager.mjs`: plist rendering and injected launchctl lifecycle adapter.
- Create `fleet-runtime/systemd-service-manager.mjs`: unit rendering, injected systemctl lifecycle adapter, and linger policy.
- Create `fleet-runtime/service-manager.mjs`: common install/reload/status/uninstall CLI and service receipt orchestration.
- Create `fleet-runtime/continuous-runtime-receipt.mjs`: condition-based heartbeat/control advancement verifier.
- Create `fleet-runtime/starter-manifest.mjs`: sterile forkable manifest validation, command plan, and copied-bundle verifier.
- Create focused `*.test.mjs` files beside every new runtime module.
- Modify `fleet-runtime/install.mjs` and `install.test.mjs`: unified manager flags, logs/state layout, rendered definitions, optional activation, enhanced install receipt.
- Modify both daemon modules and tests: monotonic redacted state publication.
- Modify `fleet-runtime/host-receipt.mjs` and its test: optional service-aware Host-Go checks.
- Modify `fleet-runtime/receipt-bundle.mjs` and its test: service/continuous/starter evidence in the exported manifest.
- Modify `fleet-runtime/README.md` and `package.json`: operator commands and npm entry points.
- Create `docs/runtime-starter.md`: customer-owned installation, topology, rollback, and evidence runbook.

---

### Task 1: Lock the Service Context and Platform Contract

**Files:**
- Create: `fleet-runtime/service-context.mjs`
- Create: `fleet-runtime/service-context.test.mjs`

**Interfaces:**
- Consumes: Node `platform()`, `homedir()`, `userInfo()`, `process.getuid()`, and filesystem paths supplied through injectable inputs.
- Produces: `SERVICE_SPECS`, `resolveServiceManager(requested, platformName)`, `validateServiceOptions(opts)`, `createServiceContext(opts)`, `definitionSha256(content)`, and `summarizeServiceStates(states)`.

- [ ] **Step 1: Write failing platform, compatibility, and path tests**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  createServiceContext,
  resolveServiceManager,
  validateServiceOptions,
} from './service-context.mjs'

test('auto selects launchd on macOS and systemd on Linux', () => {
  assert.equal(resolveServiceManager('auto', 'darwin'), 'launchd')
  assert.equal(resolveServiceManager('auto', 'linux'), 'systemd')
  assert.throws(() => resolveServiceManager('auto', 'freebsd'), /unsupported platform/)
  assert.equal(resolveServiceManager('none', 'freebsd'), 'none')
})

test('legacy and manager-specific options fail closed', () => {
  assert.equal(validateServiceOptions({ skipSystemd: true }).serviceManager, 'none')
  assert.throws(() => validateServiceOptions({ skipSystemd: true, serviceManager: 'launchd', serviceManagerExplicit: true }), /conflicts/)
  assert.throws(() => validateServiceOptions({ serviceManager: 'launchd', systemdDir: '/tmp/systemd', systemdDirExplicit: true }), /systemd-dir/)
  assert.throws(() => validateServiceOptions({ serviceManager: 'launchd', enableLinger: true }), /enable-linger/)
})

test('context contains only absolute non-secret execution paths', () => {
  const context = createServiceContext({
    manager: 'launchd',
    prefix: '/tmp/Mupot Host/.fleet',
    definitionDir: '/tmp/Launch Agents',
    nodePath: '/opt/homebrew/bin/node',
    homeDir: '/Users/example',
    uid: 501,
    username: 'example',
  })
  assert.equal(context.domain, 'gui/501')
  assert.equal(context.services[0].argv[1], join(context.prefix, 'runtime', 'fleet-daemon.mjs'))
  assert.match(JSON.stringify(context), /Mupot Host/)
  assert.doesNotMatch(JSON.stringify(context), /token|private_key|authorization/i)
})
```

- [ ] **Step 2: Run the focused test and confirm the missing-module failure**

Run: `node --test fleet-runtime/service-context.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `service-context.mjs`.

- [ ] **Step 3: Implement the immutable service context**

```js
export const SERVICE_SPECS = Object.freeze([
  Object.freeze({ key: 'heartbeat', launchdLabel: 'com.mumega.mupot-fleet-daemon', systemdUnit: 'fleet-daemon.service', script: 'fleet-daemon.mjs', config: 'daemon.json' }),
  Object.freeze({ key: 'control', launchdLabel: 'com.mumega.mupot-fleet-control', systemdUnit: 'fleet-control-daemon.service', script: 'fleet-control-daemon.mjs', config: 'control.json' }),
])

export function resolveServiceManager(requested = 'auto', platformName = process.platform) {
  if (!['auto', 'systemd', 'launchd', 'none'].includes(requested)) throw new Error(`unsupported service manager: ${requested}`)
  if (requested !== 'auto') return requested
  if (platformName === 'darwin') return 'launchd'
  if (platformName === 'linux') return 'systemd'
  throw new Error(`unsupported platform for automatic service manager: ${platformName}`)
}

export function validateServiceOptions(input = {}) {
  const explicit = input.serviceManagerExplicit === true
  if (input.skipSystemd && explicit && input.serviceManager !== 'none') throw new Error('--skip-systemd conflicts with an explicit non-none --service-manager')
  const serviceManager = input.skipSystemd ? 'none' : (input.serviceManager ?? 'auto')
  if (serviceManager !== 'systemd' && input.systemdDirExplicit) throw new Error('--systemd-dir requires systemd')
  if (serviceManager !== 'launchd' && input.launchdDirExplicit) throw new Error('--launchd-dir requires launchd')
  if (serviceManager !== 'systemd' && input.enableLinger) throw new Error('--enable-linger requires systemd')
  return { ...input, serviceManager }
}
```

Implement `createServiceContext` with resolved absolute `prefix`, `runtimeDir`, `logsDir`, `stateDir`, `definitionDir`, `nodePath`, `homeDir`, `uid`, `username`, `domain`, and two service records. Implement SHA-256 with `createHash('sha256')`, and summarize each service as `{ key, name, definition_path, definition_sha256, loaded, enabled, running, pid }` with unknown booleans represented as `null`.

Use these exact defaults: `prefix=$HOME/.fleet`, `nodePath=process.execPath`, launchd definitions in `$HOME/Library/LaunchAgents`, and systemd definitions in `$HOME/.config/systemd/user`. Require `nodePath`, `prefix`, and `definitionDir` to resolve to absolute paths before rendering.

- [ ] **Step 4: Run the focused test and repository formatting check**

Run: `node --test fleet-runtime/service-context.test.mjs && git diff --check`

Expected: all service-context tests PASS and `git diff --check` prints nothing.

- [ ] **Step 5: Commit the platform contract**

```bash
git add fleet-runtime/service-context.mjs fleet-runtime/service-context.test.mjs
git commit -m "feat(runtime): define cross-platform service context"
```

---

### Task 2: Render and Exercise the launchd Adapter

**Files:**
- Create: `fleet-runtime/launchd-service-manager.mjs`
- Create: `fleet-runtime/launchd-service-manager.test.mjs`

**Interfaces:**
- Consumes: `createServiceContext()` output and an injected `runner(argv) -> Promise<{ code, stdout, stderr }>`.
- Produces: `renderLaunchd(context)`, `installLaunchd(context, runner)`, `reloadLaunchd(context, runner)`, `statusLaunchd(context, runner)`, and `uninstallLaunchd(context, runner)`.

- [ ] **Step 1: Write failing plist and lifecycle tests**

Test exact XML escaping for spaces, `&`, `<`, and `>`; absolute `ProgramArguments`; `RunAtLoad`, `KeepAlive`, `ProcessType=Background`; only `HOME` and `PATH` environment keys; log paths; and no secret-like fields. Use a recording runner to prove:

```js
const calls = []
const runner = async (argv) => {
  calls.push(argv)
  if (argv[1] === 'print') return { code: 113, stdout: '', stderr: 'not found' }
  return { code: 0, stdout: '', stderr: '' }
}
const result = await installLaunchd(context, runner)
assert.equal(result.ok, true)
assert.deepEqual(calls.filter((call) => call[1] === 'bootstrap').map((call) => call.slice(0, 3)), [
  ['launchctl', 'bootstrap', 'gui/501'],
  ['launchctl', 'bootstrap', 'gui/501'],
])
```

Add status fixtures for loaded PID output, unloaded service exit `113`, idempotent uninstall, and reload rollback after a failed bootstrap. The rollback assertion must prove the prior definition content is restored before the second bootstrap attempt.

- [ ] **Step 2: Run the focused test and confirm the missing exports**

Run: `node --test fleet-runtime/launchd-service-manager.test.mjs`

Expected: FAIL because the launchd adapter does not exist.

- [ ] **Step 3: Implement XML rendering and injected launchctl operations**

Use an XML encoder that replaces `&`, `<`, `>`, `"`, and `'`. Render each service to `${definitionDir}/${label}.plist` with this semantic shape:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.mumega.mupot-fleet-daemon</string>
  <key>ProgramArguments</key><array><string>/absolute/node</string><string>/absolute/runtime/fleet-daemon.mjs</string><string>/absolute/daemon.json</string></array>
  <key>WorkingDirectory</key><string>/absolute/runtime</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>EnvironmentVariables</key><dict><key>HOME</key><string>/absolute/home</string><key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StandardOutPath</key><string>/absolute/logs/fleet-daemon.log</string>
  <key>StandardErrorPath</key><string>/absolute/logs/fleet-daemon.err.log</string>
</dict></plist>
```

Implement status with `launchctl print gui/<uid>/<label>` and parse the top-level `pid = <number>` field. Implement lifecycle rules exactly: install bootstraps only unloaded services; reload captures existing definition bytes and hashes, bootouts loaded services, atomically writes definitions, bootstraps, then restores the prior definition and attempts bootstrap if the new bootstrap fails; uninstall bootouts loaded known labels then unlinks only their known plist paths.

- [ ] **Step 4: Run adapter tests**

Run: `node --test fleet-runtime/launchd-service-manager.test.mjs`

Expected: PASS for rendering, spaces-in-path, install, reload rollback, status, uninstall, and no-secret cases.

- [ ] **Step 5: Commit the launchd adapter**

```bash
git add fleet-runtime/launchd-service-manager.mjs fleet-runtime/launchd-service-manager.test.mjs
git commit -m "feat(runtime): add launchd service adapter"
```

---

### Task 3: Render and Exercise the systemd Adapter

**Files:**
- Create: `fleet-runtime/systemd-service-manager.mjs`
- Create: `fleet-runtime/systemd-service-manager.test.mjs`
- Delete after migration: `fleet-runtime/fleet-daemon.service`
- Delete after migration: `fleet-runtime/fleet-control-daemon.service`

**Interfaces:**
- Consumes: service context and injected runner.
- Produces: `renderSystemd(context)`, `installSystemd(context, runner, opts)`, `reloadSystemd(context, runner)`, `statusSystemd(context, runner)`, `uninstallSystemd(context, runner)`, and `readLingerState(context, runner)`.

- [ ] **Step 1: Write failing systemd rendering and linger tests**

Assert that both units use absolute `WorkingDirectory`/`ExecStart`, `Restart=on-failure`, `RestartSec=10`, `NoNewPrivileges=true`, and `WantedBy=default.target`. Assert that paths containing spaces are escaped according to systemd executable argument syntax. Cover:

```js
assert.deepEqual(await readLingerState(context, runnerReturning('Linger=yes\n')), { enabled: true, raw: 'yes' })
assert.deepEqual(await readLingerState(context, runnerReturning('Linger=no\n')), { enabled: false, raw: 'no' })
```

Prove install calls `daemon-reload` and `enable --now` for both units, reload calls `restart`, uninstall calls `disable --now`, and only explicit `enableLinger: true` calls `loginctl enable-linger <username>`. Assert no call begins with `sudo`.

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `node --test fleet-runtime/systemd-service-manager.test.mjs`

Expected: FAIL because the systemd adapter is missing.

- [ ] **Step 3: Implement deterministic unit rendering and lifecycle operations**

Render units from service context instead of copying static files. Normalize `systemctl --user show <unit> --property=LoadState,UnitFileState,ActiveState,MainPID --value` into loaded/enabled/running/PID fields. Query linger with:

```js
await runner(['loginctl', 'show-user', context.username, '-p', 'Linger', '--value'])
```

When explicit linger enablement is requested, run `['loginctl', 'enable-linger', context.username]`, then query again. Return `next_steps: ['run loginctl enable-linger <username> with suitable host privileges, then rerun status']` when lingering is disabled. Never treat enabled services with inactive processes as running.

- [ ] **Step 4: Run adapter and legacy-unit migration tests**

Run: `node --test fleet-runtime/systemd-service-manager.test.mjs && rg -n '/usr/bin/env node|%h/.fleet' fleet-runtime --glob '*.service'`

Expected: tests PASS and the `rg` command returns no matches because static unit files have been removed.

- [ ] **Step 5: Commit the systemd adapter**

```bash
git add fleet-runtime/systemd-service-manager.mjs fleet-runtime/systemd-service-manager.test.mjs fleet-runtime/fleet-daemon.service fleet-runtime/fleet-control-daemon.service
git commit -m "feat(runtime): add systemd service adapter"
```

---

### Task 4: Add the Unified Lifecycle CLI and Installer Integration

**Files:**
- Create: `fleet-runtime/service-manager.mjs`
- Create: `fleet-runtime/service-manager.test.mjs`
- Modify: `fleet-runtime/install.mjs`
- Modify: `fleet-runtime/install.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: service context plus launchd/systemd adapters.
- Produces: `parseServiceArgs(argv)`, `buildServiceReceipt(opts, deps)`, CLI commands `install|reload|status|uninstall`, enhanced `install.buildReceipt(opts, deps)`, and `mupot-fleet-service-receipt/v1`.

- [ ] **Step 1: Write failing CLI and installer receipt tests**

Cover all new flags, incompatible combinations, explicit `none`, injected platform resolution, custom Node path, custom definition paths, dry run, activation, and old Linux defaults. Add these required assertions:

```js
assert.equal(receipt.receipt_type, 'mupot-fleet-service-receipt/v1')
assert.deepEqual(receipt.services.map((s) => s.key), ['heartbeat', 'control'])
assert.equal(receipt.status, 'pass')
assert.equal(receipt.preserved_data.configs, true)
assert.equal(receipt.preserved_data.private_keys, true)
assert.equal(installReceipt.inputs.service_manager.requested, 'auto')
assert.equal(installReceipt.inputs.service_manager.resolved, 'launchd')
assert.equal(installReceipt.outputs.logs_dir, join(prefix, 'logs'))
assert.equal(installReceipt.outputs.state_dir, join(prefix, 'state'))
assert.equal(mode(join(prefix, 'logs')), 0o700)
assert.equal(mode(join(prefix, 'state')), 0o700)
```

Assert `--activate` delegates to service install only after all rendering/writes pass, and a failed activation makes the install receipt fail with the nested service receipt and deterministic retry command.

- [ ] **Step 2: Run focused tests and confirm red failures**

Run: `node --test fleet-runtime/service-manager.test.mjs fleet-runtime/install.test.mjs`

Expected: FAIL on missing lifecycle CLI and unsupported installer flags.

- [ ] **Step 3: Implement service receipt orchestration**

`buildServiceReceipt` must return:

```js
{
  receipt_type: 'mupot-fleet-service-receipt/v1',
  generated_at: new Date().toISOString(),
  status: 'pass|fail',
  platform: process.platform,
  service_manager: 'launchd|systemd',
  action: 'install|reload|status|uninstall',
  definitions: [{ service, path, sha256 }],
  services: [{ key, name, loaded, enabled, running, pid }],
  linger: null | { enabled, raw },
  commands: [{ executable, argv, code, stdout_summary, stderr_summary }],
  preserved_data: { configs: true, private_keys: true, runtime: true, inbox: true, receipts: true },
  next_steps: [],
  checks: [],
}
```

Redact command summaries before returning them and reject output matching the repository secret patterns. A successful install/reload requires both services loaded and running. A successful uninstall requires both unloaded, definitions absent, and all configured data directories still present.

The CLI accepts one required positional action and common flags `--service-manager auto|systemd|launchd`, `--prefix <path>`, `--launchd-dir <path>`, `--systemd-dir <path>`, `--node <absolute-path>`, `--enable-linger`, and `--dry-run`. Reject a missing/extra action and manager-specific flag conflicts with exit code `2`.

- [ ] **Step 4: Extend the installer without changing preservation behavior**

Parse `--service-manager`, `--activate`, `--launchd-dir`, `--systemd-dir`, `--node`, and `--enable-linger`; create `logs` and `state`; render definitions through the selected adapter; preserve configs unless `--force-config`; emit hashes and exact next lifecycle command. Treat `none` as a warning with no definition directory. Replace static `SERVICE_FILES` copying with rendered definition writes.

- [ ] **Step 5: Add npm commands and run the focused suite**

Add:

```json
"fleet:service": "node fleet-runtime/service-manager.mjs"
```

Run: `node --test fleet-runtime/service-context.test.mjs fleet-runtime/launchd-service-manager.test.mjs fleet-runtime/systemd-service-manager.test.mjs fleet-runtime/service-manager.test.mjs fleet-runtime/install.test.mjs`

Expected: all tests PASS.

- [ ] **Step 6: Commit the unified installer slice**

```bash
git add fleet-runtime/service-manager.mjs fleet-runtime/service-manager.test.mjs fleet-runtime/install.mjs fleet-runtime/install.test.mjs package.json
git commit -m "feat(runtime): productize service installation"
```

---

### Task 5: Publish Atomic Redacted Daemon State

**Files:**
- Create: `fleet-runtime/runtime-state.mjs`
- Create: `fleet-runtime/runtime-state.test.mjs`
- Modify: `fleet-runtime/fleet-daemon.mjs`
- Modify: `fleet-runtime/fleet-daemon.test.mjs`
- Modify: `fleet-runtime/fleet-control-daemon.mjs`
- Modify: `fleet-runtime/fleet-control-daemon.test.mjs`

**Interfaces:**
- Produces: `writeRuntimeState(path, value, deps)`, `readRuntimeState(path)`, `heartbeatState(tick)`, and `controlState(poll)`.
- Daemon config gains optional `state_file`; defaults are `~/.fleet/state/fleet-daemon.json` and `~/.fleet/state/fleet-control.json`.

- [ ] **Step 1: Write failing atomicity, permission, and redaction tests**

Assert writes create a same-directory temporary file with mode `0600`, `fsync` it, rename it atomically, and leave no temporary file. Inject a rename failure and prove the previous valid state remains. Reject any object containing known secret fields or values.

For the heartbeat daemon, invoke two ticks and assert `tick` advances from 1 to 2 with this shape:

```js
{
  schema: 'mupot-fleet-daemon-state/v1',
  pid: 123,
  started_at: '2026-07-13T12:00:00.000Z',
  tick: 2,
  last_tick_at: '2026-07-13T12:01:15.000Z',
  interval_sec: 75,
  agents: [{ agent_id: 'agent-one', probe: 'alive', heartbeat_status: 200, inbox_count: 1, consume: 'consumed' }],
}
```

For control, assert `poll` advances and only `{ agent_id, verb, accepted, result }` is retained from the last outcome; signed request body, nonce, signature, and token fields must be absent.

- [ ] **Step 2: Run state and daemon tests to see failures**

Run: `node --test fleet-runtime/runtime-state.test.mjs fleet-runtime/fleet-daemon.test.mjs fleet-runtime/fleet-control-daemon.test.mjs`

Expected: FAIL because state writing and counters are not implemented.

- [ ] **Step 3: Implement the atomic writer and daemon integration**

Use `openSync(temp, 'wx', 0o600)`, `writeFileSync(fd, json)`, `fsyncSync(fd)`, `closeSync(fd)`, `renameSync(temp, target)`, and best-effort `unlinkSync(temp)` on failure. Ensure the parent state directory already exists; daemons log `state_write_failed` but preserve the actual tick/control result.

Move each daemon loop counter into `main`, pass `statePath`, `pid`, `startedAt`, and `now` through injected options for tests, and write state only after each completed tick/poll. Do not let a state-write exception change a successful heartbeat or control result into success or failure.

- [ ] **Step 4: Run focused tests and scan emitted fixtures**

Run: `node --test fleet-runtime/runtime-state.test.mjs fleet-runtime/fleet-daemon.test.mjs fleet-runtime/fleet-control-daemon.test.mjs && rg -n 'authorization|bearer|private_key|signature|nonce' fleet-runtime/*state*.test.mjs`

Expected: tests PASS; matches occur only in assertions that forbidden fields are absent/rejected.

- [ ] **Step 5: Commit daemon state publication**

```bash
git add fleet-runtime/runtime-state.mjs fleet-runtime/runtime-state.test.mjs fleet-runtime/fleet-daemon.mjs fleet-runtime/fleet-daemon.test.mjs fleet-runtime/fleet-control-daemon.mjs fleet-runtime/fleet-control-daemon.test.mjs
git commit -m "feat(runtime): publish atomic daemon state"
```

---

### Task 6: Build the Continuous-Runtime Receipt

**Files:**
- Create: `fleet-runtime/continuous-runtime-receipt.mjs`
- Create: `fleet-runtime/continuous-runtime-receipt.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `buildServiceReceipt({ action: 'status' })`, daemon state files, selected agent ID, pot TTL, grace, clock, and injected sleep/read functions.
- Produces: `parseArgs(argv)`, `observeAdvance(opts, deps)`, and `buildContinuousRuntimeReceipt(opts, deps)` returning `mupot-fleet-continuous-runtime-receipt/v1`.

- [ ] **Step 1: Write the failing receipt matrix**

Create deterministic fixtures for pass, timeout, stale heartbeat, stopped service, dead probe, non-2xx heartbeat, failed consume, no control advancement, disabled systemd linger, and `--require-control start` mismatch. The passing assertion must prove both counters advanced without relying on wall-clock sleep:

```js
assert.equal(receipt.receipt_type, 'mupot-fleet-continuous-runtime-receipt/v1')
assert.equal(receipt.status, 'pass')
assert.equal(receipt.observation.heartbeat.tick.before, 7)
assert.equal(receipt.observation.heartbeat.tick.after, 8)
assert.equal(receipt.observation.control.poll.before, 12)
assert.equal(receipt.observation.control.poll.after, 13)
assert.equal(receipt.agent.agent_id, 'hermes-manager')
assert.equal(receipt.agent.probe, 'alive')
assert.equal(receipt.agent.heartbeat_status, 200)
```

- [ ] **Step 2: Run the focused test and confirm the missing module**

Run: `node --test fleet-runtime/continuous-runtime-receipt.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement bounded condition polling**

Parse `--agent`, `--heartbeat-state`, `--control-state`, `--service-manager`, `--definition-dir`, `--ttl-sec`, `--grace-sec`, `--poll-ms`, and repeatable `--require-control`. Compute the deadline as `started + (heartbeat.interval_sec + grace_sec) * 1000`. Read baseline state, poll until both counters advance or the deadline expires, then re-read service status and validate:

```js
const checks = [
  { check: 'services_running', ok: serviceReceipt.status === 'pass' },
  { check: 'heartbeat_tick_advanced', ok: afterHeartbeat.tick > beforeHeartbeat.tick },
  { check: 'control_poll_advanced', ok: afterControl.poll > beforeControl.poll },
  { check: 'agent_probe_alive', ok: agent?.probe === 'alive' },
  { check: 'signed_heartbeat_2xx', ok: agent?.heartbeat_status >= 200 && agent?.heartbeat_status < 300 },
  { check: 'heartbeat_fresh_under_ttl', ok: nowMs - Date.parse(afterHeartbeat.last_tick_at) <= ttlSec * 1000 },
  { check: 'inbox_consume_not_failed', ok: !['failed', 'consume_failed', 'handler_failed'].includes(agent?.consume) },
]
```

When systemd linger is disabled, fail with reason `linger_disabled` and the exact next command. Required control checks pass only when the latest accepted result belongs to the selected agent and its verb is in the requested set.

- [ ] **Step 4: Run receipt tests**

Run: `node --test fleet-runtime/continuous-runtime-receipt.test.mjs`

Expected: all matrix cases PASS and complete in under one second using injected clocks.

- [ ] **Step 5: Register and verify the receipt command**

Add `"receipt:continuous-runtime": "node fleet-runtime/continuous-runtime-receipt.mjs"` to `package.json`, then run `npm run receipt:continuous-runtime -- --help`.

Expected: usage text exits successfully and lists every supported option.

- [ ] **Step 6: Commit continuous evidence**

```bash
git add fleet-runtime/continuous-runtime-receipt.mjs fleet-runtime/continuous-runtime-receipt.test.mjs package.json
git commit -m "feat(runtime): add continuous runtime receipt"
```

---

### Task 7: Make Host-Go and Receipt Bundles Service-Aware

**Files:**
- Modify: `fleet-runtime/host-receipt.mjs`
- Modify: `fleet-runtime/host-receipt.test.mjs`
- Modify: `fleet-runtime/receipt-bundle.mjs`
- Modify: `fleet-runtime/receipt-bundle.test.mjs`

**Interfaces:**
- Host CLI gains `--require-services`, `--service-manager auto|systemd|launchd`, and `--service-definition-dir <path>`.
- Receipt bundle gains `--service-receipt`, `--continuous-receipt`, and `--starter-receipt`; its manifest recognizes all three exact receipt types.

- [ ] **Step 1: Write failing backward-compatibility and service-required tests**

Keep the existing host fixture passing without `requireServices`. Add injected service-status fixtures proving required mode fails for missing definition, hash mismatch, unloaded service, stopped service, wrong runtime/config path, and disabled lingering. Prove a correct service receipt makes host status pass.

Extend receipt bundle tests so export succeeds only when service, continuous, and starter receipts are present, passing, hash-matched, and secret-free. Add copied-directory verification to prove absolute source paths are not required after export.

- [ ] **Step 2: Run focused tests and confirm failures**

Run: `node --test fleet-runtime/host-receipt.test.mjs fleet-runtime/receipt-bundle.test.mjs`

Expected: new tests FAIL while all old compatibility cases still PASS.

- [ ] **Step 3: Add optional service checks to Host-Go**

When `requireServices` is true, call injected `buildServiceReceipt` with `action: 'status'`; compare rendered definition hashes and parsed execution arguments against the currently selected `node`, runtime directory, daemon config, and control config. Add normalized checks named `service_definitions_current`, `heartbeat_service_running`, `control_service_running`, and `systemd_linger_enabled`. Include service manager and definition directory in `inputs` without changing existing fields.

- [ ] **Step 4: Extend receipt-bundle policy and status output**

Add:

```js
service: 'mupot-fleet-service-receipt/v1',
continuous: 'mupot-fleet-continuous-runtime-receipt/v1',
starter: 'mupot-fleet-starter-receipt/v1',
```

Require all three for the new starter-ready gate while preserving the existing SOS cutover mode when none of their flags are supplied. Include service manager, definition hashes, observed tick/poll deltas, and starter manifest digest in compact status output. Reuse the existing secret scanner rather than introducing a second pattern list.

- [ ] **Step 5: Run focused and complete runtime tests**

Run: `node --test fleet-runtime/*.test.mjs`

Expected: all fleet-runtime tests PASS.

- [ ] **Step 6: Commit service-aware Host-Go**

```bash
git add fleet-runtime/host-receipt.mjs fleet-runtime/host-receipt.test.mjs fleet-runtime/receipt-bundle.mjs fleet-runtime/receipt-bundle.test.mjs
git commit -m "feat(runtime): require service continuity in host evidence"
```

---

### Task 8: Package the Forkable Two-Agent Starter

**Files:**
- Create: `fleet-runtime/starter-manifest.mjs`
- Create: `fleet-runtime/starter-manifest.test.mjs`
- Create: `fleet-runtime/starter.example.json`
- Modify: `package.json`

**Interfaces:**
- Produces: `validateStarterManifest(raw)`, `renderStarterPlan(manifest, opts)`, `verifyStarterBundle(opts)`, and `mupot-fleet-starter-receipt/v1`.

- [ ] **Step 1: Write failing schema, topology, and secret tests**

Use this complete sterile fixture:

```js
const manifest = {
  version: 1,
  tenant: 'customer-pot',
  base_url: 'https://pot.customer.example',
  service_manager: 'auto',
  agents: [
    { agent_id: 'manager', runtime: 'hermes', probe: 'pgrep -f hermes', handler: 'node ~/.fleet/handlers/hermes.mjs' },
    { agent_id: 'builder', runtime: 'codex', probe: 'pgrep -f codex', handler: 'node ~/.fleet/handlers/codex.mjs' },
  ],
  control_consumer_agent_id: 'manager',
}
```

Prove the same manifest validates for co-resident planning and for distributed host filtering (`--agent manager` on Mac, `--agent builder` on VPS). Reject duplicate agent IDs, unsupported runtimes/managers, missing control consumer, real token/private-key fields, private JWK material, bearer values, and Mumega production identity data in exported customer fixtures.

- [ ] **Step 2: Run the starter test and confirm it fails**

Run: `node --test fleet-runtime/starter-manifest.test.mjs`

Expected: FAIL because starter tooling is missing.

- [ ] **Step 3: Implement validation and a credential-free command plan**

The plan must use environment references such as `${MUPOT_AGENT_TOKEN_MANAGER}` only in human instructions and never write those values. Generate commands for layout install, config editing, public-key registration, service activation, Host-Go, continuous proof, bundle export, copied-manifest check, uninstall, and reinstall. Each host-specific plan includes only its selected agents while retaining the shared tenant and control-consumer contract.

`verifyStarterBundle` requires passing install, service, host, continuous, runtime inbox, lifecycle control, and receipt-bundle manifest evidence. Return artifact paths relative to the copied bundle and SHA-256 digests so the bundle remains independently verifiable after transfer.

- [ ] **Step 4: Run starter and secret tests**

Run: `node --test fleet-runtime/starter-manifest.test.mjs fleet-runtime/receipt-bundle.test.mjs && npm test -- tests/no-secrets.test.ts`

Expected: all tests PASS and no secret finding is reported.

- [ ] **Step 5: Register and verify the starter command**

Add `"fleet:starter": "node fleet-runtime/starter-manifest.mjs"` to `package.json`, then run `npm run fleet:starter -- --help`.

Expected: usage text exits successfully and describes validate, plan, and verify modes.

- [ ] **Step 6: Commit the starter package**

```bash
git add fleet-runtime/starter-manifest.mjs fleet-runtime/starter-manifest.test.mjs fleet-runtime/starter.example.json package.json
git commit -m "feat(runtime): package forkable two-agent starter"
```

---

### Task 9: Document Operator Workflows and Complete Automated Verification

**Files:**
- Modify: `fleet-runtime/README.md`
- Create: `docs/runtime-starter.md`
- Modify: `docs/GO-LIVE.md`
- Create: `tests/runtime-starter-docs.test.ts`

**Interfaces:**
- Documents the exact lifecycle and receipt commands implemented in Tasks 1-8; introduces no alternative command path.

- [ ] **Step 1: Write documentation assertions before editing prose**

Create `tests/runtime-starter-docs.test.ts` to assert the docs include `--activate`, all four lifecycle verbs, `--require-services`, continuous receipt, explicit linger enablement, data-preserving uninstall, co-resident/distributed topology, and copied-bundle verification. Assert the docs do not instruct operators to store raw bearer tokens in files or plist/unit environment variables:

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const docs = [
  'fleet-runtime/README.md',
  'docs/runtime-starter.md',
  'docs/GO-LIVE.md',
].map((path) => readFileSync(path, 'utf8')).join('\n')

describe('runtime starter documentation', () => {
  it.each(['--activate', 'service-manager.mjs install', 'service-manager.mjs reload', 'service-manager.mjs status', 'service-manager.mjs uninstall', '--require-services', 'continuous-runtime-receipt.mjs', 'loginctl enable-linger', 'copied bundle'])('documents %s', (term) => {
    expect(docs).toContain(term)
  })

  it('states topology and preservation rules without credential persistence', () => {
    expect(docs).toMatch(/co-resident/i)
    expect(docs).toMatch(/distributed/i)
    expect(docs).toMatch(/preserv(?:e|es).*configs.*keys.*receipts/is)
    expect(docs).not.toMatch(/EnvironmentVariables[\s\S]{0,200}(?:TOKEN|SECRET|PRIVATE_KEY)/)
  })
})
```

- [ ] **Step 2: Run the docs test and confirm missing-command failures**

Run: `npm test -- tests/runtime-starter-docs.test.ts`

Expected: FAIL because the new runbook does not exist.

- [ ] **Step 3: Write the macOS, Linux, rollback, and starter runbooks**

Document exact command sequences using `$HOME`, `command -v node`, and receipt files under `$HOME/.fleet/receipts`. For Linux, separate the unprivileged installer from the operator-authorized `loginctl enable-linger "$USER"` action. For uninstall, explicitly list every preserved directory. For recovery, reinstall definitions, activate, and require new state advancement.

- [ ] **Step 4: Run all local gates**

```bash
npm run typecheck
npm test
node --test fleet-runtime/*.test.mjs
npm audit --audit-level=high
npx wrangler deploy --dry-run --config wrangler.example.toml
git diff --check
```

Expected: zero failures, zero high-severity audit findings, successful dry-run deployment, and clean diff checks.

- [ ] **Step 5: Commit documentation and request independent code review**

```bash
git add fleet-runtime/README.md docs/runtime-starter.md docs/GO-LIVE.md tests/runtime-starter-docs.test.ts
git commit -m "docs(runtime): add cross-platform starter runbook"
```

Invoke `superpowers:requesting-code-review` against the exact branch head. Resolve every blocker with a failing regression test and a focused commit before proceeding to a real host.

---

### Task 10: Open and Prove the Cross-Platform Installer PR

**Files:**
- No new product files unless review or CI exposes a tested defect.
- Durable records: GitHub issue `Mumega-com/mupot#352` and one implementation PR.

- [ ] **Step 1: Push the branch and open a draft PR**

Use the `github:yeet` workflow. The PR body must link #352, the approved design, this plan, each commit, automated test counts, no-secret result, rollback behavior, and the pending Mac/VPS evidence gates.

- [ ] **Step 2: Obtain exact-SHA CI and independent review**

Require all repository checks on the PR head SHA. Kasra or another independent reviewer must review the same SHA. Any implementation change invalidates the prior review and requires fresh CI/review.

- [ ] **Step 3: Merge only the code slice**

Merge after CI and independent review pass. Record the merged SHA in #352. Do not close #352 until the macOS install/reload/uninstall/recovery receipts are attached and pass.

---

### Task 11: Prove macOS Install, Lifecycle, and Recovery

**Files:**
- Generated outside Git: `$HOME/.fleet/receipts/flight-352-macos/*`
- Durable record: issue #352 comment with redacted receipt bundle digest and proof URL.

**Interfaces:**
- Uses the merged installer SHA and existing canonical Hermes identity. Does not mint a replacement identity or copy its private key.

- [ ] **Step 1: Capture the current service/config baseline**

Save redacted status, definition hashes, runtime SHA, and directory-presence checks. Do not print plist contents if a future local edit introduced a secret; run the secret scanner first.

- [ ] **Step 2: Install definitions without activation**

```bash
mkdir -p "$HOME/.fleet/receipts/flight-352-macos"
node fleet-runtime/install.mjs --service-manager launchd --node "$(command -v node)" > "$HOME/.fleet/receipts/flight-352-macos/install-no-activate.json"
node fleet-runtime/service-manager.mjs status --service-manager launchd > "$HOME/.fleet/receipts/flight-352-macos/status-before-activate.json"
```

Expected: install receipt has no service mutation; status proves definitions exist and activation is still required.

- [ ] **Step 3: Activate and prove continuous state**

```bash
node "$HOME/.fleet/runtime/service-manager.mjs" install --service-manager launchd > "$HOME/.fleet/receipts/flight-352-macos/service-install.json"
node "$HOME/.fleet/runtime/host-receipt.mjs" --exec-probes --require-services --service-manager launchd > "$HOME/.fleet/receipts/flight-352-macos/host.json"
node "$HOME/.fleet/runtime/continuous-runtime-receipt.mjs" --agent d288d8c0-e84d-4a40-a843-8cf10a07fe87 --service-manager launchd > "$HOME/.fleet/receipts/flight-352-macos/continuous.json"
```

Expected: both services loaded/running and heartbeat/control counters advance within one bounded observation.

- [ ] **Step 4: Prove inbox, signed control, reload, uninstall, and recovery**

Queue one signed retained task and one signed `start` control through Mupot. Capture task/result IDs without message bodies. Run reload and a second continuous receipt requiring `start`. Run uninstall and assert every data directory remains. Reinstall, rerun continuity, and confirm Hermes returns current.

- [ ] **Step 5: Export and attach the redacted Mac evidence**

Run the receipt-bundle exporter and copied-manifest check. Attach only the copied passing bundle or its approved durable artifact URL to #352. Include SHA-256 digests and the merged runtime SHA. Close #352 only when this evidence passes.

---

### Task 12: Bring VPS Codex Online and Prove Linux Continuity

**Files:**
- Generated outside Git on VPS: `$HOME/.fleet/receipts/mumega-vps-codex/*`
- Durable record: the Mumega flight task and GitHub epic #249.

**Interfaces:**
- Uses the existing activated VPS Codex session and a canonical Mupot identity with least-privilege agent-bound credentials.

- [ ] **Step 1: Dispatch Linux installation through a Mupot task**

Create a governed flight/task assigning VPS Codex the merged installer SHA, Linux runbook, acceptance checks, and evidence destination. Delivery and acknowledgement must occur through the signed Mupot inbox, not SOS.

- [ ] **Step 2: Install systemd user services and explicitly establish lingering**

VPS Codex runs install without activation, validates generated units, then activates with systemd. If status reports `linger_disabled`, Hadi authorizes the host-level `loginctl enable-linger "$USER"` action; the installer itself must not invoke `sudo`.

- [ ] **Step 3: Cross a logout boundary and prove continuity**

Disconnect the interactive SSH/tmux client while leaving the user manager running, reconnect, then collect service, Host-Go, and continuous-runtime receipts. Required result: both systemd services remain active, linger is enabled, and heartbeat/control counters advanced across the boundary.

- [ ] **Step 4: Execute a real VPS Codex task and lifecycle recovery**

Deliver a bounded implementation/research task through Mupot; require a retained result artifact. Reload both services and collect a second continuous receipt. No task request, ACK, result, or gate decision may use SOS transport.

- [ ] **Step 5: Export, verify, and retain the Linux evidence**

VPS Codex exports a copied bundle, verifies it in the copied directory, and attaches the redacted digest/URL to its Mupot task and epic #249. Verify no private key, token, customer message, shell history, or VPS address credential is included.

---

### Task 13: Run the Governed Dyad Starter Flight and Browser Acceptance

**Files:**
- Generated evidence: one sterile starter manifest and Mac/VPS host bundles.
- Durable Mupot records: goal, flight, two tasks, task results, gate proposal, accountable-owner verdict, audit events, and landed flight.

**Interfaces:**
- Hermes is manager/reviewer on Mac; VPS Codex is implementer on Linux; Mupot is the sole workflow ledger and transport.

- [ ] **Step 1: Create the real customer-starter flight**

Set the flight objective to: `Produce and verify a forkable two-agent customer runtime starter from the proven macOS and Linux installations.` Create one VPS implementation task and one Hermes Mac-verification/starter-review task, each with done-when evidence requirements and least-privilege assignment.

- [ ] **Step 2: Complete both tasks through signed Mupot inboxes**

Require each agent to acknowledge through its inbox, execute locally, and return a retained redacted result. Verify both agents are simultaneously current while the tasks execute. Do not manually mark tasks complete from the dashboard unless a signed runtime result already exists.

- [ ] **Step 3: Evaluate the starter gate**

Gate inputs are the merged installer SHA, Mac service/host/continuous bundle, VPS service/host/continuous bundle, sterile starter manifest, copied-bundle verification, task result IDs, and no-secret results. The accountable owner records `pass` only when every input resolves and reports pass.

- [ ] **Step 4: Verify production in the authenticated browser**

Use the in-app browser on `https://mupot.mumega.com/`. Confirm two current runtimes, no new recent failures, both completed retained tasks, gate proposal/verdict, linked evidence, and audit events. Capture screenshots or durable browser evidence supported by the product without exposing message bodies or credentials.

- [ ] **Step 5: Land the flight and run final independent review**

Land only after both tasks and the gate are complete. Ask Kasra to review the exact merged SHA and durable flight evidence. Record no-blocker decision or reopen the precise failed task/gate. Remove SOS wiring only for an agent whose own cutover evidence passes.

- [ ] **Step 6: Verify all phase acceptance criteria**

Confirm directly: #352 merged and evidenced; Mac install/reload/uninstall/recovery pass; Linux install/reload/linger pass; continuous receipts pass for both agents; both agents are current together; real dyad flight completes without SOS; copied starter passes; production browser evidence exists; independent review has no blocker. Keep the broader goal active if any item lacks evidence.
