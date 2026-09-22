// mupot — team_bootstrap MCP tool (mupot#1498). Thin ToolSpec wrapper around
// src/org/team-bootstrap.ts's atomic core: gates org-admin + refuses an
// agent-bound principal (a grant tool never runs as an agent — the same rule
// mint_agent_token/update_squad already enforce), then handles the two
// steps that are deliberately OUTSIDE the core function's D1 batch —
// minting the bot's credential claim and seeding project memory — because
// neither is a D1 write the batch could span (see team-bootstrap.ts's file
// header).
//
// REST: registering this tool into TOOLS (src/mcp/index.ts) is the ENTIRE
// REST surface — mcpActionsApp's generic `POST /actions/:tool` (src/mcp/
// index.ts) dispatches any registered tool through the SAME invokeTool seam
// a minted bearer token can call directly. No separate route is needed or
// written.

import type { Agent, AuthContext, Env } from '../types'
import { type ToolSpec, fail, done, str, hasWorkspaceAdmin } from './index'
import {
  teamBootstrap,
  isValidSlugBase,
  type TeamBootstrapInput,
  type TeamBootstrapHumanInput,
  type TeamBootstrapError,
} from '../org/team-bootstrap'
import { mintAgentBoundToken } from '../members/service'
import { createCredentialClaim, type CredentialClaimHandle } from '../auth/credential-claim'
import { createMemory } from '../memory'
import { mcpEndpoint, requiredCanonicalOrigin } from '../dashboard/connect'

const STRING_SCHEMA = { type: 'string' }
const OPTIONAL_BOOLEAN_SCHEMA = { type: 'boolean' }

const HUMANS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: { email: STRING_SCHEMA, capability: STRING_SCHEMA },
    required: ['email', 'capability'],
    additionalProperties: false,
  },
}

const BOT_SCHEMA = {
  type: 'object',
  properties: {
    enabled: OPTIONAL_BOOLEAN_SCHEMA,
    name: STRING_SCHEMA,
    role: STRING_SCHEMA,
    model: STRING_SCHEMA,
  },
  additionalProperties: false,
}

function errorStatus(error: TeamBootstrapError): 400 | 403 | 404 | 409 {
  if (error === 'department_not_found') return 404
  if (error === 'ambiguous_department') return 409
  if (error === 'squad_limit_reached' || error === 'agent_limit_reached') return 409
  if (error === 'squad_slug_taken' || error === 'project_slug_taken') return 409
  if (error === 'project_archived') return 409
  if (error === 'cannot_adopt_home_squad') return 403
  return 400
}

/**
 * The downloadable Hermes profile scaffold — profile directory layout,
 * `.mcp.json` template with the credential CLAIM (never a raw token,
 * mupot#987) as a placeholder to be resolved via `reveal_credential_claim`,
 * a SOUL.md template, and a DISABLED systemd unit (an operator must
 * deliberately enable it — team_bootstrap never activates a live process).
 * Purely computed from already-known values; writes nothing.
 */
