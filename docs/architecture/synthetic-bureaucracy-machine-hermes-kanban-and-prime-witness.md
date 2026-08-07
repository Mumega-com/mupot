# Architecture Spec: The Synthetic Bureaucracy Machine — Hermes Kanban Embedding & Prime Witness Engine

**Authors:** River (`agent:river`) & Hadi (`kayhermes`)  
**Target Architecture:** Mupot v0.28.0+ / Hermes Agent Portal / `brainPrime` Witness  
**Date:** 2026-08-07  
**Status:** **[PRE-FLIGHT SPEC — SYNTHETIC BUREAUCRACY MACHINE]**  

---

## 1. Executive Summary

This architecture specification defines **The Synthetic Bureaucracy Machine** — a scale-to-zero, multi-harness operational engine combining three core systems:

1. **Embedded Hermes Kanban Board (`/dashboard/kanban`):** Safely embedding the battle-tested Hermes Agent Portal Kanban Board directly into Mupot's dashboard via secure iframe / relay seam, eliminating redundant board engineering.
2. **Multi-Harness Squad Orchestration:** Empowering squads composed of heterogeneous agents across different harnesses (**Subagents**, **Headless Agents** like `prime`, **Hermes**, **OpenWebUI**, **Cursor**, and **Claude Code**) to claim and execute squad tasks on the shared board.
3. **Prime as the Witness Agent (`agent:prime`):** Positioned as the automated **Witness & First-Pass Evidence Adjudicator** ($0.14/M input on `deepseek-v4-flash`). Prime verifies empirical file:line evidence before cards transition to review or merge.

---

## 2. System Topology & Information Flow

```
                               ┌───────────────────────────┐
                               │    kayhermes (Telegram)   │
                               │  Human Board Directives   │
                               └─────────────┬─────────────┘
                                             │
                                             ▼
                               ┌───────────────────────────┐
                               │   Hermes Kanban Board     │
                               │ (Embedded /dashboard/kanban)
                               └─────────────┬─────────────┘
                                             │
                                             ▼ (Card Moved to Review)
                               ┌───────────────────────────┐
                               │  Prime (Witness Agent)    │
                               │  Verifies File:Line & CI  │
                               │  Tags: WITNESSED / UNPROVEN
                               └─────────────┬─────────────┘
                                             │ (If WITNESSED)
                                             ▼
                               ┌───────────────────────────┐
                               │  Heavy Oracle Gating      │
                               │  (Kasra & Athena Merge)   │
                               └───────────────────────────┘
```

---

## 3. Key Components

### 3.1 Embedded Hermes Board Seam (`src/dashboard/kanban.ts`)
- **Route:** `GET /dashboard/kanban`
- **Mechanism:** Serves a secure, framed seam connected to the Hermes agent portal Kanban API (`/connectors/hermes`).
- **Capabilities:** Displays `P0`–`P3` priority columns, squad tags (`mcpwp_cairn`, `viamardm`, `viamarapp`), and live card status.

### 3.2 Heterogeneous Multi-Harness Squads
- **Harness Agnostic:** A task card can be claimed by an agent from any harness:
  - **Mupot Subagents:** `river-code`, `river-copywriter`
  - **Headless Agents:** `prime` on `deepseek-v4-flash`
  - **Hermes / OpenWebUI Agents:** `kayhermes`, `vps-hermes-mumcp`
  - **Tmux / Claude Code:** `kasra`, `codex`
- **Scale-to-Zero Workers:** Non-security operator tasks run 24/7 on `deepseek-v4-flash` / Cloudflare Workers AI.

### 3.3 Prime as the Witness Agent ("witness :D")
- **Role:** Prime (`agent:prime`, `deepseek-v4-flash`) monitors card state transitions on the board.
- **Evidence Verification:** When a squad member moves a task card to `Review`:
  1. Prime inspects git diffs, Vitest test outputs, and line-level claims.
  2. If evidence is complete: Prime posts `witnessed: true, verdict: PASS` and attaches the receipt.
  3. If evidence is incomplete or unverified: Prime marks `verdict: UNPROVEN`, highlighting the exact missing proof.

---

## 4. Implementation Steps

1. **Phase 1 (Dashboard Route):** Add `GET /dashboard/kanban` in `src/dashboard/index.ts` mounting the Hermes Kanban iframe seam.
2. **Phase 2 (Witness Hook):** Wire `prime-responder.py` to listen for `task.review` events on the board.
3. **Phase 3 (Squad Cutover):** Assign `mcpwp_cairn` and `viamar` squads to the shared board running on `deepseek-v4-flash`.

$$dS + k^* d(\ln C) = 0$$
