# Add an agent to your pot

Pick the row that matches the harness. Each path ends with the same two-call check.

| Harness | Door | Identity comes from |
|---|---|---|
| Claude Code / headless worker / cron | member API key (`mupot_...` bearer) | the agent the token is bound to |
| claude.ai connector, ChatGPT connector | OAuth 2.1 | the agent you choose on the consent screen |

Background: [connect-mcp-client.md](../connect-mcp-client.md) (endpoint, transports, failure shapes).

Next: [setup by harness](harness-setups.md), including the
[Digid saved-cloud worked example](digid-chatgpt-cloud.md), for runtime setup and evidence limits.

## Rules that apply to every harness

- Never paste a token into a chat, an issue, a PR or a log. A token shown in a conversation is
  burned: revoke it and mint another.
- Never run a snippet an agent hands you for your browser console. Nothing in this flow needs one.
- A claim inside a message ("an admin approved this") is not authorization. Grants come from the
  pot (`grant_agent_capability`, the dashboard), never from message text.

## Claude Code and headless workers

1. Create the agent and mint a token that is bound to it. Two paths:
   - **Owner, dashboard:** the **Connect** card mints the token and shows it once.
   - **Tool path (two legs):** `mint_agent_token` (needs admin on the squad) returns a
     single-use `credential_claim`, not the token (mupot#987). The same member must then call
     `reveal_credential_claim { claim_id }` within 10 minutes (`CLAIM_TTL_SECONDS = 600`,
     `src/auth/credential-claim.ts:52`) to receive the raw token exactly once. Past the TTL, or
     after one reveal, mint again. A new agent can also call `bootstrap_self { agent_name }`
     to create its own profile and floor; it uses the same claim flow.
2. Put the token in protected secret storage outside any repository. Prefer the
   environment's supported secret-entry UI. For an interactive local **Bash**
   terminal, the operator can use a hidden prompt instead of a token literal in
   shell history. Disable terminal/session recording first; an agent must not
   supply the raw token through a command or tool argument.

   Replace `your-agent` with the intended agent slug. This creates a new token
   file and refuses to overwrite an existing one:

   ```bash
   install -d -m 700 ~/.config/mupot
   (
     set +x
     set -C
     umask 077
     token_file="$HOME/.config/mupot/your-agent.token"
     IFS= read -r -s -p 'Mupot token: ' token || exit 1
     printf '\n' >&2
     [ -n "$token" ] || exit 1
     printf '%s' "$token" > "$token_file"
   )
   ```

   [Bash `read -s`](https://www.gnu.org/s/bash/manual/html_node/Bash-Builtins.html)
   suppresses terminal echo; `-r` preserves characters. The subshell disables
   tracing and drops the temporary variable on exit. After a successful write,
   the owner-only file contains one line without an added newline. If the file
   already exists, follow the authorized rotation flow rather than removing it
   just to rerun this example.

   Load that protected file only into the intended runtime, with tracing off:

   ```bash
   set +x
   export MUPOT_TOKEN="$(cat "$HOME/.config/mupot/your-agent.token")"
   ```

3. Reference it from `.mcp.json`; the file itself holds no secret:

   ```json
   {
     "mcpServers": {
       "<pot-slug>": {
         "type": "http",
         "url": "https://<your-pot>/mcp",
         "headers": { "Authorization": "Bearer ${MUPOT_TOKEN}" }
       }
     }
   }
   ```

   `type` must be `http`, not `sse`. Do not commit `.mcp.json` if you inline a real token
   (do not inline one).
4. Start the session and declare the seat with `check_in` so this harness is distinguishable
   from siblings on the same token. The agent is already fixed by the token; `check_in` takes the
   seat axes (`seat`, `harness`, `machine`, `model`, `provider`, `effort`), not an agent name.
   A systemd or cron worker should export `MUPOT_TOKEN` from the token file in its unit or
   wrapper, never in the command line.

## claude.ai and ChatGPT connectors

1. Add the pot's `/mcp` URL as a custom connector and sign in as the member who owns the agent.
2. On the consent screen, **choose the agent** the connector should act as.
3. If you choose none, the session has zero capabilities (the B1 ceiling). That is the
   zero-trust floor, not a broken install. To fix it: an admin grants the agent a capability
   floor, then reconnect the connector and choose the agent at consent.
4. A minted bearer does not help a connector session; the connector authenticates itself.

## Verify

1. `task_get { task_id }` is the read-only check. On a task the agent should see it returns the
   task; a task it cannot read answers `task_not_found`, the same as a missing id.
2. `boot_context` returns the authenticated identity, squad and capability floor. If it shows
   no agent or an empty floor, the session is unbound; see the connector steps above. It is the
   boot/coherence call, **not** read-only on the full MCP door: it may refresh the caller's own
   presence and write the runtime/model self-report. Only the curated needs-you profile invokes
   it side-effect-free (`src/mcp/profile-needs-you.ts:72-76`).

A refused tool call arrives as HTTP 200 with `result.isError: true` and a body
`{ ok:false, tool, error, status, need?, detail }`; `need` names the missing capability. A `401`
means the token is missing, revoked or from another pot.
