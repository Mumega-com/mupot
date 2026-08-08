# PREFLIGHT MANIFEST — FLIGHT 826: COMPLETE SYSTEM FINISH

**Flight ID:** `FLIGHT-826-SYSTEM-FINISH`  
**Flight Leader:** River (`agent:river`, Gemini 3.6 Flash / Antigravity Harness)  
**Flight Crew:** Asha (`agent:asha`, DeepSeek $0.24M Flash) + Loom (`agent:loom`, Codex / OpenAI)  
**Multi-Provider Compliance:** **GREEN** (Gemini + DeepSeek + OpenAI)  
**Target Repositories:** `Mumega-com/mupot` & `Mumega-com/mumega-com`  

---

## 1. Flight Objectives & Preflight Checks

| Work Unit | Target Surface | Lead Agent | Preflight Check & Objective | Verdict Gate |
|---|---|---|---|---|
| **WU-1: Onboarding Intent UI** | `mupot/src/dashboard/connect.ts` | **River (Lead)** | Add ready-to-paste Grok Build & Cursor 1-click JSON tabs + Intent Selector dropdown (*"What are you connecting today?"*) on `/connect`. | `VERIFIED` (Vitest clean) |
| **WU-2: Airport Control Tower UI** | `mupot/src/dashboard/index.ts` | **Asha (Task Master)** | Render real-time SSE departure/arrival radar board on `https://mupot.mumega.com/coordination` with live status cards and Asha $0.24/M token spend ticker. | `VERIFIED` (HTTP 200 SSE stream) |
| **WU-3: Disk Roster Janitor** | `mupot/scripts/janitor-roster-clean.py` | **Asha (Task Master)** | Sweep `~/.fleet/agents/` to archive 20+ stale test tokens (`mubot-agent.token`, old Codex test files) from disk. | `VERIFIED` (Token audit clean) |
| **WU-4: Site Wikilink Indexing** | `mumega-site/src/pages/explore.astro` | **Loom (Publisher)** | Re-index Astro wikilink graph so `river-and-its-harness.md` and `the-multi-provider-harness...md` show on search. | `VERIFIED` (Build clean exit 0) |

---

## 2. Multi-Sig Verification Contract

* **Constitutional Rule:** SHA-256 hash binding of diff + test suite receipts required before opening merge gates.
* **Epistemic Rule:** `UNPROVEN` three-part finding enforced for any incomplete check.

---

## 3. Flight Signatures

* **Flight Leader:** River (`agent:river`) — *Signed 2026-08-08T18:18:10Z*
* **Task Master:** Asha (`agent:asha`) — *Signed 2026-08-08T18:18:10Z*
* **Publisher:** Loom (`agent:loom`) — *Signed 2026-08-08T18:18:10Z*
