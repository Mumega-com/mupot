// src/devices/power.ts — Hardware Power Management & Wake-on-Demand Mesh (FLIGHT DEV-05 / MU.200.001-DEVICE).
//
// 1. Power State Tracking: 'active' | 'low_power' | 'sleep' | 'offline'.
// 2. Battery & Telemetry Monitoring: battery percentage, charging state, and last state transition.
// 3. Wake-on-Demand Mesh: Emits wake signals targeting sleeping hardware seats upon high-priority task arrival.

import type { Env, AuthContext } from '../types'
import { createBus } from '../bus'

export interface DevicePowerStateRecord {
  device_id: string
  tenant: string
  power_state: 'active' | 'low_power' | 'sleep' | 'offline'
  battery_pct: number | null
  is_charging: number
  wol_mac_address: string | null
  last_state_change: string
}

export interface UpdateDevicePowerInput {
  deviceId: string
  powerState: 'active' | 'low_power' | 'sleep' | 'offline'
  batteryPct?: number | null
  isCharging?: boolean
  wolMacAddress?: string | null
}

export interface WakeDeviceInput {
  deviceId: string
  reason?: string
  priority?: 'P0' | 'P1' | 'P2'
}

/**
 * Updates a device's hardware power state and battery telemetry in D1.
 */
export async function updateDevicePowerState(
  env: Env,
  input: UpdateDevicePowerInput,
): Promise<DevicePowerStateRecord> {
  const nowIso = new Date().toISOString()
  const isChargingInt = input.isCharging ? 1 : 0

  await env.DB.prepare(
    `INSERT INTO device_power_states
       (device_id, tenant, power_state, battery_pct, is_charging, wol_mac_address, last_state_change)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (device_id) DO UPDATE SET
       power_state = excluded.power_state,
       battery_pct = COALESCE(excluded.battery_pct, device_power_states.battery_pct),
       is_charging = excluded.is_charging,
       wol_mac_address = COALESCE(excluded.wol_mac_address, device_power_states.wol_mac_address),
       last_state_change = excluded.last_state_change`,
  )
    .bind(
      input.deviceId,
      env.TENANT_SLUG,
      input.powerState,
      input.batteryPct ?? null,
      isChargingInt,
      input.wolMacAddress ?? null,
      nowIso,
    )
    .run()

  return {
    device_id: input.deviceId,
    tenant: env.TENANT_SLUG,
    power_state: input.powerState,
    battery_pct: input.batteryPct ?? null,
    is_charging: isChargingInt,
    wol_mac_address: input.wolMacAddress ?? null,
    last_state_change: nowIso,
  }
}

/**
 * Emits a wake signal across the exact-seat mesh targeting a sleeping hardware device.
 */
export async function wakeHardwareDevice(
  env: Env,
  auth: AuthContext,
  input: WakeDeviceInput,
): Promise<{ ok: boolean; deviceId: string; powerState: string; signalEmitted: boolean }> {
  const current = await env.DB.prepare(
    `SELECT * FROM device_power_states WHERE device_id = ?1 AND tenant = ?2 LIMIT 1`,
  )
    .bind(input.deviceId, env.TENANT_SLUG)
    .first<DevicePowerStateRecord>()

  const nowIso = new Date().toISOString()

  // Emit hardware wake bus event
  const wakeEvent = {
    type: 'agent.wake',
    tenant: env.TENANT_SLUG,
    agent_id: input.deviceId,
    payload: {
      target_device: input.deviceId,
      wol_mac: current?.wol_mac_address,
      reason: input.reason ?? 'hardware_wake_demand',
      priority: input.priority ?? 'P1',
      by: auth.memberId ?? auth.userId,
    },
    ts: nowIso,
  }

  await createBus(env).emit(wakeEvent as any)

  return {
    ok: true,
    deviceId: input.deviceId,
    powerState: current?.power_state ?? 'offline',
    signalEmitted: true,
  }
}
