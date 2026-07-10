import { describe, expect, it } from 'vitest'
import {
  assertSharedNonceDomainWindow,
  burnSharedAgentNonce,
  SHARED_NONCE_RETENTION_SEC,
  SHARED_NONCE_WINDOWS_SEC,
} from '../src/fleet/shared-nonce-ledger'
import type { Env } from '../src/types'

function makeEnv() {
  const nonces = new Map<string, number>()
  const meta = { pruneCutoff: 0, inserts: 0 }

  const DB = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              if (sql.includes('DELETE FROM agent_attach_nonces')) {
                const [cutoff] = args as [number]
                meta.pruneCutoff = cutoff
                for (const [nonce, created] of nonces) {
                  if (created < cutoff) nonces.delete(nonce)
                }
                return { meta: { changes: 0 } }
              }
              if (sql.includes('INSERT OR IGNORE INTO agent_attach_nonces')) {
                const [nonce, , created] = args as [string, string, number]
                if (nonces.has(nonce)) return { meta: { changes: 0 } }
                nonces.set(nonce, created)
                meta.inserts += 1
                return { meta: { changes: 1 } }
              }
              throw new Error(`unhandled SQL: ${sql}`)
            },
          }
        },
      }
    },
  }

  return { env: { DB } as unknown as Env, nonces, meta }
}

describe('fleet shared nonce ledger', () => {
  it('retains nonces for twice the maximum registered signed-runtime window', async () => {
    expect(SHARED_NONCE_WINDOWS_SEC).toEqual({
      'fleet-attach:v1': 300,
      'fleet-detach:v1': 300,
      'agent-inbox:v1': 300,
    })
    expect(SHARED_NONCE_RETENTION_SEC).toBe(600)

    const { env, meta } = makeEnv()
    const ok = await burnSharedAgentNonce(env, {
      domain: 'fleet-attach:v1',
      windowSec: 300,
      agentId: 'agent-one',
      nonce: 'nonce_000000000000',
      now: 1_000,
    })

    expect(ok).toBe(true)
    expect(meta.pruneCutoff).toBe(400)
  })

  it('rejects replayed nonces across shared signed-runtime domains', async () => {
    const { env } = makeEnv()
    const first = await burnSharedAgentNonce(env, {
      domain: 'fleet-attach:v1',
      windowSec: 300,
      agentId: 'agent-one',
      nonce: 'shared_nonce_0000',
      now: 1_000,
    })
    const second = await burnSharedAgentNonce(env, {
      domain: 'agent-inbox:v1',
      windowSec: 300,
      agentId: 'agent-one',
      nonce: 'shared_nonce_0000',
      now: 1_001,
    })

    expect(first).toBe(true)
    expect(second).toBe(false)
  })

  it('fails closed if a caller joins the shared table with an unregistered window', () => {
    expect(() => assertSharedNonceDomainWindow('fleet-attach:v1', 301)).toThrow(
      'shared nonce domain fleet-attach:v1 window 301s does not match registered 300s',
    )
  })
})
