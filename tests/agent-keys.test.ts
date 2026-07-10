import { beforeAll, describe, expect, it } from 'vitest'
import { isValidEd25519PublicX, registerAgentPublicKey } from '../src/fleet/agent-keys'
import type { Env } from '../src/types'

interface KeyRow {
  tenant: string
  agent_id: string
  pubkey: string
  algo: string
  member_id: string | null
  created_at: number
}

let publicX = ''
let otherPublicX = ''

beforeAll(async () => {
  const first = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const second = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  publicX = (await crypto.subtle.exportKey('jwk', first.publicKey)).x as string
  otherPublicX = (await crypto.subtle.exportKey('jwk', second.publicKey)).x as string
})

function fakeEnv(identities: string[], initial?: KeyRow) {
  let key = initial ? { ...initial } : null
  const writes: Array<{ sql: string; args: unknown[] }> = []
  const identityBinds: unknown[][] = []
  const env = {
    TENANT_SLUG: 'tenant-a',
    DB: {
      prepare(sql: string) {
        const args: unknown[] = []
        const stmt = {
          bind(...values: unknown[]) {
            args.push(...values)
            return stmt
          },
          async all<T>() {
            if (!sql.includes('SELECT DISTINCT t.member_id')) throw new Error(`unhandled all: ${sql}`)
            identityBinds.push([...args])
            return { results: identities.map((member_id) => ({ member_id })) as T[] }
          },
          async first<T>() {
            if (!sql.includes('FROM agent_keys')) throw new Error(`unhandled first: ${sql}`)
            return (
              key && key.tenant === args[0] && key.agent_id === args[1]
                ? { pubkey: key.pubkey, algo: key.algo, member_id: key.member_id }
                : null
            ) as T | null
          },
          async run() {
            writes.push({ sql, args: [...args] })
            if (sql.includes('INSERT INTO agent_keys')) {
              if (key && key.tenant === args[0] && key.agent_id === args[1]) return { meta: { changes: 0 } }
              key = {
                tenant: args[0] as string,
                agent_id: args[1] as string,
                pubkey: args[2] as string,
                algo: 'Ed25519',
                member_id: args[3] as string,
                created_at: args[4] as number,
              }
              return { meta: { changes: 1 } }
            }
            if (sql.includes('UPDATE agent_keys') && key?.member_id === null) {
              key.member_id = args[2] as string
              return { meta: { changes: 1 } }
            }
            return { meta: { changes: 0 } }
          },
        }
        return stmt
      },
    },
  } as unknown as Env
  return { env, writes, identityBinds, getKey: () => key }
}

describe('agent public-key registration', () => {
  it('accepts a canonical Ed25519 x coordinate and rejects malformed input', async () => {
    expect(await isValidEd25519PublicX(publicX)).toBe(true)
    expect(await isValidEd25519PublicX(`${publicX}=`)).toBe(false)
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const last = alphabet.indexOf(publicX.at(-1) as string)
    const nonCanonical = `${publicX.slice(0, -1)}${alphabet[(last + 1) % alphabet.length]}`
    expect(await isValidEd25519PublicX(nonCanonical)).toBe(false)
    expect(await isValidEd25519PublicX('not-a-key')).toBe(false)
    expect(await isValidEd25519PublicX(null)).toBe(false)
  })

  it('tenant-binds the unique active identity and is idempotent', async () => {
    const state = fakeEnv(['member-1'])
    expect(await registerAgentPublicKey(state.env, 'runtime-1', 'agent-1', publicX, () => 1234)).toEqual({
      ok: true,
      status: 'registered',
      memberId: 'member-1',
    })
    expect(state.getKey()).toEqual({
      tenant: 'tenant-a',
      agent_id: 'runtime-1',
      pubkey: publicX,
      algo: 'Ed25519',
      member_id: 'member-1',
      created_at: 1234,
    })
    expect(state.identityBinds).toEqual([['tenant-a', 'agent-1']])
    expect(await registerAgentPublicKey(state.env, 'runtime-1', 'agent-1', publicX)).toEqual({
      ok: true,
      status: 'already_registered',
      memberId: 'member-1',
    })
  })

  it('binds a matching legacy unbound key without replacing it', async () => {
    const state = fakeEnv(['member-1'], {
      tenant: 'tenant-a', agent_id: 'runtime-1', pubkey: publicX,
      algo: 'Ed25519', member_id: null, created_at: 10,
    })
    expect(await registerAgentPublicKey(state.env, 'runtime-1', 'agent-1', publicX)).toEqual({
      ok: true,
      status: 'bound',
      memberId: 'member-1',
    })
    expect(state.getKey()?.member_id).toBe('member-1')
  })

  it('refuses unminted, ambiguous, and conflicting registrations', async () => {
    expect(await registerAgentPublicKey(fakeEnv([]).env, 'runtime-1', 'agent-1', publicX)).toEqual({
      ok: false, reason: 'identity_unminted',
    })
    expect(await registerAgentPublicKey(fakeEnv(['member-1', 'member-2']).env, 'runtime-1', 'agent-1', publicX)).toEqual({
      ok: false, reason: 'identity_ambiguous',
    })
    const conflict = fakeEnv(['member-1'], {
      tenant: 'tenant-a', agent_id: 'runtime-1', pubkey: otherPublicX,
      algo: 'Ed25519', member_id: 'member-1', created_at: 10,
    })
    expect(await registerAgentPublicKey(conflict.env, 'runtime-1', 'agent-1', publicX)).toEqual({
      ok: false, reason: 'key_conflict',
    })
    expect(conflict.writes).toEqual([])
  })
})
