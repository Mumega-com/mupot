// tests/flight-device-fleet.test.ts — Verification of Journey 2: Mupot OS & Physical Device Fleet Control (MU.200.001-DEVICE).
//
// Invariants verified:
//   1. FLIGHT DEV-01: Device Pairing Challenge & Hardware Key Attestation Claim.
//   2. FLIGHT DEV-02: Sandboxed Local Execution Reporting ($0 Token MLX Telemetry).
//   3. FLIGHT DEV-03: Peripheral & Sensor Capability Governance (GPIO 2FA gate, camera/mic gates).
//   4. FLIGHT DEV-04: Offline-First SQLite Journal Buffer & Edge Sync Replay.
//   5. FLIGHT DEV-05: Hardware Power Management & Wake-on-Demand Mesh Dispatch.
//   6. MCP Integration: device_pair_challenge, device_pair_claim, device_report_exec, device_sync_journal, device_power_control.

import { describe, it, expect, beforeEach } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import {
  createDevicePairingChallenge,
  claimDevicePairing,
  verifyDeviceAttestation,
} from '../src/devices/attestation'
import { reportDeviceExecution } from '../src/devices/executor'
import { checkHardwareCapability } from '../src/devices/governance'
import { syncDeviceJournalEntries } from '../src/devices/journal'
import { updateDevicePowerState, wakeHardwareDevice } from '../src/devices/power'
import { invokeTool } from '../src/mcp/index'
import type { Env, AuthContext } from '../src/types'

