// The `seat` argument (lane C) is advertised on every tool by one shared fragment, so exact-schema pins compare the
// tool's own schema without it. tests/seat-handle.test.ts pins that every tool advertises it.
export function withoutSeat<T>(schema: T): T {
  if (typeof schema !== 'object' || schema === null) return schema
  const s = schema as { properties?: Record<string, unknown> }
  if (!s.properties) return schema
  const { seat: _seat, ...rest } = s.properties // eslint-disable-line @typescript-eslint/no-unused-vars
  return { ...schema, properties: rest }
}
