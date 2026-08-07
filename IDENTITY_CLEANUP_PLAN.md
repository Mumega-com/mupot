# Identity Cleanup Plan — Approval Required

**Task:** Identity cleanup per-record approval from Hadi, nothing unilateral  
**Branch:** claude/task-eaf6673c  
**Date:** 2026-08-05

---

## Summary

This document catalogs identity records requiring cleanup before ADR-001 settles the coherent model. Three categories of issues identified:

1. **Token naming inversion** — kasra identity permissions are misaligned with role names
2. **Suspended member with admin grant** — a suspended member holds org:admin capability
3. **Inactive agent records** — 4 of 6 hadi/codex agents are inactive

All changes require **per-record approval from Hadi** before execution.

---

## Issue 1: Token Naming / Capability Inversion

**Current State:**
- A member record named "kasra-member" or similar holds `org:admin` capability
- A member record named "kasra-admin" or similar is suspended/revoked
- The names are inverted relative to their actual role

**Problem:**
- Operational confusion: the live admin credential is mislabeled
- Future audits will misinterpret the org:admin grant as being on the "member" account

**Required Approval:**
- [ ] Keep "kasra-member" with org:admin, relabel "kasra-admin" to something else  
- [ ] OR revoke "kasra-member" org:admin and grant it to a new member  
- [ ] OR delete both and recreate with correct names

**Verification:**
- After fix: `SELECT * FROM members WHERE id LIKE '%kasra%' ORDER BY created_at`
- After fix: `SELECT member_id, scope_type, capability FROM capabilities WHERE scope_type = 'org' AND member_id LIKE '%kasra%'`

---

## Issue 2: Suspended Member + Admin Capability

**Current State:**
- A member record with `status = 'suspended'` holds `org:admin` capability
- The suspension blocks all auth (verified: line 260 of src/mcp/index.ts)
- BUT the capability grant still exists in the database

**Problem:**
- Leftover capability creates audit confusion
- Future activation would re-enable the admin grant (security regression risk)
- Inconsistent state: grant says "admin", status says "suspended"

**Required Approval:**
- [ ] Revoke org:admin capability from the suspended member  
- [ ] Keep the member record as historical archive  
- [ ] OR delete the member record entirely (if no audit trail needed)

**Verification:**
```sql
SELECT m.id, m.status, c.capability
  FROM members m
  LEFT JOIN capabilities c ON m.id = c.member_id
 WHERE m.status = 'suspended' AND c.capability = 'admin'
```

---

## Issue 3: Inactive Agent Records

**Current State:**
- 6 hadi/codex agent records exist:
  - `hadi-codex` — role "FRC Multimedia Head", status (check)
  - `hadi-codex-code` — status (check)
  - `hadi-codex-cli` — status (check)
  - `hadiservat-codex` — status (check)
  - `hadi-mupot-dme` — status (check)
  - (6th agent TBD)
- 4 of these are marked `status = 'inactive'` (or 'paused')

**Problem:**
- Dead agents clutter the roster and fleet visibility
- Unclear intent: are these archived for audit or candidates for deletion?

**Required Approval:**
For each inactive agent:
- [ ] **hadi-codex**: Keep as archive | Delete  
- [ ] **hadi-codex-code**: Keep as archive | Delete  
- [ ] **hadi-codex-cli**: Keep as archive | Delete  
- [ ] **hadiservat-codex**: Keep as archive | Delete  
- [ ] **hadi-mupot-dme**: Keep as archive | Delete

**Verification:**
```sql
SELECT id, name, role, status, created_at
  FROM agents
 WHERE id LIKE '%hadi%' OR id LIKE '%codex%'
 ORDER BY created_at
```

---

## Additional Cleanup Candidate

**6 Hadi Member Records:**
- Count and status of each
- 2 are suspended (need to verify which ones)

**4 Kasra Member Records:**
- Verify which one holds org:admin
- Verify which one is DEAD (revoked tokens)

---

## Execution Gate

**Required Before Cleanup:**
1. [ ] Hadi reviews and approves each record listed above
2. [ ] Approval taken as explicit per-record decision (not blanket "clean it up")
3. [ ] This plan document updated with decisions
4. [ ] Migrations written
5. [ ] `npx tsc --noEmit` passes
6. [ ] `npx vitest run` passes
7. [ ] Commit created (no push, no PR, no merge)
8. [ ] Driver gates delivery

---

## Rollback Plan

- No prod database mutations until approval
- Migrations are reversible via D1 schema restore if needed
- Capability grants can be re-added if over-deleted

---

## References

- **MCP Auth Logic:** src/mcp/index.ts:260 (suspension check)
- **Capability Grant Schema:** migrations/0002_members.sql
- **Audit Trail:** src/dashboard/audit.ts (for historical context)
- **Related:** ADR-001 (threads as unit of work) — once landed, reframe identity model