function hermesScaffold(
  canonicalOrigin: string,
  agent: Pick<Agent, 'id' | 'slug' | 'name' | 'role' | 'model' | 'squad_id'>,
  claim: CredentialClaimHandle | null,
): {
  profile_dir_layout: string[]
  mcp_config_template_with_claim_placeholder: string
  soul_md_template: string
  systemd_unit_template_disabled: string
} {
  const dir = `~/hermes/profiles/${agent.slug}`
  const endpoint = mcpEndpoint(canonicalOrigin)
  const claimPlaceholder = claim
    ? `<REVEAL_VIA:reveal_credential_claim:claim_id=${claim.claim_id}>`
    : '<NO_CLAIM_MINTED — run mint_agent_token for this agent, then reveal_credential_claim>'

  const mcpConfig = JSON.stringify(
    {
      mcpServers: {
        mupot: {
          url: endpoint,
          headers: { Authorization: `Bearer ${claimPlaceholder}` },
        },
      },
    },
    null,
    2,
  )

  const soul = [
    `# ${agent.name}`,
    '',
    `role: ${agent.role}`,
    `model: ${agent.model}`,
    `squad_id: ${agent.squad_id}`,
    `agent_id: ${agent.id}`,
    '',
    '## Purpose',
    '',
    '(fill in — what this agent is for, in one paragraph)',
    '',
    '## Wake / Sleep',
    '',
    '- On wake: recall your domain memory before touching anything.',
    '- On done: remember what changed so the next wake starts informed.',
  ].join('\n')

  const unit = [
    '[Unit]',
    `Description=Hermes profile for ${agent.slug} (mupot agent ${agent.id}) — DISABLED by team_bootstrap`,
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=/usr/bin/env hermes run --profile ${dir}`,
    'Restart=on-failure',
    '',
    '[Install]',
    '# WantedBy intentionally omitted — this unit ships disabled. An operator',
    '# must review the profile, reveal + install the credential claim, and',
    '# run `systemctl --user enable` deliberately before this ever starts.',
  ].join('\n')

  return {
    profile_dir_layout: [
      `${dir}/`,
      `${dir}/.mcp.json`,
      `${dir}/SOUL.md`,
      `${dir}/systemd/${agent.slug}.service`,
    ],
    mcp_config_template_with_claim_placeholder: mcpConfig,
    soul_md_template: soul,
    systemd_unit_template_disabled: unit,
  }
}

function inviteUrl(canonicalOrigin: string, inviteId: string): string {
  return `${canonicalOrigin.replace(/\/+$/, '')}/invite/${encodeURIComponent(inviteId)}`
}

export const toolTeamBootstrap: ToolSpec = {
  name: 'team_bootstrap',
  scope: 'org — composite project + squad + bot + invites bootstrap',
  min: 'admin',
  args:
    '{ slug_base: string, name: string, department: string (id|slug), humans?: [{email, capability: "observer"|"member"}], bot?: { enabled?: boolean, name?, role?, model? }, seed_memory?: string, adopt?: boolean (org:admin only — see project_slug_taken/squad_slug_taken; never overrides the kind=home fence) }',
  inputSchema: {
    type: 'object',
    properties: {
      slug_base: STRING_SCHEMA,
      name: STRING_SCHEMA,
      department: STRING_SCHEMA,
      humans: HUMANS_SCHEMA,
      bot: BOT_SCHEMA,
      seed_memory: STRING_SCHEMA,
      adopt: OPTIONAL_BOOLEAN_SCHEMA,
    },
    required: ['slug_base', 'name', 'department'],
    additionalProperties: false,
  },
  async run(auth: AuthContext, env: Env, args) {
    // Grant tool — never as an agent (mint_agent_token/update_squad's own rule).
    if (auth.boundAgentId) return fail(403, 'operator_principal_required')
    // AAGATE (spec.min='admin') already floors this at the invokeTool chokepoint;
    // this re-derives the PRECISE org-admin check the way every sibling
    // provision.ts tool does (never trust the floor alone for a sensitive act).
    if (!hasWorkspaceAdmin(auth)) return fail(403, 'forbidden', { need: 'admin', scope: 'org' })

    const slugBase = str(args.slug_base)
    if (!slugBase || !isValidSlugBase(slugBase)) return fail(400, 'invalid_slug_base')
    const name = str(args.name)
    if (!name) return fail(400, 'invalid_args', 'name required')
    const department = str(args.department)
    if (!department) return fail(400, 'invalid_args', 'department required')

    const humansArg = Array.isArray(args.humans) ? args.humans : []
    const humans: TeamBootstrapHumanInput[] = []
    for (const raw of humansArg) {
      if (typeof raw !== 'object' || raw === null) return fail(400, 'invalid_args', 'humans[] must be objects')
      const rawRecord = raw as Record<string, unknown>
      const email = str(rawRecord.email)
      const capability = rawRecord.capability
      if (!email) return fail(400, 'invalid_human_email')
      if (capability !== 'observer' && capability !== 'member') return fail(400, 'invalid_human_capability')
      humans.push({ email, capability })
    }

    const botArg = args.bot as Record<string, unknown> | undefined
    const bot = botArg
      ? {
          enabled: botArg.enabled === undefined ? undefined : Boolean(botArg.enabled),
          name: str(botArg.name) ?? undefined,
          role: str(botArg.role) ?? undefined,
          model: str(botArg.model) ?? undefined,
        }
      : undefined

    const rawSeedMemory = args.seed_memory !== undefined ? str(args.seed_memory) : undefined

    const input: TeamBootstrapInput = {
      slug_base: slugBase,
      name,
      department,
      humans,
      bot,
      seed_memory: rawSeedMemory ?? undefined,
      adopt: args.adopt === true,
    }

    const result = await teamBootstrap(env, auth, input)
    if (!result.ok) return fail(errorStatus(result.error), result.error, result.detail)

    // Mint the bot's token ONLY when a bot was freshly created THIS call — a
    // replay against an already-existing bot mints no second credential
    // (idempotent: "no second bot" extends to "no second silently-minted
    // token" — an operator who needs a fresh one calls mint_agent_token).
    let credentialClaim: CredentialClaimHandle | null = null
    const canonical = requiredCanonicalOrigin(env)
    if (result.bot && result.bot.created) {
      try {
        const minted = await mintAgentBoundToken(
          env,
          result.bot.agent,
          `team-bootstrap:${result.bot.agent.slug}`,
          'member',
        )
        credentialClaim = await createCredentialClaim(env, minted.raw, auth.memberId as string)
      } catch {
        // Non-fatal: project/squad/edge/bot/invites are already committed by
        // teamBootstrap's batch. The operator can mint separately via
        // mint_agent_token — never fail the whole call for this step alone.
        credentialClaim = null
      }
    }

    // Seed memory only on a genuinely FIRST bootstrap (disposition:'created')
    // — a replay call with the same seed_memory text must not accumulate a
    // duplicate engram on every retry.
    if (rawSeedMemory && result.disposition === 'created') {
      const scope = `project:${result.project.project.id}`
      await createMemory(env).remember(scope, rawSeedMemory)
    }

    const scaffold = canonical.ok && result.bot
      ? hermesScaffold(canonical.origin, result.bot.agent, credentialClaim)
      : null

    return done({
      disposition: result.disposition,
      receipt_id: result.receipt_id,
      project: { ...result.project.project, created: result.project.created },
      squad: { ...result.squad.squad, created: result.squad.created },
      edge_kept: result.edge_kept,
      bot: result.bot
        ? { id: result.bot.agent.id, slug: result.bot.agent.slug, name: result.bot.agent.name, created: result.bot.created }
        : null,
      invites: result.invites.map((invite) => ({
        id: invite.id,
        url: canonical.ok ? inviteUrl(canonical.origin, invite.id) : null,
        email: invite.email,
        capability: invite.capability,
        created: invite.created,
      })),
      duplicate_emails_in_request: result.duplicate_emails_in_request,
      credential_claim: credentialClaim,
      hermes_scaffold: scaffold,
    })
  },
}
