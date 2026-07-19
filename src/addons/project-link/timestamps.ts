const JULIAN_UNIX_EPOCH = 2440587.5
const MILLISECONDS_PER_DAY = 86400000

export function projectLinkTimestampMsSql(expression: string): string {
  return `CAST(ROUND((julianday(${expression}) - ${JULIAN_UNIX_EPOCH}) * ${MILLISECONDS_PER_DAY}) AS INTEGER)`
}

export function projectLinkLatestEventMsSql(alias = ''): string {
  const column = (name: string) => alias ? `${alias}.${name}` : name
  return `CAST(ROUND((MAX(
    julianday(${column('created_at')}),
    julianday(COALESCE(${column('last_success_at')}, ${column('created_at')})),
    julianday(COALESCE(${column('last_failure_at')}, ${column('created_at')})),
    julianday(COALESCE(${column('revoked_at')}, ${column('created_at')}))
  ) - ${JULIAN_UNIX_EPOCH}) * ${MILLISECONDS_PER_DAY}) AS INTEGER)`
}
