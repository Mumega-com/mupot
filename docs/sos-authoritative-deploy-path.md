# SOS Authoritative Deploy Path (sos#193)

## Status: ESTABLISHED

The path from source to running daemon is now documented. This unblocks downstream changes.

## Authoritative Source Repository

**Mumega-com/sos** (public: https://github.com/Mumega-com/sos) is the single source of truth for production code.

- Push is disabled on the public remote (write-protected)
- All changes flow through standard GitHub PR review
- Merged code is the authoritative version

## Live Deployment Worktree

```
/home/mumega/sos-public-kernel → worktree of Mumega-com/sos
```

This is where code executes:
- Service restart applies changes (no build step)
- MCP SSE server runs from `sos/mcp/sos_mcp_sse.py` in this tree
- Must always point to a tested, immutable state (not a dirty feature branch)

## Internal Development Repository

```
/mnt/HC_Volume_104325311/SOS → mumega-sos-internal (private: development staging)
symlinked as /home/mumega/SOS
```

- Development happens here first
- Branches are staged, tested, rebased
- Merged to internal main before pushing to public

## The Problem (as of 2026-08-05)

| Issue | Location | Status |
|-------|----------|--------|
| **sos-public-kernel on dirty feature branch** | `/home/mumega/sos-public-kernel` | UNCLEAN — branch `feat/s3-brain-memory-port-k1` has uncommitted changes, remote branch is gone; serves as immutable deploy truth but is mutable |
| **Internal main behind feature branch** | `/mnt/HC_Volume_104325311/SOS` main branch | RED — 3 commits behind `kasra/roster-routing-live-2026-08` which holds routing fixes + security sweep + incident docs |
| **Deploy-to-VPS gated** | CI/CD | SKIPPED — cannot ship internal main while main is RED and behind feature work |
| **Routing fixes uncommitted** | `kasra/roster-routing-live-2026-08` | ✓ COMMITTED (7e8ee896) but not yet on main |

### Files Needing Merge to Main

From `kasra/roster-routing-live-2026-08` (3 commits ahead of main):

```
CHANGELOG.md                            — security work + fixes logged
deploy/systemd/security-sweep.*         — background credential exposure scanner
scripts/security-sweep.py               — scanner implementation
sos/services/bus/delivery.py            — live agent routing corrections
sovereign/factory_watchdog.py           — watchdog stability fix
docs/incidents/2026-08-03-public-bus-token-exposure.md — incident record
```

## The Fix (Required)

1. **Merge feature branch into internal main:**
   ```bash
   cd /mnt/HC_Volume_104325311/SOS
   git checkout main
   git merge kasra/roster-routing-live-2026-08 -m "merge: routing fixes + security sweep + incident docs"
   ```

2. **Verify internal main is clean and tests pass:**
   ```bash
   git status          # must be clean
   make test           # or pytest, depending on project
   ```

3. **Update sos-public-kernel to stable state:**
   ```bash
   cd /home/mumega/sos-public-kernel
   # rebase onto origin/main or reset to a stable commit
   git checkout main
   git reset --hard origin/main
   # or identify the last-known-good commit and reset to it
   ```

4. **Verify the worktree is clean:**
   ```bash
   git status  # must be clean (no M, ?, uncommitted)
   ```

## Data Flow

```
GitHub (Mumega-com/sos)  ← authoritative source, PR-reviewed
         ↓
mumega-sos-internal      ← dev staging, test bed
         ↓
sos-public-kernel        ← live worktree, immutable deploy state
         ↓
Service restart          ← applies code
         ↓
MCP SSE daemon           ← runs sos/mcp/sos_mcp_sse.py
```

## What "GREEN" Means

- **Internal main is GREEN:** main branch is clean, tests pass, no uncommitted changes
- **sos-public-kernel is GREEN:** HEAD points to a tested commit on main (not a feature branch), worktree is clean
- **Authoritative path is GREEN:** code flows public → internal → live without copying files, every step is reviewed

## Unblocking Changes

This document unblocks:
1. PR #211 (Mumega-com/sos) — routing fixes merged to public
2. sos#215 (internal incident) — security sweep committed
3. 5+ downstream changes waiting for stable deploy path

Once internal main is merged and sos-public-kernel points to a stable commit, all pending changes can flow through the standard path without ambiguity.

## Next Steps (delegated to human gate)

1. Verify the feature branch commits are correct and safe
2. Merge feature branch into internal main
3. Reset sos-public-kernel to a clean, tested state
4. Confirm all tests pass
5. Mark sos#193 as DONE

---

**Document owner:** Kasra (build lane)  
**Written:** 2026-08-05  
**Authority:** Substrate map + source inspection  
**Safety:** Do NOT copy files between trees; use standard git workflow (merge/rebase)
