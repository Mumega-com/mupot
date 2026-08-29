// src/devices/executor.ts — Local Sandboxed Execution Engine for Mupot OS (FLIGHT DEV-02 / MU.200.001-DEVICE).
//
// 1. Local Sandboxed Execution: Interfaces with Apple Silicon MLX & Linux containerized workers.
// 2. $0 Token Local Inference Telemetry: Reports tokens processed locally without SaaS model bills.
// 3. Cryptographic Execution Attestation: Signs local task execution evidence with device hardware keys.

import type { Env } from '../types'
import { verifyDeviceAttestation } from './attestation'

export interface LocalExecutionJob {
  taskId: string
  deviceId: string
  command: string
  workdir?: string
  model?: string // e.g. 'mlx-deepseek-r1-q4'
  envVars?: Record<string, string>
  timeoutSec?: number
}

export interface LocalExecutionResult {
  taskId: string
  deviceId: string
  exitCode: number
  output: string
  artifactPath?: string
  artifactSha256?: string
  tokensProcessed: number // Local $0 tokens
  costMicroUsd: number     // 0 for local hardware
  durationMs: number
  signature: string
}

export interface ReportDeviceExecutionInput {
  deviceId: string
  taskId: string
  result: LocalExecutionResult
  signatureHex: string
}

/**
 * Validates and records local device execution results with cryptographic proof.
 */
export async function reportDeviceExecution(
  env: Env,
  input: ReportDeviceExecutionInput,
): Promise<{ ok: true; receiptId: string } | { ok: false; status: number; error: string; detail?: string }> {
  // 1. Verify device attestation signature
  const canonicalMessage = [
    'device_exec.v1',
    input.deviceId,
    input.taskId,
    String(input.result.exitCode),
    input.result.artifactSha256 ?? '',
    String(input.result.tokensProcessed),
  ].join('\n')

  const verify = await verifyDeviceAttestation(env, {
    deviceId: input.deviceId,
    message: canonicalMessage,
    signatureHex: input.signatureHex,
  })

  if (!verify.ok) {
    return {
      ok: false,
      status: 401,
      error: 'device_signature_invalid',
      detail: verify.reason ?? 'hardware attestation signature verification failed',
    }
  }

  // 2. Update task result in D1
  const nowIso = new Date().toISOString()
  const receiptId = crypto.randomUUID()
  const resultFormatted = `[Mupot OS Device: ${input.deviceId}]\nOutput: ${input.result.output.slice(0, 500)}\nTokens (Local $0): ${input.result.tokensProcessed}\nArtifact: ${input.result.artifactPath ?? 'none'}\nSHA256: ${input.result.artifactSha256 ?? 'none'}`

  await env.DB.prepare(
    `UPDATE tasks
        SET result = ?1,
            status = 'review',
            updated_at = ?2
      WHERE id = ?3`,
  )
    .bind(resultFormatted, nowIso, input.taskId)
    .run()

  // 3. Update device last seen
  await env.DB.prepare(
    `UPDATE device_keys SET last_seen_at = ?1 WHERE device_id = ?2 AND tenant = ?3`,
  )
    .bind(nowIso, input.deviceId, env.TENANT_SLUG)
    .run()

  return { ok: true, receiptId }
}
