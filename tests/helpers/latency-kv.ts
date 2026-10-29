// In-memory KV, not a SQL mock. Unique markers preserve concurrent failures.
export function latencyKv() {
  const entries = new Map<string, { value: string; metadata?: { observed_at_ms: number } }>()
  const puts: Array<{ key: string; expirationTtl?: number }> = []
  const kv = {
    async get(key: string) { return entries.get(key)?.value ?? null },
    async put(key: string, value: string, options?: { expirationTtl?: number; metadata?: { observed_at_ms: number } }) {
      puts.push({ key, expirationTtl: options?.expirationTtl })
      entries.set(key, { value, metadata: options?.metadata })
    },
    async delete(key: string) { entries.delete(key) },
    async list(options: { prefix: string; cursor?: string; limit?: number }) {
      const keys = [...entries].filter(([key]) => key.startsWith(options.prefix)).sort(([a], [b]) => a.localeCompare(b))
      const offset = Number(options.cursor ?? 0)
      const end = offset + (options.limit ?? 1000)
      return {
        keys: keys.slice(offset, end).map(([name, row]) => ({ name, metadata: row.metadata })),
        list_complete: end >= keys.length,
        cursor: end >= keys.length ? '' : String(end), cacheStatus: null,
      }
    },
  }
  return { kv: kv as unknown as KVNamespace, entries, puts }
}
