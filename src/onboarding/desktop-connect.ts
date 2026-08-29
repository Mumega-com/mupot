// src/onboarding/desktop-connect.ts — 10-Second Desktop Connect Bundle Generator (FLIGHT ONBOARD-MCP).
//
// Bundles instant, copy-pasteable streamable-HTTP connection configs for:
// 1. Cursor IDE (`.cursor/mcp.json`)
// 2. Codex Desktop (`~/.codex/config.toml`)
// 3. Claude Code (`~/.claude/.mcp.json`)
// 4. Hermes Terminal Relay (`hermes config`)
// 5. Raw curl verification command

import type { Env } from '../types'
import { mcpEndpoint, claudeCodeSnippet, codexSnippet, cursorSnippet, canonicalOrigin } from '../dashboard/connect'

export interface DesktopConnectBundleResult {
  mcpEndpoint: string
  tenant: string
  authType: 'oauth_bearer' | 'workspace_token'
  harnessConfigs: {
    cursorMcpJson: string
    codexToml: string
    claudeCodeJson: string
    hermesEnv: string
    curlCommand: string
  }
}

/**
 * Generates ready-to-paste desktop connect configs for any harness.
 */
export function generateDesktopConnectBundle(
  env: Env,
  options: { rawToken?: string; publicOrigin?: string } = {},
): DesktopConnectBundleResult {
  const origin = options.publicOrigin || canonicalOrigin(env, 'https://mupot.mumega.com')
  const endpoint = mcpEndpoint(origin)
  const slug = env.TENANT_SLUG
  const tokenPlaceholder = options.rawToken || '<MEMBER_TOKEN>'

  const claudeCodeJson = claudeCodeSnippet(slug, origin).replace('<MEMBER_TOKEN>', tokenPlaceholder)
  const cursorMcpJson = cursorSnippet(slug, origin).replace('<MEMBER_TOKEN>', tokenPlaceholder)
  const codexToml = codexSnippet(slug, origin).replace('<MEMBER_TOKEN>', tokenPlaceholder)

  const hermesEnv = [
    `# Hermes Terminal Connection for Mupot`,
    `MUPOT_MCP_ENDPOINT="${endpoint}"`,
    `MUPOT_BEARER_TOKEN="${tokenPlaceholder}"`,
    `MUPOT_TENANT="${slug}"`,
  ].join('\n')

  const curlCommand = `curl -X POST "${endpoint}" -H "Authorization: Bearer ${tokenPlaceholder}" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`

  return {
    mcpEndpoint: endpoint,
    tenant: slug,
    authType: options.rawToken ? 'workspace_token' : 'oauth_bearer',
    harnessConfigs: {
      cursorMcpJson,
      codexToml,
      claudeCodeJson,
      hermesEnv,
      curlCommand,
    },
  }
}