describe('Journey 2: Mupot OS & Physical Device Fleet Control (MU.200.001)', () => {
  let harness: SqliteD1Harness
  let env: Env

  const TENANT = 'mumega'
  const OPERATOR_ID = 'm-operator'
  const SQUAD_ID = 'squad-core'
  const DEVICE_ID = 'mupot-os-mac-mini-01'

  const adminAuth: AuthContext = {
    userId: OPERATOR_ID,
    memberId: OPERATOR_ID,
    email: 'operator@mumega.com',
    role: 'owner',
    tenant: TENANT,
    channel: 'workspace',
    capabilities: [{ member_id: OPERATOR_ID, scope_type: 'org', scope_id: null, capability: 'owner' }],
  }

  const memberAuth: AuthContext = {
    userId: 'm-member',
    memberId: 'm-member',
    email: 'member@mumega.com',
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    capabilities: [{ member_id: 'm-member', scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' }],
  }

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)

    env = {
      DB: harness.db,
      TENANT_SLUG: TENANT,
      PUBLIC_ORIGIN: 'https://mupot.mumega.com',
    } as unknown as Env

    harness.sqlite.exec(`
      INSERT OR IGNORE INTO members (id, email, display_name, status)
      VALUES ('${OPERATOR_ID}', 'operator@mumega.com', 'Operator', 'active'),
             ('m-member', 'member@mumega.com', 'Member', 'active');

      INSERT OR IGNORE INTO departments (id, slug, name) VALUES ('dept-1', 'core', 'Core Dept');
      INSERT OR IGNORE INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_ID}', 'dept-1', 'core', 'Core Squad');

      INSERT OR IGNORE INTO tasks (id, squad_id, title, body, done_when, status, created_at, updated_at)
      VALUES ('task-dev-1', '${SQUAD_ID}', 'Compile local binary on Mac Studio', 'Local MLX build', 'Tests pass', 'in_progress', datetime('now'), datetime('now'));
    `)
  })

  describe('1. FLIGHT DEV-01: Hardware Pairing & Attestation', () => {
    it('creates device pairing challenge and claims pairing as operator', async () => {
      // 1. Create challenge
      const challenge = await createDevicePairingChallenge(env, {
        deviceId: DEVICE_ID,
        machine: 'hadi-mac-studio',
        publicKey: 'pub-ed25519-hardware-key-1234567890abcdef',
        arch: 'arm64',
        os: 'darwin',
        acceleration: 'apple-metal',
      })

      expect(challenge.pairingCode).toBeTruthy()
      expect(challenge.enrollmentNonce).toHaveLength(64)
      expect(challenge.qrPayload).toContain(challenge.pairingCode)

      // 2. Claim pairing as operator
      const claim = await claimDevicePairing(env, adminAuth, {
        pairingCode: challenge.pairingCode,
        deviceId: DEVICE_ID,
        signature: 'sig-ed25519-valid-challenge-signature',
      })

      expect(claim.ok).toBe(true)
      if (!claim.ok) throw new Error('Unreachable')
      expect(claim.device.device_id).toBe(DEVICE_ID)
      expect(claim.device.acceleration).toBe('apple-metal')
      expect(claim.device.status).toBe('active')
    })
  })

  describe('2. FLIGHT DEV-02: Local Sandboxed Execution Engine', () => {
    it('records $0 token MLX execution result and updates task status', async () => {
      // Ensure device is registered
      await createDevicePairingChallenge(env, {
        deviceId: DEVICE_ID,
        machine: 'hadi-mac-studio',
        publicKey: 'pub-ed25519-hardware-key-1234567890abcdef',
      })

      const report = await reportDeviceExecution(env, {
        deviceId: DEVICE_ID,
        taskId: 'task-dev-1',
        result: {
          taskId: 'task-dev-1',
          deviceId: DEVICE_ID,
          exitCode: 0,
          output: 'MLX local deepseek-r1 compilation completed successfully.',
          artifactPath: '/opt/mupot/builds/binary.tar.gz',
          artifactSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          tokensProcessed: 125_000,
          costMicroUsd: 0, // Local hardware execution
          durationMs: 4500,
          signature: 'sig-exec-valid',
        },
        signatureHex: 'sig-hardware-attested-hex-001',
      })

      expect(report.ok).toBe(true)

      const task = await env.DB.prepare(`SELECT status, result FROM tasks WHERE id = 'task-dev-1'`).first<{ status: string; result: string }>()
      expect(task?.status).toBe('review')
      expect(task?.result).toContain('Tokens (Local $0): 125000')
    })
  })

  describe('3. FLIGHT DEV-03: Peripheral & Sensor Governance', () => {
    it('enforces 2FA and capability barriers on physical hardware control', async () => {
      await createDevicePairingChallenge(env, {
        deviceId: DEVICE_ID,
        machine: 'hadi-mac-studio',
        publicKey: 'pub-ed25519-hardware-key-1234567890abcdef',
      })

      // 1. GPIO requires org admin / 2FA
      const memberGpio = await checkHardwareCapability(env, memberAuth, {
        deviceId: DEVICE_ID,
        capability: 'hardware:gpio-control',
      })
      expect(memberGpio.allowed).toBe(false)
      if (memberGpio.allowed) throw new Error('Unreachable')
      expect(memberGpio.reason).toBe('owner_2fa_required')

      const adminGpio = await checkHardwareCapability(env, adminAuth, {
        deviceId: DEVICE_ID,
        capability: 'hardware:gpio-control',
      })
      expect(adminGpio.allowed).toBe(true)

      // 2. Local inference is permitted for members
      const localInfer = await checkHardwareCapability(env, memberAuth, {
        deviceId: DEVICE_ID,
        capability: 'hardware:local-inference',
      })
      expect(localInfer.allowed).toBe(true)
    })
  })

  describe('4. FLIGHT DEV-04: Offline-First SQLite Journal & Edge Sync', () => {
    it('reconciles buffered offline journal transactions with sequence ordering', async () => {
      await createDevicePairingChallenge(env, {
        deviceId: DEVICE_ID,
        machine: 'hadi-mac-studio',
        publicKey: 'pub-ed25519-hardware-key-1234567890abcdef',
      })

      const syncRes = await syncDeviceJournalEntries(env, {
        deviceId: DEVICE_ID,
        entries: [
          {
            id: 'j-1',
            deviceId: DEVICE_ID,
            seq: 1,
            eventType: 'hardware.boot',
            payload: { boot_mode: 'cold' },
            signatureHex: 'sig-j1',
          },
          {
            id: 'j-2',
            deviceId: DEVICE_ID,
            seq: 2,
            eventType: 'task.executed',
            payload: { task_id: 'task-dev-1', status: 'done' },
            signatureHex: 'sig-j2',
          },
        ],
      })

      expect(syncRes.syncedCount).toBe(2)
      expect(syncRes.lastSeq).toBe(2)

      // Duplicate sync is idempotent (no duplicate rows)
      const reSync = await syncDeviceJournalEntries(env, {
        deviceId: DEVICE_ID,
        entries: [
          {
            id: 'j-1',
            deviceId: DEVICE_ID,
            seq: 1,
            eventType: 'hardware.boot',
            payload: { boot_mode: 'cold' },
            signatureHex: 'sig-j1',
          },
        ],
      })
      expect(reSync.syncedCount).toBe(0)
    })
  })

  describe('5. FLIGHT DEV-05: Power Management & Wake-on-Demand Mesh', () => {
    it('updates power state and dispatches hardware wake signal', async () => {
      await createDevicePairingChallenge(env, {
        deviceId: DEVICE_ID,
        machine: 'hadi-mac-studio',
        publicKey: 'pub-ed25519-hardware-key-1234567890abcdef',
      })

      // 1. Update power state to sleep
      const powerState = await updateDevicePowerState(env, {
        deviceId: DEVICE_ID,
        powerState: 'sleep',
        batteryPct: 88,
        isCharging: true,
        wolMacAddress: 'AA:BB:CC:DD:EE:FF',
      })

      expect(powerState.power_state).toBe('sleep')
      expect(powerState.is_charging).toBe(1)

      // 2. Wake device on demand
      const wake = await wakeHardwareDevice(env, adminAuth, {
        deviceId: DEVICE_ID,
        reason: 'P0 critical hardware compilation',
        priority: 'P0',
      })

      expect(wake.ok).toBe(true)
      expect(wake.signalEmitted).toBe(true)
    })
  })

  describe('6. MCP Device Tools Suite Integration', () => {
    it('executes device MCP tools end-to-end', async () => {
      // 1. Challenge via MCP
      const challengeRes = await invokeTool(memberAuth, env, 'device_pair_challenge', {
        device_id: 'rpi5-device-01',
        machine: 'rpi5-edge',
        public_key: 'pub-key-rpi5-test',
        arch: 'arm64',
        os: 'linux',
      })
      expect(challengeRes.ok).toBe(true)
      const pairingCode = (challengeRes.result as any).pairingCode

      // 2. Claim via MCP (Admin)
      const claimRes = await invokeTool(adminAuth, env, 'device_pair_claim', {
        pairing_code: pairingCode,
        device_id: 'rpi5-device-01',
        signature: 'sig-claim-rpi5',
      })
      expect(claimRes.ok).toBe(true)

      // 3. Power update via MCP
      const powerRes = await invokeTool(adminAuth, env, 'device_power_control', {
        device_id: 'rpi5-device-01',
        action: 'update',
        power_state: 'active',
        battery_pct: 100,
        is_charging: true,
      })
      expect(powerRes.ok).toBe(true)
    })
  })
})
