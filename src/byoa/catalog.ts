// mupot — BYOA harness catalog (PURE).
//
// Slice 5 product surface: which famous harnesses we ship install packs for,
// how they attach (topology A/C), and the pack file payloads the dashboard/MCP
// return. Claude Desktop is docs-only (topology B, human Connector) — it is
// listed for discovery but never returned as a downloadable pack.
//
// Packs on disk under packs/<harness>/ MUST match the embedded files here
// (tests/byoa-catalog.test.ts asserts that). The Worker cannot read the repo
// filesystem at runtime, so the catalog is the deployable source of truth.

export type ByoaTopology = 'A' | 'B' | 'C'

export type ByoaCredential = 'bearer_token' | 'ed25519_key' | 'docs_only'

export interface ByoaPackFile {
  path: string
  content: string
}

export interface ByoaHarness {
  id: string
  label: string
  topology: ByoaTopology
  credential: ByoaCredential
  /** Relative pack directory under packs/ (empty when docs_only). */
  packDir: string
  /** When false, list/get pack tools refuse download (Claude Desktop). */
  shipPack: boolean
  summary: string
  files: readonly ByoaPackFile[]
}

const TOKEN_PLACEHOLDER = '<MUPOT_MEMBER_TOKEN>'
const POT_HOST_PLACEHOLDER = 'YOUR-POT.example.workers.dev'

function mcpHttpJson(serverKey: string): string {
  return `${JSON.stringify(
    {
      '//': `BYOA install pack — replace ${TOKEN_PLACEHOLDER}; never commit a real token.`,
      mcpServers: {
        [serverKey]: {
          type: 'http',
          url: `https://${POT_HOST_PLACEHOLDER}/mcp`,
          headers: {
            Authorization: `Bearer ${TOKEN_PLACEHOLDER}`,
          },
        },
      },
    },
    null,
    2,
  )}\n`
}

function codexToml(): string {
  return `# BYOA Codex CLI pack — merge into ~/.codex/config.toml
# Streamable-HTTP only (Codex does not support SSE for remote MCP).
# Export the env var with the show-once agent token (one line, no quotes).

[mcp_servers.mupot]
url = "https://${POT_HOST_PLACEHOLDER}/mcp"
bearer_token_env_var = "MUPOT_MCP_TOKEN"
# then: export MUPOT_MCP_TOKEN=${TOKEN_PLACEHOLDER}
`
}

function cursorMcpJson(): string {
  return `${JSON.stringify(
    {
      '//': `BYOA Cursor CLI pack — ~/.cursor/mcp.json or .cursor/mcp.json`,
      mcpServers: {
        mupot: {
          url: `https://${POT_HOST_PLACEHOLDER}/mcp`,
          headers: {
            Authorization: `Bearer ${TOKEN_PLACEHOLDER}`,
          },
        },
      },
    },
    null,
    2,
  )}\n`
}

const SHARED_RAILS = `# mupot BYOA rails

You are a governed agent on a mupot pot.

On start: \`boot_context\` then \`orient\` (or \`check_in\` on your project).
Work: \`task_list\` → claim → do the work → \`task_update\` landing at \`review\`.
Never merge, deploy, publish, or self-verdict. Gates and receipts stay on the pot.
`

function claudeCodeReadme(): string {
  return `# Claude Code — BYOA install pack (topology A)

1. Create agent → mint_agent_token (observer|member) → optional grant_agent_capability.
2. Copy \`.mcp.json.template\` → \`.mcp.json\`, set pot host, inject the show-once token.
3. Load \`SKILL.md\` into the agent skills path.
4. Headless dispatch: \`claude -p "<prompt>" --output-format stream-json\` (or the
   conformant \`runtime-adapter/v1\` driver). Land work at \`review\` — never merge/deploy.

See docs/byoa-customer-onboarding.md and docs/flock-harness-pack-contract.md.
`
}

function codexReadme(): string {
  return `# Codex CLI — BYOA install pack (topology A)

1. Create agent → mint_agent_token → optional grant_agent_capability.
2. Merge \`config.toml\` into \`~/.codex/config.toml\`. Export \`MUPOT_MCP_TOKEN\`.
3. Do **not** set SSE transport — Codex uses streamable-HTTP for \`url\`.
4. Headless: \`codex exec --sandbox workspace-write --json "<prompt>"\`. Land at \`review\`.

See docs/byoa-customer-onboarding.md.
`
}

function cursorReadme(): string {
  return `# Cursor CLI — BYOA install pack (topology A)

1. Create agent → mint_agent_token → optional grant_agent_capability.
2. Copy \`.mcp.json.template\` into \`~/.cursor/mcp.json\` (or project \`.cursor/mcp.json\`).
3. Optional craft: install ECC client-side (\`ecc install --target cursor\`) — not vendored here.
4. Headless: \`cursor-agent -p "<prompt>"\`. Land at \`review\`.

See docs/byoa-customer-onboarding.md and packs/cursor/ecc-operator/README.md.
`
}

function cursorBackgroundReadme(): string {
  return `# Cursor Background Agents — BYOA install pack (topology C)

Vendor-hosted cloud agent (beta). mupot launches via \`POST api.cursor.com/v1/agents\`,
the runtime attaches back over signed \`fleet-attach:v1\`, and completion arrives on the
HMAC webhook (\`statusChange\`) or poll.

## Credential

1. \`create_agent\` → \`mint_agent_token\` (welds identity; least-privilege squad grant).
2. Generate Ed25519 on the host; \`register_agent_key\` with the public \`x\` only.
3. Fill \`attach.env.template\` (never commit secrets).

Work always lands at \`review\`. Do not rely on API-spawned agents posting PR comments
until validated (known beta risk).

See docs/byoa-customer-onboarding.md.
`
}

