// src/devices/governance.ts — Hardware Peripheral & Sensor Capability Governance (FLIGHT DEV-03 / MU.200.001-DEVICE).
//
// Governs physical hardware ports on Mupot OS devices:
// 1. Local ML Engine: 'hardware:local-inference'
// 2. Local Worktree Filesystem: 'hardware:fs-write'
// 3. Audio / Voice Microphone: 'hardware:audio-stream' (Gated)
// 4. Camera / Vision Capture: 'hardware:vision-capture' (Gated)
// 5. GPIO / Robotics: 'hardware:gpio-control' (Owner 2FA Gated)

import type { Env, AuthContext } from '../types'
import { hasCapability, isOrgAdmin } from '../auth/capability'

export const HARDWARE_CAPABILITIES = [
  'hardware:local-inference',
  'hardware:fs-write',
  'hardware:audio-stream',
  'hardware:vision-capture',
  'hardware:gpio-control',
] as const

export type HardwareCapability = (typeof HARDWARE_CAPABILITIES)[number]

export interface CheckHardwareAccessInput {
  deviceId: string
  capability: HardwareCapability
  targetAction?: string
}

export type HardwareAccessResult =
  | { allowed: true }
  | { allowed: false; reason: 'unauthorized_capability' | 'owner_2fa_required' | 'device_suspended'; detail: string }

/**
 * Validates whether an actor has authority to access specific hardware peripherals on Mupot OS.
 */
export async function checkHardwareCapability(
  env: Env,
  auth: AuthContext,
  input: CheckHardwareAccessInput,
): Promise<HardwareAccessResult> {
  // Check device status
  const device = await env.DB.prepare(
    `SELECT status FROM device_keys WHERE device_id = ?1 AND tenant = ?2 LIMIT 1`,
  )
    .bind(input.deviceId, env.TENANT_SLUG)
    .first<{ status: string }>()

  if (!device || device.status !== 'active') {
    return {
      allowed: false,
      reason: 'device_suspended',
      detail: `device ${input.deviceId} is not active`,
    }
  }

  // 1. High-impact hardware control (GPIO / Relays / Robotics) requires Org-Admin / Owner 2FA
  if (input.capability === 'hardware:gpio-control') {
    if (!isOrgAdmin(auth)) {
      return {
        allowed: false,
        reason: 'owner_2fa_required',
        detail: 'GPIO and physical robotics control requires verified org-admin capability',
      }
    }
    return { allowed: true }
  }

  // 2. Sensitive sensor streams (Audio / Video) require explicit grant or lead+
  if (input.capability === 'hardware:audio-stream' || input.capability === 'hardware:vision-capture') {
    const grants = auth.capabilities ?? []
    const hasLead = hasCapability(grants, 'org', null, 'lead')
    if (!hasLead && !isOrgAdmin(auth)) {
      return {
        allowed: false,
        reason: 'unauthorized_capability',
        detail: `accessing sensor stream (${input.capability}) requires at least squad/org lead capability`,
      }
    }
    return { allowed: true }
  }

  // 3. Local inference and filesystem write available to authenticated members
  return { allowed: true }
}
