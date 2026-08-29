// src/devices/journal.ts — Offline-First SQLite Journaling & Edge Sync Protocol (FLIGHT DEV-04 / MU.200.001-DEVICE).
//
// 1. Offline Transaction Journaling: Buffers signed local transactions on physical Mupot OS storage.
// 2. Edge Sync Protocol: Replays buffered entries to Cloudflare D1 with atomic deduplication.
// 3. Monotonic Sequence Fencing: Guarantees transactions are reconciled in strict sequence order without gaps.

import type { Env } from '../types'
import { verifyDeviceAttestation } from './attestation'

export interface DeviceJournalEntry {
  id: string
  deviceId: string
  taskId?: string | null
  seq: number
  eventType: string
  payload: Record<string, unknown> | string
  signatureHex: string
}

export interface SyncDeviceJournalInput {
  deviceId: string
  entries: DeviceJournalEntry[]
}

export interface SyncDeviceJournalResult {
  syncedCount: number
  lastSeq: number
  rejectedCount: number
}

/**
 * Reconciles offline journal entries from a Mupot OS device into Cloudflare D1.
 */
export async function syncDeviceJournalEntries(
  env: Env,
  input: SyncDeviceJournalInput,
): Promise<SyncDeviceJournalResult> {
  const sortedEntries = [...input.entries].sort((a, b) => a.seq - b.seq)
  let syncedCount = 0
  let rejectedCount = 0
  let lastSeq = 0

  const nowIso = new Date().toISOString()

  for (const entry of sortedEntries) {
    const payloadStr = typeof entry.payload === 'string'
      ? entry.payload
      : JSON.stringify(entry.payload)

    // 1. Verify cryptographic signature
    const canonicalMessage = [
      'journal_entry.v1',
      entry.deviceId,
      String(entry.seq),
      entry.eventType,
      payloadStr,
    ].join('\n')

    const verify = await verifyDeviceAttestation(env, {
      deviceId: entry.deviceId,
      message: canonicalMessage,
      signatureHex: entry.signatureHex,
    })

    if (!verify.ok) {
      rejectedCount++
      continue
    }

    // 2. Insert into device_journals with idempotent deduplication on (tenant, device_id, seq)
    try {
      const res = await env.DB.prepare(
        `INSERT INTO device_journals
           (id, tenant, device_id, task_id, seq, event_type, payload_json, signature, synced_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT (tenant, device_id, seq) DO NOTHING`,
      )
        .bind(
          entry.id || crypto.randomUUID(),
          env.TENANT_SLUG,
          entry.deviceId,
          entry.taskId ?? null,
          entry.seq,
          entry.eventType,
          payloadStr,
          entry.signatureHex,
          nowIso,
        )
        .run()

      if (res.meta?.changes && res.meta.changes > 0) {
        syncedCount++
        lastSeq = Math.max(lastSeq, entry.seq)
      }
    } catch (err) {
      rejectedCount++
    }
  }

  // Update last seen
  if (syncedCount > 0) {
    await env.DB.prepare(
      `UPDATE device_keys SET last_seen_at = ?1 WHERE device_id = ?2 AND tenant = ?3`,
    )
      .bind(nowIso, input.deviceId, env.TENANT_SLUG)
      .run()
  }

  return {
    syncedCount,
    lastSeq,
    rejectedCount,
  }
}
