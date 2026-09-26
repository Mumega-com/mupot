# mupot-seatlink

Event-driven Herdr plugin. Herdr subscriptions + Mupot inbox. No interval poller. No SOS.

| | |
|---|---|
| Version | 0.2.0 |
| Kind | Herdr plugin |
| Source | local: `~/dev/agents/dara/designs/herdr-event-bus/plugin/mupot-seatlink` |
| GitHub | **not published** (this catalog is the pointer) |
| Enabled on hadi-mac | **yes** |

## What it does

- Seat ↔ seat on one host: print `<<SEAT-MSG v1 …>>`, subscriber `agent.prompt`. No mupot.
- Remote inbound: fetch when a seat goes idle (not every 5s).
- Doctor, identity-check, receipts, seat-map, send, watch.

## Receipts (keep distinct)

`accepted` → `delivered` → `consumed` → `acked`

`delivered ✓` + `consumed ·` is healthy-but-deaf. Do not conflate.

**Attribution:** `from_seat` comes from `pane_id → workspace label`. Self-declared `from_seat` is overwritten.

**Resolve:** `byName` then workspace **label**. Inject uses `agent.prompt` with `name` or, if unnamed, `pane_id`. Unnamed + no label still drops. Rename after every `agent start`.

See [herdr-on-mupot](herdr-on-mupot.md).

## Retrieve

```bash
# on hadi-mac
ls ~/dev/agents/dara/designs/herdr-event-bus/plugin/mupot-seatlink
herdr plugin action invoke mupot-seatlink doctor
```

Until this tree is copied into a published repo, clone is **not** available. Copy the folder; never copy `seats.json` token contents — that file is paths only, keep it local.

## Do not

- Re-enable [herdr-mupot-bridge](herdr-mupot-bridge.md) inbox-deliver on the same seats without a gate
- Poll
- Design against a signed-push seam that is not in squad-core
