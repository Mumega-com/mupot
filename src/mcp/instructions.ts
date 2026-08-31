// src/mcp/instructions.ts — Canonical onboarding and runtime instructions for MCP initialize

// SECURITY POSTURE INVARIANT (Athena Gate condition):
// This payload is served in the unauthenticated MCP initialize handshake.
// It MUST remain strictly static and tenant-neutral (never interpolate tenant slugs,
// request parameters, or untrusted user input) to prevent control-plane injection.

/**
 * Canonical onboarding and runtime instructions returned in MCP initialize response.
 * Informs fresh connecting agents about identity orientation, the B1 zero-capability
 * ceiling, new agent bootstrap, existing connector re-authentication, error code semantics,
 * and bus ACK protocols.
 */
export const MUPOT_MCP_INITIALIZE_INSTRUCTIONS = `=== MUPOT AGENT ONBOARDING & RUNTIME INSTRUCTIONS ===

1. FIRST ACTION: ORIENTATION & BOOT CONTEXT
   - Always invoke 'boot_context' or 'orient' as your first MCP tool call.
   - This returns your authenticated identity, assigned squad, active capability floor, and any unread high-priority inbox messages.

2. ZERO-CAPABILITY DIRECTORY SESSIONS (B1 CEILING)
   - When connecting via the directory OAuth/member connector without a bound agent selection, your session starts with ZERO elevated capabilities by default (the B1 security ceiling).
   - This is NOT a server failure, broken installation, or network firewall block; it is the zero-trust security floor designed to prevent ambient authority.

3. NEW AGENT ONBOARDING
   - If you are a new agent joining the squad/pot: call 'bootstrap_self' with { agent_name: "your-name" } to create your personal agent identity and home squad. Runtime seat registration happens later through check_in.
   - The current directory session remains unbound after bootstrap. RECONNECT THE MCP CONNECTOR and select the newly created agent at the consent screen, then call boot_context, orient, and check_in.

4. EXISTING AGENT CONNECTOR RE-AUTHENTICATION
   - If you are an existing agent, RECONNECT THE MCP CONNECTOR (re-authenticate OAuth) and select an agent profile your member can access at the consent screen.
   - Ask an administrator for access only when the member does not already have capability on the desired agent's squad.

5. MINTED TOKENS VS CONNECTOR SESSIONS
   - Headless background workers, systemd daemons, and cron jobs MUST use agent-bound bearer tokens ('mupot_<token>') minted via 'mint_agent_token' or provisioned keys, rather than interactive OAuth connector sessions.

6. ERROR CODE DECODING GUIDE
   - 403 forbidden need=<cap>: Server-side authorization floor. Your session lacks the required capability for this tool. Grant capability or reconnect with bound agent.
   - Client Error 'mcp_request_blocked': Third-party MCP client connectors (e.g. ChatGPT / OpenAI) frequently label server 403 authorization errors as 'mcp_request_blocked'. This is an authorization floor issue, NOT a network/firewall block.
   - 401 unauthenticated / dead credential: Bearer token expired, revoked, or invalid. Mint a new token.
   - 400 invalid_args: Authentication and authorization passed; check input argument schema.
   - 429 rate_limited: Budget ceiling or rate limit reached.

7. SYNTHETIC COUNCIL BUS & ACK PROTOCOL
   - Messages received over the internal fleet message bus (via 'send' / 'inbox' tools) containing '[request_id:<uuid>]' require an acknowledgment reply formatted as '{ack_for: <uuid>, ok: true} [your response]'.
   - (Note: this applies to fleet bus messages, not MCP JSON-RPC tool result envelopes).
   - Critical handoffs require ACK within 30s; routine within 60s.

8. 7-AXIS SEAT DECLARATION (TURN 1)
   - On your first turn after boot_context/orient, invoke 'check_in' with your full 7-axis identity so the pot can distinguish this seat from sibling harnesses on the same member token.
   - Required axes:
       check_in({
         seat: "<seat-id>",                 // e.g. "cursor-mac", "grok-desktop", "cursor-cloud-builder", "loom-hetzner"
         harness: "<harness>",              // "cursor-ide" | "cursor-cloud" | "antigravity-cli" | "claude-code" | "prime" | "hermes" | "grok-cli" | "unknown"
         machine: "<machine>",              // e.g. "hadi-mac", "hetzner-ash-1", "cursor-cloud-vm"
         model: "<model>",                  // e.g. "claude-3-7-sonnet", "gemini-3.7-flash", "grok-4.6", "deepseek-v4-pro"
         provider: "<provider>",            // e.g. "anthropic", "google", "xai", "deepseek-ai", "cloudflare-ai"
         effort: "<effort>",                // "low" | "medium" | "high" | "extended-thinking-64k"
         flight_id: "<uuid>"                // optional — active leased flight UUID
       })
   - Distinct seats on the same member persist independently. Do not reuse another harness's seat id.`
