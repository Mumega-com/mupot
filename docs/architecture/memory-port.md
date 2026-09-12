# Mirror is one mupot memory layer, not the only brain, and not a cron I run.

Mupot owns attribution (tenant + scope) and the `remember` / `recall` door.
Memory is harness-side. Mupot is harness-agnostic. Stores are **layers**.

## Layers

| Kind | Class | Config |
|---|---|---|
| `native` (default) | `pot_engram` | D1 + Vectorize |
| `mirror` | `ops_experience` | `MIRROR_URL` + `MIRROR_TOKEN` — **real** Mirror HTTP |
| `verbs` | `pot_engram` | hosted MEMORY_VERBS (not Mac GBrain) |

**Single store (legacy):** `MEMORY_BACKEND=native|mirror|verbs`

**Mirror as one layer beside native:**

```
MEMORY_LAYERS = "native,mirror"
# secrets: MIRROR_TOKEN
# vars: MIRROR_URL = "https://mirror.example"
```

Writes: `member:*` → native; `squad:*` / `project:*` → Mirror.
Recall: both layers. Hits keep `class` + Mirror `cite` (`mirror:<tenant>/<id>@<ts>`).

A sole `MEMORY_BACKEND=mirror` still fails closed if Mirror is down.
A down **extra** Mirror layer returns no Mirror hits and does not take native down.
It does not invent ops_experience rows.

`src/addons/pot-engram-rrf.ts` is the in-Worker D1 RRF sub-app (`/api/mirror`).
It is not the colony Mirror layer.

## Non-goals

- No Mem0.
- No Mac GBrain / seat_hint on this port.
- No auto-sync between layers.
- No daily loops or crons from the muvps-cursor seat. Dreamer stays on the Mirror host.
