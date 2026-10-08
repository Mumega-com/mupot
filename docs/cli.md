# `mupot` command-line client

One file, no npm dependencies, Node >= 20. It talks JSON-RPC to the pot's MCP endpoint
(`<api>/mcp`), so humans, cron, Orca/Herdr plugins and Codex agents can drive mupot from a shell
without loading ~200 MCP tool schemas into a model's context.

Source of truth: `cli/mupot.mjs`. The pot serves the exact bytes at `GET /cli`
(public, unauthenticated, `X-Content-SHA256` header, `Cache-Control: public, max-age=300`).

## Install

```bash
mkdir -p ~/.local/bin
curl -fsSL https://mupot.mumega.com/cli -o ~/.local/bin/mupot && chmod +x ~/.local/bin/mupot

# verify: the hash the server advertised must equal the hash the file reports about itself
curl -fsSI https://mupot.mumega.com/cli | grep -i '^x-content-sha256'
mupot --version        # mupot 0.1.0 sha256:<same hex>
```

If the two hashes differ, delete the file. (`GET /cli` only proves the bytes match what that pot
serves; pin the hash in your provisioning if you need more than that.)

The file is also runnable straight from a checkout: `node cli/mupot.mjs ...`.

## Auth

The token is read from, in order:

1. the file named by `$MUPOT_TOKEN_FILE`
2. the `token_file` of the selected pot in `~/.config/mupot/config.json`
3. `~/.config/mupot/<pot>.token`
4. the env var `MUPOT_TOKEN`

Rules the CLI enforces:

- **A token is never accepted as an argument** (`--token`, `--bearer`, `--authorization`, ... are
  refused, exit 2): argv is readable by every local user through `ps` and `/proc`.
- A token file that is group- or world-accessible (`mode & 0o077`) is **refused** with a
  `chmod 600` hint. Use `chmod 600 ~/.config/mupot/mumega.token`.
- The token is never printed, including in errors: all stdout/stderr is redacted against every
  secret the process loaded, even if a server echoes it back.
- Redirects are never followed with the bearer (`redirect: 'manual'`; any 3xx is an error, exit 4).
- A non-https `--api` is refused (loopback `http://127.0.0.1` is allowed for local dev).

`mupot tools` and `mupot help` work without a token (tools/list is public on the server).

## Pots and profiles

`~/.config/mupot/config.json`:

```json
{ "pots": { "mumega": { "api": "https://mupot.mumega.com", "token_file": "/home/me/.config/mupot/mumega.token" } },
  "default": "mumega" }
```

`--pot <name>` selects a profile, `--api <url>` overrides its API. With no config the default is
pot `mumega` at `https://mupot.mumega.com`. A pot name with no `api` in the config needs `--api`.

## Commands

```bash
mupot tools [filter]                    # live tool names + descriptions (cached 1h in ~/.cache/mupot/; --refresh)
mupot help <tool>                       # that tool's input schema
mupot <tool> --key value ...            # call any tool
mupot <tool> --json-args '{"a":1}'      # raw args ('-' reads JSON from stdin); flags override keys
mupot call <tool> ...                   # explicit form (when a tool name equals a shortcut)
mupot agent-context                     # machine-readable JSON description of the CLI, for agents
mupot --version
```

Flags are coerced from the tool's `inputSchema`: numbers and integers are parsed, booleans take
`--flag`, `--flag false` or `--no-flag`, arrays take repeated flags or a comma list (or a JSON
array), objects take a JSON string. Dashes in a flag name map to underscores (`--done-when`).

Shortcuts (thin aliases; each target tool and arg is checked against `src/mcp` by a test):

| Shortcut | Calls | Notes |
|---|---|---|
| `status` | `boot_context` | note: boot_context records a presence touch for the seat |
| `whoami` | `status` (no `agent_id`) | principal, capabilities, seat |
| `inbox [--peek]` | `inbox` | without `--peek` messages are consumed per server semantics |
| `ack <id...>` | `inbox_ack { ids }` | |
| `send <to> <text...>` | `send { to, body }` | |
| `task list` / `task get <id>` / `task new <title> --done-when ...` | `task_list` / `task_get` / `task_create` | `task new` is a write |
| `capacity` | `harness_capacity_list` | |

## Output and exit codes

Human-readable by default. `--json` writes only the raw tool result (the MCP `structuredContent`)
as JSON to stdout. Errors always go to stderr (with `--json`, a tool error is a JSON object on stderr).

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | tool error (`isError`), JSON-RPC error |
| 2 | usage error |
| 3 | auth: HTTP 401/403, or a missing/unusable token (absent, empty, bad mode) |
| 4 | network: unreachable, timeout, redirect, or 5xx without a JSON-RPC body |

## Examples

```bash
export MUPOT_TOKEN_FILE=~/.config/mupot/mumega.token
mupot whoami
mupot inbox --peek --json | jq '.messages[].id'
mupot task list --status open --limit 10
mupot send athena "gate request for PR 1766"
mupot capacity --harness orca --json
echo '{"title":"x","done_when":"y"}' | mupot task_create --json-args -
```

## Maintainers

`src/cli/bundle.generated.ts` embeds the file for `GET /cli` (the repo has no wrangler text-module
rule). After editing `cli/mupot.mjs` run `npm run gen:cli-bundle` and commit the result; CI runs
`scripts/check-cli-bundle-fresh.mjs` and `tests/mupot-cli-route.test.ts` fails if it drifts.
`cli/mupot.mjs` must stay ASCII-only so the served bytes equal the file bytes under any decoding.
Bump `VERSION` in the file when behavior changes.
