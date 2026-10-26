// Seeds the live member + member_tokens row that resolveAuth's internal-header hop re-reads. The hop
// accepts an injected identity only when its tokenId names a live row for that member in this tenant.
import type { SqliteD1Harness } from './sqlite-d1'

type Database = SqliteD1Harness['sqlite']

export interface LiveTokenSeed {
  memberId: string
  tenant: string
  tokenId?: string
  channel?: 'workspace' | 'im' | 'dashboard' | 'directory'
  boundAgentId?: string | null
  harnessKind?: string | null
}

/** Idempotent: creates the member and the token row if absent; returns the token id. */
export function seedLiveToken(sqlite: Database, seed: LiveTokenSeed): string {
  const tokenId = seed.tokenId ?? `tok-live-${seed.memberId}`
  sqlite
    .prepare(`INSERT OR IGNORE INTO members (id, email, display_name, status, tenant) VALUES (?, ?, ?, 'active', ?)`)
    .run(seed.memberId, `${seed.memberId}@example.test`, seed.memberId, seed.tenant)
  if (seed.boundAgentId) {
    sqlite
      .prepare(`INSERT OR IGNORE INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES (?, ?, ?, datetime('now'))`)
      .run(seed.tenant, seed.boundAgentId, seed.memberId)
  }
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant, harness_kind)
       VALUES (?, ?, ?, 'test', ?, datetime('now'), ?, ?, ?)`,
    )
    .run(tokenId, seed.memberId, `hash-${tokenId}`, seed.channel ?? 'workspace', seed.boundAgentId ?? null, seed.tenant, seed.harnessKind ?? null)
  return tokenId
}
