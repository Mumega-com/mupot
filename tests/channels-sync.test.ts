import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Capability, ChannelBinding } from '../src/types'

let membersByChannel: Record<string, string[]> = {}

vi.mock('../src/channels/registry', () => ({
  getAdapter: () => ({
    listChannelMembers: async (_env: unknown, channelId: string) => membersByChannel[channelId] ?? [],
    roleCapability: async () => null,
  }),
}))

interface ManualGrant {
  member_id: string
  scope_type: 'squad'
  scope_id: string
  capability: Capability
}

interface ChannelGrant {
  id: string
  binding_id: string
  member_id: string
  squad_id: string
  capability: Capability
  created_at: string
  updated_at: string
}

interface SyncState {
  bindings: ChannelBinding[]
  identities: { platform: string; external_user_id: string; member_id: string }[]
  channelGrants: ChannelGrant[]
  manualGrants: ManualGrant[]
  // squad_id → kind, defaulted to 'work' when a binding's squad_id has no entry
  // (every pre-existing test in this file targets squad-1 with no home semantics).
  squadKinds?: Record<string, string>
}

function makeStatement(state: SyncState, sql: string, args: unknown[]) {
  return {
    async first<T>() {
      if (sql.includes('FROM member_identities')) {
        const [platform, externalUserId] = args
        const row = state.identities.find(
          (i) => i.platform === platform && i.external_user_id === externalUserId,
        )
        return (row ? { member_id: row.member_id } : null) as T | null
      }

      if (sql.includes('FROM channel_capability_grants') && sql.includes('LIMIT 1')) {
        const [bindingId, memberId, squadId] = args
        const row = state.channelGrants.find(
          (g) => g.binding_id === bindingId && g.member_id === memberId && g.squad_id === squadId,
        )
        return (row ? { capability: row.capability } : null) as T | null
      }

      // ensureSquadGrant's belt-and-braces home-kind check (P0-2 fix, G-FP1b
      // point 4): SELECT kind FROM squads WHERE id = ?1. Defaults to 'work'
      // so every pre-existing test in this file is unaffected.
      if (sql.includes('SELECT kind FROM squads WHERE id')) {
        const [squadId] = args
        const kind = state.squadKinds?.[String(squadId)] ?? 'work'
        return { kind } as T
      }

      return null
    },

    async all<T>() {
      if (sql.includes('FROM channel_bindings')) {
        return { results: state.bindings as T[] }
      }

      if (sql.includes('FROM channel_capability_grants')) {
        const [bindingId, squadId] = args
        return {
          results: state.channelGrants
            .filter((g) => g.binding_id === bindingId && g.squad_id === squadId)
            .map((g) => ({ member_id: g.member_id, capability: g.capability })) as T[],
        }
      }

      return { results: [] as T[] }
    },

    async run() {
      if (sql.includes('DELETE FROM channel_capability_grants')) {
        const [bindingId, memberId, squadId] = args
        state.channelGrants = state.channelGrants.filter(
          (g) => !(g.binding_id === bindingId && g.member_id === memberId && g.squad_id === squadId),
        )
      }

      if (sql.includes('INSERT INTO channel_capability_grants')) {
        const [id, bindingId, memberId, squadId, capability, updatedAt] = args
        state.channelGrants.push({
          id: String(id),
          binding_id: String(bindingId),
          member_id: String(memberId),
          squad_id: String(squadId),
          capability: capability as Capability,
          created_at: String(updatedAt),
          updated_at: String(updatedAt),
        })
      }

      return { meta: { changes: 1 } }
    },
  }
}

function makeEnv(state: SyncState) {
  return {
    DB: {
      prepare(sql: string) {
        return {
          ...makeStatement(state, sql, []),
          bind(...args: unknown[]) {
            return makeStatement(state, sql, args)
          },
        }
      },
      async batch(statements: Array<{ run: () => Promise<unknown> }>) {
        for (const statement of statements) await statement.run()
        return []
      },
    },
  } as never
}

function binding(id: string, external_channel_id: string): ChannelBinding {
  return {
    id,
    platform: 'test',
    external_channel_id,
    squad_id: 'squad-1',
    max_capability: 'member',
    created_at: '2026-06-06T00:00:00.000Z',
  }
}

beforeEach(() => {
  membersByChannel = {}
})

describe('reconcileMembership', () => {
  it('revokes only the departed binding grant and preserves other sources', async () => {
    const { reconcileMembership } = await import('../src/channels/sync')
    membersByChannel = {
      'chan-a': [],
      'chan-b': ['external-1'],
    }
    const state: SyncState = {
      bindings: [binding('bind-a', 'chan-a'), binding('bind-b', 'chan-b')],
      identities: [{ platform: 'test', external_user_id: 'external-1', member_id: 'member-1' }],
      manualGrants: [
        {
          member_id: 'member-1',
          scope_type: 'squad',
          scope_id: 'squad-1',
          capability: 'member',
        },
      ],
      channelGrants: [
        {
          id: 'grant-a',
          binding_id: 'bind-a',
          member_id: 'member-1',
          squad_id: 'squad-1',
          capability: 'member',
          created_at: '',
          updated_at: '',
        },
        {
          id: 'grant-b',
          binding_id: 'bind-b',
          member_id: 'member-1',
          squad_id: 'squad-1',
          capability: 'lead',
          created_at: '',
          updated_at: '',
        },
      ],
    }

    const report = await reconcileMembership(makeEnv(state))

    expect(report).toEqual({ bindings: 2, reconciled: 2, failed: 0 })
    expect(state.manualGrants).toHaveLength(1)
    expect(state.channelGrants.map((g) => g.binding_id)).toEqual(['bind-b'])
    expect(state.channelGrants[0].capability).toBe('member')
  })

  // Athena's §2e-8 table-exhaustive requirement (Round 2 on #1472): one
  // mutation-proven test PER writer table. `channel_capability_grants` is
  // written ONLY by ensureSquadGrant (src/channels/sync.ts) — a channel
  // member present in a bound channel must NEVER receive a standing grant
  // when the bound squad is kind='home', even though every other condition
  // (member present, no existing grant) is identical to the happy-path test
  // above.
  it('never writes a channel_capability_grants row for a home-kind squad, even with a present, ungranted member', async () => {
    const { reconcileMembership } = await import('../src/channels/sync')
    membersByChannel = { 'chan-home': ['external-1'] }
    const state: SyncState = {
      bindings: [{ ...binding('bind-home', 'chan-home'), squad_id: 'squad-home-1' }],
      identities: [{ platform: 'test', external_user_id: 'external-1', member_id: 'member-1' }],
      manualGrants: [],
      channelGrants: [],
      squadKinds: { 'squad-home-1': 'home' },
    }

    const report = await reconcileMembership(makeEnv(state))

    expect(report).toEqual({ bindings: 1, reconciled: 1, failed: 0 })
    expect(state.channelGrants).toHaveLength(0)
  })
})
