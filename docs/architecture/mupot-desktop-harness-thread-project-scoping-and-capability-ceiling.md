# Architecture Spec: Desktop Harness Thread/Project Scope Scoping & Capability Ceiling

**Canonical ID:** `MU.714.001`  
**Authors:** River (`agent:river`), Asha (`e211b0fb`), & Hadi (`kayhermes`)  
**Target Architecture:** Mupot v0.28.0+ / Security & Auth Engine  
**Date:** 2026-08-07  
**Status:** **[CANONICAL SPEC — THREAD/PROJECT CAPABILITY CEILING]**  

---

## 1. Executive Summary: Thread/Project Scope Scoping

Desktop AI harnesses (Claude Desktop, ChatGPT Desktop, Hermes Desktop, Cursor Desktop) operate in specific workspace folders or chat threads corresponding to single projects or squads.

This specification establishes **Thread/Project Scope Scoping & Capability Ceiling Protocol**:
When an agent session boots via `boot_context` or `connect { project_id: "<id>" }`, Mupot dynamically calculates the **Capability Intersection**:

$$\text{Effective Session Authority} = \text{Member Grants} \cap \text{Thread/Project Scope Ceiling}$$

Even if a member holds `org:owner` or `admin` at the enterprise level, a thread bound to `project-dme` receives **ONLY write capabilities within `project-dme`**, guaranteeing zero cross-project data leakage.

---

## 2. Desktop Harness Architecture Topology

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Desktop Harness Thread / Folder (Claude Desktop / Cursor / Hermes / ChatGPT)          │
│ Bound Project: "project-dme"                                                           │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │
                                            │ OAuth / MCP Connection (`boot_context`)
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ MUPOT AUTHENTICATION ENGINE                                                            │
│                                                                                        │
│ 1. Member Identity Lookup: mem-hadi (Holds org:owner)                                  │
│ 2. Thread Scope Claim: project_id = "proj-dme-123"                                     │
│ 3. Compute Intersection:                                                               │
│    Capabilities = intersect(member_grants, project_grants)                             │
│                                                                                        │
│ Result: Effective Session Capabilities = ["member", "write"] ONLY on "proj-dme-123"   │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ STRICT ISOLATION GUARANTEE                                                             │
│ - Reads/Writes to proj-dme-123  ──> 200 OK                                             │
│ - Reads/Writes to proj-other-999 ──> 403 Refused ("outside thread project ceiling")    │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Substrate Invariants & Implementation Seams

1. **`connect { project_id / project_slug }` Option:**
   - Any client calling `connect` can supply `project_id` or `project_slug`.
2. **Dynamic Capability Filtering (`src/auth/capability.ts`):**
   - If `project_id` is supplied, `resolveCapabilities` filters the member's latent capabilities down to only those matching `scope_type = 'project'` and `scope_id = project_id`.
3. **Fail-Closed Ceiling:**
   - Attempting to access resources outside the bound `project_id` returns `403 Refused: project_scope_ceiling_exceeded`.

---

## 4. Backlog Task & Flight Details

- **Task ID:** `task-714-desktop-thread-scoping`
- **Backlog Issue:** `Mumega-com/mupot#793`
- **Priority:** High / Architecture Flight
- **Flight Reviewer:** Asha (`e211b0fb` / qNFT `375a9d13`)

$$dS + k^* d(\ln C) = 0$$
