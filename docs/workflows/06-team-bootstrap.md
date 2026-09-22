# Team bootstrap

Source: mupot#1498 ("team_bootstrap: one call creates project-prj + squad-sqd + project bot +
token claim + Hermes profile scaffold — new teams in one step"). Code checked at `origin/main`
`3c706069`.

**Status: unimplemented.** A repo-wide grep for `team_bootstrap`/`teamBootstrap` across every
`.ts` file returns zero hits, and no MCP tool of that shape exists. Issue #1498 is **open**,
filed 2026-09-22, with no linked or cross-referenced PR. This doc records the gap and the
closest existing primitive, rather than describing a shipped flow.

## Trigger

Per the issue's ask: one MCP call, shaped roughly `team_bootstrap { name, slug_base,
department, humans: [{email, capability}], bot: {enabled, model?, role?}, hermes: {profile:
true} }`.

## Actor(s)

An org-admin, per the proposed call. The issue also floats a lighter "proposal" path for
non-admin leads, reusing the agent-proposed-member-invite machinery (#1497).

## Tool/route sequence

The closest existing tool, `bootstrap_self` (`src/mcp/bootstrap.ts:18-109`, logic in
`src/members/bootstrap-self.ts`), solves a **different** problem: it is a per-human identity
mint, not a team/project bootstrap. It creates one `kind='home'` department, one `kind='home'`
squad, one agent, a bearer token, and a founder `squad:admin` grant — all for the *calling
human's own* first-run identity (`src/members/bootstrap-self.ts:45-56`,
`src/org/service.ts:24-49`). Home-kind rows are structurally exempt from plan-limit counters
(`migrations/0093_org_kind_home_exemption.sql`) — the opposite of what #1498 wants, since a new
team/project is real "work" that should count against plan limits.

**Gap against #1498's ask**: no project creation, no `<slug>-bot` project bot, no multi-human
invite fan-out, no `project_remember` seed, no Hermes profile scaffold.

**Today's manual equivalent** (six separate calls, no atomicity, confirmed to exist):
`project_create` (`src/mcp/projects.ts:150`) → `create_squad` (`src/mcp/provision.ts:364`) →
`project_squad_set` (`src/mcp/projects.ts:507`) → `create_agent`
(`src/mcp/provision.ts:438`) → `mint_agent_token` (`src/mcp/provision.ts:598`) → a manual
`reveal_credential_claim` call and hand-written token file.

## Human gate

N/A today, since the tool doesn't exist. Once built: the existing pieces it would compose
(`create_squad`, `create_agent`, `mint_agent_token`) are all `min: 'admin'` today, so
`team_bootstrap` would need at least the same floor, with the issue's lighter lead-proposal
variant routing through #1497's verdict machinery instead.

## Receipt(s) written

`bootstrap_self` today writes exactly one `agent_audit` row (`action='bootstrap_self'`,
`actor_type='user'`, before/after identity snapshots) per human, made idempotent by a partial
unique index (`migrations/0092_bootstrap_self_audit_once.sql`). #1498 would need a new receipt
shape entirely — one row per team-bootstrap call covering the project id, squad id, bot agent
id, credential claim id, and per-human invite outcomes — none of which exists yet.

## What the person sees

`bootstrap_self`'s actual response shape (`src/mcp/bootstrap.ts:50-72`): `{ disposition,
department, squad, agent, member_id, token: {id, capability} (raw token withheld),
credential_claim, founder_grant, audit_id, note }` — the note directs the caller to
`reveal_credential_claim` to redeem the token once. This is not `team_bootstrap`'s response
(which doesn't exist) — shown here only as the shape of the nearest neighbor.

## Tests that pin it

`tests/bootstrap-self.test.ts`, `tests/mcp-bootstrap-tool.test.ts`,
`tests/auth-bootstrap-owner.test.ts` (a separate owner-bootstrap-claim concern). No tests
exist for `team_bootstrap` since it isn't implemented.

## Known gaps

Team bootstrap as a single-call primitive is **unimplemented** as of commit `3c706069`.
**#1498** is the open ask. Today a new team is assembled via six manual calls
(`project_create`, `create_squad`, `project_squad_set`, `create_agent`, `mint_agent_token`,
then a manual reveal + file-write) — "three tools' quirks, one human who knows them," in the
issue's own framing. `bootstrap_self` is not a partial implementation of #1498; it solves the
adjacent but distinct problem of one human's personal, plan-limit-exempt home identity.
