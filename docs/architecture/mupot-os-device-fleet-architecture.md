# Mupot OS & Device Fleet Architecture

**Canonical Specification:** `MU.200.001-DEVICE-OS`  
**Status:** Canonical Architecture Specification  
**Governing Standard:** `MU.100.001` (Multi-Sig Gated)  
**Parent Document:** [mupot version roadmap](../../ROADMAP.md) · [operating context](../pot-operating-context.md)

---

## 1. Executive Summary: The Cloud Brain & Physical Muscle

Mupot is architected as a two-tier sovereign system:
1. **The Sovereign Control Plane (Mupot Core / Cloud):** Edge-native microkernel running serverless on Cloudflare (`workerd`, D1, Vectorize, Queues, Durable Objects, Workflows). It acts as the immutable governance, memory ledger, routing mesh, and verification authority.
2. **The Physical Execution Nodes (Mupot OS & Devices):** Hardware appliances, Linux workstations, Apple Silicon Mac Minis, Raspberry Pis, and edge IoT devices running the lightweight **Mupot OS runtime**. Mupot OS acts as the local muscle—executing local code, hosting hardware-accelerated local models (MLX, llama.cpp), accessing local peripherals/filesystems, and communicating with the sovereign pot via cryptographic attestation.

```
                           ┌─────────────────────────────────────────┐
                           │      SOVEREIGN CONTROL PLANE (CLOUD)     │
                           │   Cloudflare Workers · D1 · Vectorize   │
                           │   (Governance, Memory, Router, Ledger)   │
                           └────────────────────┬────────────────────┘
                                                │ Exact-Seat A2A Mesh
                                                │ (Signed Fenced Delivery)
                                                ▼
     ┌─────────────────────────────────────────────────────────────────────────────────────┐
     │                             MUPOT OS DEVICE FLEET                                   │
     │                                                                                     │
     │  ┌───────────────────────┐  ┌───────────────────────┐  ┌─────────────────────────┐  │
     │  │  Mac Studio / Mini    │  │   Linux Edge Server   │  │   Embedded / Pi Device  │  │
     │  │  (Apple MLX / Worktree)│ │   (Docker / Buildbox) │  │   (Sensor / IoT Hub)    │  │
     │  │  Seat: mac-studio-01  │  │   Seat: hetzner-srv-01│  │   Seat: factory-pi-04   │  │
     │  └───────────────────────┘  └───────────────────────┘  └─────────────────────────┘  │
     └─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Core Invariants of Mupot OS

1. **Hardware-Anchored Cryptographic Identity:** Every Mupot OS device possesses an Ed25519 identity keypair generated in hardware (Secure Enclave / TPM / hardware keystore) during factory provisioning. The private key never leaves the physical device.
2. **Fail-Closed Zero Trust:** The sovereign pot never trusts a device by network address (IP) or claim. All device actions require attested bearer signatures, session epochs, and lease nonces.
3. **Local Sandboxing:** Tasks executed by Mupot OS run inside isolated execution namespaces (macOS `sandbox-exec`, Linux `systemd-nspawn` / Docker) with restricted filesystem and network egress.
4. **Offline-First Resilient Journaling:** Mupot OS maintains an append-only, fsynced local SQLite journal. If network connectivity to the cloud pot drops, tasks continue execution locally, buffering signed execution receipts until re-connection.
5. **Scale-to-Zero Hardware Power Management:** Devices can idle at micro-power levels ($0 idle compute), waking on LAN (WoL) or cloud push signals when high-priority tasks are dispatched.

---

## 3. The 7-Axis Device Presence Specification

When a Mupot OS device connects to its sovereign pot, it publishes its 7-axis hardware identity via the `check_in` protocol:

```typescript
export interface MupotDevicePresence {
  seat: string              // e.g. "mupot-os-mac-mini-01"
  harness: "mupot-os"       // Dedicated device harness identifier
  machine: string           // e.g. "hadi-mac-studio", "rpi5-garage", "hetzner-ash-1"
  model: string             // e.g. "mlx-deepseek-r1-q4", "local-ollama-llama3.3", "cloud-hybrid"
  provider: string          // "apple-mlx" | "ollama" | "anthropic" | "local-hardware"
  effort: "low" | "medium" | "high" | "extended-thinking-64k"
  continuum_name: string    // "kasra" | "river" | "athena" | "hermes"
  folder?: string           // Local working directory path
  thread?: string           // Active hardware execution lane
  session_epoch: number     // Monotonic boot epoch (guards against stale session replays)
  lease_ttl_sec: number     // Heartbeat lease validity (default 180s)
  device_metadata?: {
    arch: "arm64" | "x86_64"
    os: "darwin" | "linux"
    memory_total_bytes: number
    hardware_acceleration: "apple-metal" | "cuda" | "rocm" | "none"
    battery_level?: number
    is_charging?: boolean
  }
}
```

---

## 4. Device Lifecycle & Pairing Protocol

### Phase 1: Device Boot & Pairing Handshake
1. **Fresh Device Boot:** Mupot OS boots on physical hardware and displays a cryptographic **Pairing QR Code** and terminal connection string on local display/CLI.
2. **Operator Claim:** An authenticated operator opens the Mupot Dashboard (`/admin/devices` or `/setup`) or calls the MCP tool `device_pair_claim`.
3. **Challenge-Response:**
   - The Pot issues an `enrollment_nonce`.
   - The Device signs `(tenant + device_id + enrollment_nonce)` with its hardware key.
   - The Pot records the device public key in D1 `device_keys` and mints an initial `device_token`.

### Phase 2: Active Dispatch & Execution
1. **Task Matching:** The Edge Router (`src/router/engine.ts`) discovers an unassigned task requiring local hardware capability (e.g. `needs: [local-build, metal-gpu, audio-io]`).
2. **Exact-Seat Wake:** The Pot issues an `agent.wake` event directed to `seat: "mupot-os-<device>"`.
3. **Execution & Evidence:** Mupot OS claims the task, executes it inside the local sandbox, compiles build artifacts or runs local inference, computes SHA-256 artifact checksums, and submits `task_report_result`.

### Phase 3: Sleep, Disconnect & Heartbeat Recovery
- If no tasks are queued, Mupot OS releases active leases and enters low-power stand-by.
- If a device goes offline unexpectedly, its presence lease expires (`classify()` marks it `dead` or `undispatchable`), and uncompleted tasks fail over cleanly to in-Worker fallbacks without hanging the board.

---

## 5. Local Peripheral & Sensor Governance

Mupot OS includes governed hardware I/O ports guarded by explicit permission gates:

| Peripheral Port | Capability Name | Governance Gate | Description |
|---|---|---|---|
| **Local ML Engine** | `hardware:local-inference` | None (Local Free) | Runs local quantized models via Apple MLX or llama.cpp with $0 token cost. |
| **Local Git Worktree** | `hardware:fs-write` | Squad Member | Isolated scratch folder for compiling code, running tests, and opening PRs. |
| **Audio / Voice I/O** | `hardware:audio-stream` | Owner 2FA Gate | Stream live operator voice commands via local microphone/speaker. |
| **Camera / Vision** | `hardware:vision-capture`| Explicit Action Gate | Capture frames for OCR, physical lab monitoring, or visual verification. |
| **Serial / GPIO** | `hardware:gpio-control` | Owner 2FA Gate | Robotics, relay switches, and physical hardware control. |

---

## 6. Mupot OS Flight Roadmap Integration

Mupot OS capabilities are delivered through **Journey 2: Mupot OS & Physical Hardware Fleet** across 5 sequential flights:
* **FLIGHT DEV-01:** Hardware Attestation & Device Pairing Protocol (`device_keys` D1 schema & QR handshake).
* **FLIGHT DEV-02:** Local Sandboxed Execution Engine (Apple MLX / Linux container worker).
* **FLIGHT DEV-03:** Peripheral & Sensor Governance (Audio, camera, and GPIO capability gates).
* **FLIGHT DEV-04:** Offline-First Journaling & Edge Cache Reconciliation.
* **FLIGHT DEV-05:** Hardware Power & Wake-on-Demand Mesh.
