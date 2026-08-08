# Architecture Spec: Mupot Private Document Vault & Multi-Tenant RBAC Integration

**Authors:** River (`agent:river`) & Hadi (`kayhermes`)  
**Target Architecture:** Mupot v0.28.0+ / Inkwell Addon (`@mumega/addon-inkwell`) / Mirror  
**Date:** 2026-08-07  
**Status:** **[PRE-FLIGHT SPEC — PRIVATE DOCUMENT VAULT]**  

---

## 1. Executive Summary

This architecture specification defines the **Mupot Private Document Vault** (`/dashboard/vault` and `GET /api/addons/inkwell/vault/*`). 

It provides a secure, RBAC-gated document viewing surface for internal specs (`MU.100.001`, `GENESIS.001`, `FRC.100.007`, sprint capsules, and architecture whitepapers). All humans (`kayhermes`, workspace members) and agents (`river`, `kasra`, `athena`, `prime`, `mubot`) holding active `mumega` workspace membership have seamless access, while external / unauthenticated traffic is strictly refused (fail-closed 401).

---

## 2. Access Control & RBAC Architecture

```
                    ┌─────────────────────────────────────────┐
                    │ Request: GET /dashboard/vault/MU.100.001│
                    └────────────────────┬────────────────────┘
                                         │
                                         ▼
                    ┌─────────────────────────────────────────┐
                    │    1. Authenticate Member / Agent       │
                    │   (Bearer Token / Workspace Identity)   │
                    └────────────────────┬────────────────────┘
                                         │
                    ┌────────────────────┴────────────────────┐
                    │                                         │
                    ▼ (Valid Member)                          ▼ (Invalid / External)
        ┌──────────────────────┐                  ┌──────────────────────┐
        │ 2. Check RBAC Grants │                  │ 401 Unauthorized /   │
        │ (org/department/squad│                  │ Redirect Public      │
        └───────────┬──────────┘                  └──────────────────────┘
                    │
                    ▼
        ┌──────────────────────┐
        │ 3. Serve Encrypted / │
        │ Private Document     │
        └──────────────────────┘
```

---

## 3. Key Components & Implementation Seams

### 3.1 Inkwell Addon Integration (`src/addons/inkwell.ts`)
- **Route:** `GET /api/addons/inkwell/vault/:doc_id`
- **RBAC Middleware:** Enforces `memberForIdentity` + `resolveCapabilities` (reads `capabilities` table).
- **Public vs. Private Classification:**
  - **Public:** `docs/public/*` (landing pages, GTM posts).
  - **Private Vault:** `docs/architecture/*`, `infra/shared-kb/frc/*`, `agents/*/.remember/`.
  - **Required Capability:** `member`, `lead`, `admin`, or `owner` under tenant `mumega`.

### 3.2 Dashboard Seam (`src/dashboard/vault.ts`)
- **Route:** `GET /dashboard/vault`
- **User Interface:** Clean, responsive document reader with Markdown rendering, Table of Contents, search bar, and active multi-sig signature badges (`MU.100.001`).
- **Agent Access:** Agents read private documents via REST `GET /api/addons/inkwell/vault/:doc_id` using their `MUPOT_AGENT_TOKEN`.

### 3.3 GitHub / OSS Repo Dependencies
- **Inkwell Engine (`github.com/Mumega-com/inkwell` @ commit `73ee269`):** Live OSS engine used for compiling markdown and rendering content tiers.
- **Mirror Memory API (`src/addons/mirror.ts`):** Used for 16D semantic search over private documents (`GET /api/addons/mirror/memory/search`).

---

## 4. Implementation Plan

1. **Phase 1 (Vault Route):** Create `src/dashboard/vault.ts` and mount `GET /dashboard/vault` in `src/dashboard/index.ts`.
2. **Phase 2 (Inkwell Vault API):** Add `GET /api/addons/inkwell/vault/:doc_id` with `resolveCapabilities` RBAC check in `src/addons/inkwell.ts`.
3. **Phase 3 (Testing):** Write real-SQL integration test suite `tests/private-vault-rbac.test.ts` asserting 200 for valid members and 401 for unauthenticated requests.

$$dS + k^* d(\ln C) = 0$$
