import type { BeginResult, DecisionReceipt, TickStore } from './priority-engine'

export interface SqlExec {
  run(sql: string, ...params: unknown[]): Promise<{ changes: number }>
  get<T>(sql: string, ...params: unknown[]): Promise<T | undefined>
}

export class SqlTickStore implements TickStore {
  constructor(private readonly sql: SqlExec) {}

  async get(idempotencyKey: string): Promise<DecisionReceipt | undefined> {
    const row = await this.sql.get<{ receipt_json: string }>(
      'SELECT receipt_json FROM priority_engine_receipts WHERE idempotency_key = ?1',
      idempotencyKey,
    )
    return row ? JSON.parse(row.receipt_json) as DecisionReceipt : undefined
  }

  async begin(idempotencyKey: string): Promise<BeginResult> {
    const inserted = await this.sql.run(
      `INSERT OR IGNORE INTO priority_engine_reservations
        (idempotency_key, status, created_at) VALUES (?1, 'inflight', ?2)`,
      idempotencyKey,
      new Date().toISOString(),
    )
    if (inserted.changes > 0) return { status: 'acquired' }
    const existing = await this.get(idempotencyKey)
    if (existing) return { status: 'existing', receipt: existing }
    return { status: 'in_flight' }
  }

  async claim(taskId: string, idempotencyKey: string): Promise<boolean> {
    const existing = await this.sql.get<{ idempotency_key: string }>(
      'SELECT idempotency_key FROM priority_engine_claims WHERE task_id = ?1',
      taskId,
    )
    if (existing?.idempotency_key === idempotencyKey) return true
    const result = await this.sql.run(
      `INSERT OR IGNORE INTO priority_engine_claims
        (task_id, idempotency_key, created_at) VALUES (?1, ?2, ?3)`,
      taskId,
      idempotencyKey,
      new Date().toISOString(),
    )
    return result.changes > 0
  }

  async releaseClaim(taskId: string, idempotencyKey: string): Promise<void> {
    await this.sql.run(
      'DELETE FROM priority_engine_claims WHERE task_id = ?1 AND idempotency_key = ?2',
      taskId,
      idempotencyKey,
    )
  }

  async put(receipt: DecisionReceipt): Promise<void> {
    await this.sql.run(
      `INSERT OR IGNORE INTO priority_engine_receipts
        (idempotency_key, cas_key, result, receipt_json, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5)`,
      receipt.idempotency_key,
      receipt.cas_key,
      receipt.result,
      JSON.stringify(receipt),
      receipt.created_at,
    )
    await this.sql.run(
      `UPDATE priority_engine_reservations SET status = 'final'
        WHERE idempotency_key = ?1`,
      receipt.idempotency_key,
    )
  }
}

export function createD1TickStore(db: {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>
      run(): Promise<{ meta?: { changes?: number } }>
    }
  }
}): TickStore {
  return new SqlTickStore({
    async run(sql: string, ...params: unknown[]) {
      const result = await db.prepare(sql).bind(...params).run()
      return { changes: Number(result.meta?.changes ?? 0) }
    },
    async get<T>(sql: string, ...params: unknown[]) {
      const row = await db.prepare(sql).bind(...params).first<T>()
      return row ?? undefined
    },
  })
}
