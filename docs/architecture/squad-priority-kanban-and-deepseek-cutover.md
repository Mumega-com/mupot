# Roadmap Spec: Priority Kanban Board & DeepSeek Operator Squad Cutover

**Authors:** River (`agent:river`) & Hadi (`kayhermes`)  
**Target Architecture:** Mupot v0.28.0+ / `brainPrime` CEO / Cloudflare Workers AI  
**Date:** 2026-08-07  
**Status:** **[ROADMAP SPEC — OPEN FOR SQUAD CUTOVER]**  

---

## 1. Executive Summary

This roadmap specification addresses two critical operational bottlenecks in the Mumega ecosystem:

1. **Lack of Priority-Based Kanban Engine:** `brainPrime` (the CEO) requires a structured, priority-ranked Kanban board (`P0`, `P1`, `P2`, `P3`) in D1/Mupot to automatically group backlog items into **Squads** and dispatch execution.
2. **Squad Stalls Due to Codex Quota Lock:** Specialized operator squads (such as `mcpwp_cairn` for WordPress GTM, `viamardm`, `viamarapp`, and `mkt-content`) are currently stalled because they were hardcoded to heavy Codex/Claude models. 
   - **The Fix:** Migrate all non-security operator squads to **`deepseek-v4-flash` / Cloudflare Workers AI** ($0.14/M tokens, $0 idle compute). They run 24/7 on content, social graphics, docs, and site updates, while security gating remains strictly enforced by Athena & Kasra.

---

## 2. Priority-Based Squad Kanban Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                   brainPrime CEO (Kanban Orchestrator)                 │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
       ┌────────────────────────────┼────────────────────────────┐
       ▼                            ▼                            ▼
┌──────────────┐             ┌──────────────┐             ┌──────────────┐
│  P0 (Urgent) │             │ P1 (Priority)│             │ P2 (Squads)  │
│ Security/CI  │             │ Features/PRs │             │ GTM / Content│
└──────┬───────┘             └──────┬───────┘             └──────┬───────┘
       │                            │                            │
       ▼                            ▼                            ▼
┌──────────────┐             ┌──────────────┐             ┌──────────────┐
│ Kasra / Heavy│             │  River / DO  │             │ DeepSeek / CF│
│ Oracle Gates │             │  Addons      │             │ Operator Squads│
└──────────────┘             └──────────────┘             └──────────────┘
```

### 2.1 Priority Column Definitions

- **P0 (Emergency & Security):** Credential leaks, broken CI, security path-denies. Gated by Kasra & Athena.
- **P1 (Core Features & PRs):** Addon routes, D1 migrations, Mupot runtime features. Gated by River & Sonnet 4.6.
- **P2 (Operator Squads — DeepSeek Powered):** `mcpwp_cairn` (WordPress GTM), `viamardm`, `viamarapp`, social media graphics, blog posts, site updates. Runs 24/7 on `deepseek-v4-flash`.
- **P3 (Backlog & Experiments):** Low-priority exploration, deferred bounties.

---

## 3. Operator Squad Cutover (`mcpwp_cairn`, `viamar`)

### 3.1 `mcpwp_cairn` (WordPress Plugin GTM Squad)
- **Problem:** Stalled on Codex quota limits despite being our go-to-market engine for WordPress integration (`mcpwp`).
- **Solution:** Cut over model substrate to `deepseek-v4-flash` on Cloudflare Workers AI.
- **Scope:**
  - Generating social media graphics and promotional copy.
  - Updating `mcpwp` documentation and landing page.
  - Automated weekly release posts.
- **Security Boundary:** All PRs and code pushes remain read-only/branch-only until Athena & Kasra verify gates.

### 3.2 `viamardm` & `viamarapp` (Viamar Squads)
- **Solution:** Cut over from heavy models to `deepseek-v4-flash`.
- **Scope:** Direct UX improvements, FAQ updates, content polishing, and marketing assets.

---

## 4. Immediate Action Items & Issues

1. **Issue 1:** Create `mupot` Priority Kanban D1 table column (`priority: P0|P1|P2|P3`) and API routes (`/api/kanban`).
2. **Issue 2:** Re-bind `mcpwp_cairn` squad runner to `deepseek-v4-flash` ($0.14/M) to resume WordPress GTM automation.
3. **Issue 3:** Re-bind `viamardm` and `viamarapp` squads to Cloudflare Workers AI.

$$dS + k^* d(\ln C) = 0$$