function cursorBackgroundEnv(): string {
  return `# Topology C — Cursor Background Agents (never commit filled values)
MUPOT_ORIGIN=https://${POT_HOST_PLACEHOLDER}
MUPOT_AGENT_ID=<agent-uuid>
MUPOT_AGENT_TOKEN=${TOKEN_PLACEHOLDER}
CURSOR_API_KEY=<cursor-user-or-service-api-key>
CURSOR_WEBHOOK_SECRET=<hmac-secret>
# Private Ed25519 stays on host; only public x is registered via register_agent_key
`
}

function claudeManagedReadme(): string {
  return `# Claude Managed Agents — BYOA install pack (topology C)

Anthropic-hosted sandbox. Launch via Managed Agents REST; completion is **poll/SSE only**
(no webhook). Attach back over signed \`fleet-attach:v1\`.

## Credential

1. \`create_agent\` → \`mint_agent_token\`.
2. \`register_agent_key\` with host Ed25519 public \`x\`.
3. Fill \`attach.env.template\`.

Land at \`review\`. Beta: not eligible for ZDR/HIPAA BAA while in preview.

See docs/byoa-customer-onboarding.md.
`
}

function claudeManagedEnv(): string {
  return `# Topology C — Claude Managed Agents (never commit filled values)
MUPOT_ORIGIN=https://${POT_HOST_PLACEHOLDER}
MUPOT_AGENT_ID=<agent-uuid>
MUPOT_AGENT_TOKEN=${TOKEN_PLACEHOLDER}
ANTHROPIC_API_KEY=<anthropic-api-key>
# Private Ed25519 stays on host; only public x is registered via register_agent_key
`
}

/** Supported BYOA harness rows (topology A/C ship packs; B is docs-only). */
export const BYOA_HARNESSES: readonly ByoaHarness[] = [
  {
    id: 'claude-code',
    label: 'Claude Code CLI',
    topology: 'A',
    credential: 'bearer_token',
    packDir: 'claude-code/flock-agent',
    shipPack: true,
    summary:
      'Topology A — headless `claude -p` on customer infra; remote MCP via `.mcp.json` (type:http).',
    files: [
      { path: 'README.md', content: claudeCodeReadme() },
      { path: '.mcp.json.template', content: mcpHttpJson('mupot') },
      { path: 'SKILL.md', content: SHARED_RAILS },
    ],
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    topology: 'A',
    credential: 'bearer_token',
    packDir: 'codex/byoa',
    shipPack: true,
    summary:
      'Topology A — headless `codex exec` on customer infra; remote MCP via ~/.codex/config.toml (url + bearer_token_env_var, no SSE).',
    files: [
      { path: 'README.md', content: codexReadme() },
      { path: 'config.toml', content: codexToml() },
      { path: 'SKILL.md', content: SHARED_RAILS },
    ],
  },
  {
    id: 'cursor',
    label: 'Cursor CLI',
    topology: 'A',
    credential: 'bearer_token',
    packDir: 'cursor/ecc-operator',
    shipPack: true,
    summary:
      'Topology A — headless `cursor-agent -p` on customer infra; remote MCP via ~/.cursor/mcp.json. ECC craft stays client-side.',
    files: [
      { path: 'README.md', content: cursorReadme() },
      { path: '.mcp.json.template', content: cursorMcpJson() },
      { path: 'SKILL.md', content: SHARED_RAILS },
    ],
  },
  {
    id: 'cursor-background',
    label: 'Cursor Background Agents',
    topology: 'C',
    credential: 'ed25519_key',
    packDir: 'cursor-background/byoa',
    shipPack: true,
    summary:
      'Topology C — launch via api.cursor.com/v1 agents API; attach back over fleet-attach:v1; webhook completion (HMAC). Mint token then register_agent_key.',
    files: [
      { path: 'README.md', content: cursorBackgroundReadme() },
      { path: 'attach.env.template', content: cursorBackgroundEnv() },
      { path: 'SKILL.md', content: SHARED_RAILS },
    ],
  },
  {
    id: 'claude-managed',
    label: 'Claude Managed Agents',
    topology: 'C',
    credential: 'ed25519_key',
    packDir: 'claude-managed/byoa',
    shipPack: true,
    summary:
      'Topology C — Anthropic Managed Agents REST + poll/SSE completion (no webhook). Mint token then register_agent_key.',
    files: [
      { path: 'README.md', content: claudeManagedReadme() },
      { path: 'attach.env.template', content: claudeManagedEnv() },
      { path: 'SKILL.md', content: SHARED_RAILS },
    ],
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    topology: 'B',
    credential: 'docs_only',
    packDir: '',
    shipPack: false,
    summary:
      'Topology B — human-only Custom Connector in Settings UI. Not a drivable dispatch target; see docs/byoa-claude-desktop.md.',
    files: [],
  },
]

export function listShippableHarnesses(): ByoaHarness[] {
  return BYOA_HARNESSES.filter((h) => h.shipPack)
}

export function findHarness(id: string): ByoaHarness | null {
  const trimmed = id.trim()
  if (!trimmed) return null
  return BYOA_HARNESSES.find((h) => h.id === trimmed) ?? null
}

export function getHarnessPack(id: string):
  | { ok: true; harness: ByoaHarness }
  | { ok: false; error: 'not_found' | 'docs_only' } {
  const harness = findHarness(id)
  if (!harness) return { ok: false, error: 'not_found' }
  if (!harness.shipPack) return { ok: false, error: 'docs_only' }
  return { ok: true, harness }
}
