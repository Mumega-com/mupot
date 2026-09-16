// A "landed-proof" stamp — an ISO-8601 timestamp with 6 random digits
// spliced before the trailing `Z`, unique enough per call that two
// concurrent statements each race-checking "did MY OWN write land" (via an
// `EXISTS` clause that names this exact value, alongside the row's own
// identity columns) cannot coincide by chance within the same millisecond.
// mupot#1425 round 4 (kasra-review P0-2): a bare `new Date().toISOString()`
// used as a landed-proof value DOES collide across two different calls
// landing in the same millisecond — proven live against
// `src/tasks/service.ts`'s verdict INSERT guard, the exact class round 2's
// P3-G fix already closed one statement away (the Telegram-bind guard). One
// shared implementation, reused everywhere a landed-proof pattern is
// needed, so a future guard cannot reintroduce the bare-timestamp version
// by forking a second copy:
//   - src/members/project-invites.ts (`MEMBER_BIND_LANDED_GUARD_SQL`'s own
//     `telegram_bound_at` stamp — the pattern's origin)
//   - src/im/origin-verdict.ts (the replay reservation's `created_at` and
//     the first-bind's `telegram_bound_at`)
//   - src/tasks/service.ts (`buildVerdictStatements`' verdict-landed proof)
export function claimTimestamp(): string {
  const iso = new Date().toISOString()
  const random = new Uint32Array(1)
  crypto.getRandomValues(random)
  const suffix = String(random[0] % 1_000_000).padStart(6, '0')
  return iso.replace('Z', `${suffix}Z`)
}
