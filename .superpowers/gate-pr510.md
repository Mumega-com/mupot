# PR #510 Gate Review

**PR:** cursor: BYOA slice 5 — customer onboarding surface (add agent -> pick harness -> mint/register -> grant -> pack)
**Branch:** cursor/task-adf25dd2
**Gate Status:** ✅ PASS

## Changes Verified

- `src/byoa/catalog.ts` — Harness catalog (topology A/B/C, credential types, embedded pack files)
- `src/dashboard/byoa-onboard.ts` — Dashboard UI (form + success page)
- `src/dashboard/index.ts` — Route handlers (GET form, POST create+mint, GET pack download)
- `src/mcp/provision.ts` — MCP tools (mirrors dashboard paths, sovereign-core discipline)
- `docs/byoa-customer-onboarding.md` — Flow documentation (dashboard + MCP)
- `packs/*/` — Install packs for topology A/C harnesses (claude-code, codex, cursor, cursor-background, claude-managed)
- `scripts/local-browser-smoke.mjs` — Browser smoke test covering onboarding happy path
- Tests: `byoa-catalog.test.ts`, `byoa-onboard.test.ts`, `local-browser-smoke.test.ts`

## Verification

- ✅ TypeScript: `npx tsc --noEmit` clean
- ✅ Unit tests: 19 pass (catalog, onboarding, smoke)
- ✅ Flow: POST creates agent → mints show-once token → optional Ed25519 register (topology C) → returns pack JSON
- ✅ Security: Credential scope hard-capped at squad-scoped member (not org/dept); raw token shown once only
- ✅ Topology support: A (topology-A harnesses on customer infra), C (vendor-hosted agents), B (docs-only, human Connector)
- ✅ Pack contract: Embedded files, no real tokens (placeholders), download endpoint works
- ✅ Docs: Clear flow table, MCP examples, attach/govern instructions
- ✅ Admin gate: Org-admin only for dashboard form and pack download
- ✅ Pack eligibility: Refuses Claude Desktop (docs_only), allows A/C only

## Design Notes

- Escalation guard on mint is critical: agent token can NEVER inherit caller's org-admin, only squad-scoped observer/member
- Topology B (Claude Desktop) is intentionally docs-only; no drivable dispatch target
- MCP tools mirror dashboard paths exactly — one source of truth for validation
- Show-once raw token display (browser-rendered, non-stored) is correct BYOA onboarding UX

## Gate Verdict

**PASS** — Code is clean, tests comprehensive, security discipline sound. Ready for merge per kasra-core gating.

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>
