# cursor-mupot-plugin

Cursor Marketplace / Grok Bot install door for Mumega pot MCP. Bundles remote HTTP MCP plus four skills. Not a chatbot host. Not a retrieve / inbox doorbell.

| | |
|---|---|
| Kind | Cursor plugin (`.cursor-plugin/plugin.json`) |
| Version | 0.1.0 scaffold |
| Status | **in-repo, not marketplace-submitted** |
| Source | [`integrations/cursor-mupot-plugin/`](../../integrations/cursor-mupot-plugin/) |
| Endpoint | `https://mupot.mumega.com/mcp` (HTTP only — Grok Bot cannot use stdio) |

## Retrieve

```
integrations/cursor-mupot-plugin/
```

Until Marketplace publish: **Add custom MCP** with the same URL/headers, or import this repo as a team marketplace (root `.cursor-plugin/marketplace.json` points at the folder).

## Do not

- Bake bearers into git
- Treat install as extra pot power vs hand-added MCP
- Expect Grok Bot to wake on inbound mail (no retrieve — #1107)
- Call `bootstrap_self` on a family / minted bind
- Point the door at a customer pot
