// mupot — seed_attach: validate a mupot.seed/v1 document and show what attaching it
// would ask for. Contract: docs/architecture/seed-v1.md.
//
// AUTHZ / SAFETY
//   - Validation grants nothing. Every want in the seed comes back as a request that
//     needs a human to accept it in a later step.
//   - dry_run defaults to TRUE and writes nothing. dry_run:false APPLIES (src/seeds/apply.ts):
//     a human act. Agent-bound callers are refused 403 human_accept_required, an org admin
//     member is required (the team_bootstrap floor), and EVERY request must be listed in
//     `accept`. Apply creates project + squad + edge + seat cap + one row + one receipt and
//     grants nothing.
//   - The "diffs" read goes through the same project-visibility primitive project_get
//     uses (readAccess + readableProject). A project the caller cannot read produces
//     no diff and no signal that it exists.

import { validateSeed } from '../seeds/validate'
import { renderRequest } from '../seeds/render'
import type { SeedV1 } from '../seeds/contract'
import { readAccess, readableProject } from './projects'
import { hasWorkspaceAdmin } from '../auth/capability'
import { issueAcceptToken } from '../seeds/accept-token'
import { keyRequests, applySeed, seedProjectSlug } from '../seeds/apply'
import { createSeedRequest, SEED_REQUEST_TTL_MS } from '../access/seed-request'
import { approveUrl, accessApproveStatus } from '../access/config'
import { secureMomentsStatus } from '../secure-moments/config'
import { issueMomentLink } from '../secure-moments/issue'
import { deliverMomentToTelegram } from '../secure-moments/telegram-miniapp-auto'
import { draftSeed, DRAFT_PLATFORMS, type DraftInput } from '../seeds/draft'
import { type ToolSpec, fail, done } from './index'

interface SeedDiff { field: string; current: string | null; proposed: string | null }

function diffAgainst(project: { name: string; goal: string; repo_url: string | null; live_url: string | null }, seed: SeedV1): SeedDiff[] {
  const pairs: Array<[string, string | null, string | null]> = [
    ['name', project.name, seed.name],
    ['goal', project.goal, seed.goal],
    ['repo', project.repo_url, seed.repo ?? null],
    ['live', project.live_url, seed.live ?? null],
  ]
  return pairs
    .filter(([, current, proposed]) => (current ?? null) !== (proposed ?? null))
    .map(([field, current, proposed]) => ({ field, current, proposed }))
}

const toolSeedAttach: ToolSpec = {
  name: 'seed_attach',
  scope: 'validate a mupot.seed/v1 and list what it requests; dry_run:false (human org admin only, with accept[]) creates project + squad + seat cap and grants nothing',
  min: 'member',
  args: '{ seed: string (YAML or JSON), dry_run?: boolean (default true), accept?: string[] (apply only: every request key from the dry run), accept_token?: string (apply only: from that dry run, 15 min, same member) }',
  inputSchema: {
    type: 'object',
    properties: {
      seed: { type: 'string', description: 'mupot.seed/v1 document as YAML or JSON (max 32 KiB).' },
      dry_run: { type: 'boolean', description: 'Default true: validate and report only. false applies (human org admin only).' },
      accept_token: { type: 'string', description: 'Apply only. The accept_token the dry run returned for this exact seed and member (valid 15 minutes).' },
      accept: { type: 'array', items: { type: 'string' }, description: 'Apply only. Every request key from the dry run; apply refuses unless all are listed.' },
    },
    required: ['seed'],
    additionalProperties: false,
  },
  // Dry run must write NOTHING, including the framework's post-call presence bump; apply refreshes
  // presence like any other mutating tool.
  shouldTouchPresence: (args) => args.dry_run === false,
  async run(auth, env, args) {
    if (args.dry_run !== undefined && typeof args.dry_run !== 'boolean') return fail(400, 'invalid_args', 'dry_run must be a boolean')
    const apply = args.dry_run === false
    // Accepting a seed's requests is a human act: no agent-bound principal, whatever it holds.
    if (apply && auth.boundAgentId) return fail(403, 'human_accept_required')
    if (apply && !auth.memberId) return fail(403, 'human_accept_required')
    if (apply && !hasWorkspaceAdmin(auth)) return fail(403, 'forbidden', { need: 'admin', scope: 'org' })

    const result = await validateSeed(args.seed)
    if (!result.ok) return fail(400, 'invalid_seed', result.error)
    const requests = await keyRequests(result.requests)

    if (apply && auth.memberId) {
      const outcome = await applySeed(env, auth, auth.memberId, { seed: result.seed, canonical: result.canonical, seedSha256: result.seedSha256, requests }, args.accept, args.accept_token)
      return outcome.ok ? done(outcome.result) : fail(outcome.status, outcome.error, outcome.detail)
    }

    let diffs: SeedDiff[] = []
    const row = await env.DB.prepare('SELECT id FROM projects WHERE slug = ?').bind(seedProjectSlug(result.seed.slug)).first<{ id: string }>()
    if (row) {
      const project = await readableProject(env, row.id, readAccess(auth))
      if (project) diffs = diffAgainst(project, result.seed)
    }
    return done({
      ok: true,
      dry_run: true,
      seed_sha256: result.seedSha256,
      // A human act: never issued to an agent-bound principal, nor when the pot has no server secret.
      accept_token: auth.memberId && !auth.boundAgentId ? await issueAcceptToken(env, auth.memberId, result.seedSha256) : null,
      requests: requests.map((r) => ({ ...r, text: renderRequest(r) })),
      diffs,
    })
  },
}

// seed_attach_request — "the agent prepares". Validates the seed exactly like the seed_attach dry run, stores it
// as a pending, single-use, 24h request, and returns the link a HUMAN opens behind Cloudflare Access to
// approve it. It decides nothing and grants nothing: there is no apply path here, no accept_token, and no
// way for any bearer (agent or human) to complete the request over MCP. Docs: access-approve-page.md.
const toolSeedAttachRequest: ToolSpec = {
  name: 'seed_attach_request',
  scope: 'file a pending request to attach a mupot.seed/v1; returns approve_url for a human to open (decides nothing, grants nothing)',
  min: 'member',
  args: '{ seed: string (YAML or JSON) }',
  inputSchema: {
    type: 'object',
    properties: { seed: { type: 'string', description: 'mupot.seed/v1 document as YAML or JSON (max 32 KiB).' } },
    required: ['seed'],
    additionalProperties: false,
  },
  async run(auth, env, args, ctx) {
    if (!auth.memberId) return fail(403, 'forbidden', 'a member principal is required to file a request')
    // Check the flags/config BEFORE writing anything: a request nobody can approve is noise. Either human-proof
    // channel being usable is enough (secure moments are independent of the Access approve page).
    const status = accessApproveStatus(env)
    const secure = secureMomentsStatus(env)
    if (status.state !== 'on' && secure.state !== 'on') {
      const reason = secure.state === 'misconfigured' ? `secure moments are misconfigured: ${secure.reason}`
        : status.state === 'misconfigured' ? `the Access approve page is misconfigured: ${status.reason}` : null
      return fail(409, 'access_approve_not_enabled', reason ?? 'no human approval page is enabled on this pot')
    }
    const result = await validateSeed(args.seed)
    if (!result.ok) return fail(400, 'invalid_seed', result.error)
    const requests = await keyRequests(result.requests)
    const created = await createSeedRequest(env, {
      requesterMemberId: auth.memberId,
      requesterAgentId: auth.boundAgentId ?? null,
      validated: { seed: result.seed, canonical: result.canonical, seedSha256: result.seedSha256, requests },
    })
    if (!created.ok) return fail(429, 'too_many_pending_requests', 'close or wait out your pending seed requests first')
    // Secure moment first (when on): its link is the approve_url; the Access link, if also on, stays available.
    const moment = await issueMomentLink(env, {
      kind: 'seed_attach', subjectId: created.id, requesterAgentId: auth.boundAgentId ?? null, subjectExpiresAtIso: created.expiresAt,
    })
    const accessUrl = approveUrl(env, 'seed', created.id)
    // The human sees it in Telegram without a second tool call (best effort; the link below stays the fallback).
    const telegram = moment
      ? await deliverMomentToTelegram(env, { momentId: moment.momentId, requesterMemberId: auth.memberId }, { waitUntil: ctx.waitUntil })
      : 'disabled'
    return done({
      ok: true,
      request_id: created.id,
      approve_url: moment?.url ?? accessUrl,
      telegram,
      ...(moment && accessUrl ? { access_approve_url: accessUrl } : {}),
      expires_at: created.expiresAt,
      ttl_seconds: SEED_REQUEST_TTL_MS / 1000,
      reused: created.reused,
      seed_sha256: result.seedSha256,
      requests: requests.map((r) => ({ key: r.key, kind: r.kind, text: renderRequest(r) })),
      note: 'Pending. Only a human can approve it, at approve_url (a one-time link; passkey or Cloudflare Access). Nothing is created or granted until then.',
    })
  },
}

// seed_draft: produce a mupot.seed/v1 DRAFT from facts the agent already holds. Pure and read-only:
// no D1 read or write, no fetch, no project, no request filed, no accept_token. The draft only asks;
// a human accepts later through seed_attach. Contract: docs/architecture/seed-v1.md (seed_draft).
const toolSeedDraft: ToolSpec = {
  name: 'seed_draft',
  scope: 'draft a mupot.seed/v1 from a repo or site URL plus optional hints; pure, read-only, no fetch, grants and accepts nothing',
  min: 'member',
  args: '{ source: { kind: "repo", url } | { kind: "site", url, platform?: "wordpress"|"astro"|"shopify"|"static" }, project_name?: string, hints?: { goal, owner, live_url, repo_url, kind, deploy_via, deploy_cmd, deploy_receipt, squad, gate, risk_class, surface_paths[], tool_slots[{mcp|openapi, cred_slot}] } }',
  inputSchema: {
    type: 'object',
    properties: {
      source: {
        type: 'object',
        description: 'Where the project lives. The URL is only parsed and normalised; nothing is fetched.',
        properties: {
          kind: { type: 'string', enum: ['repo', 'site'] },
          url: { type: 'string', description: 'https repository URL (repo) or https site URL (site).' },
          platform: { type: 'string', enum: [...DRAFT_PLATFORMS], description: 'Site sources only.' },
        },
        required: ['kind', 'url'],
        additionalProperties: false,
      },
      project_name: { type: 'string', description: 'Display name; the slug is derived from it. Defaults to the repository name or site host.' },
      hints: { type: 'object', description: 'Facts the agent already read locally. Unknown keys are ignored with a warning. Never put a credential value here; name a cred_slot.' },
    },
    required: ['source'],
    additionalProperties: false,
  },
  // Writes nothing at all, including the framework's post-call presence bump.
  shouldTouchPresence: () => false,
  async run(_auth, _env, args) {
    // as: shape is checked field by field inside draftSeed (it refuses anything malformed)
    const result = await draftSeed({ source: args.source, project_name: args.project_name, hints: args.hints } as DraftInput)
    if (!result.ok) return fail(400, 'invalid_draft', result.error)
    const requests = await keyRequests(result.validation.requests)
    return done({
      ok: true,
      seed_yaml: result.seedYaml,
      seed_sha: result.validation.seedSha256,
      valid: true,
      requests: requests.map((r) => ({ ...r, text: renderRequest(r) })),
      warnings: result.warnings,
      next: 'Review and edit the draft, then call seed_attach (dry run) with this seed; a human org admin then accepts. Nothing here was written or accepted.',
    })
  },
}

export const SEED_TOOLS: ToolSpec[] = [toolSeedAttach, toolSeedDraft, toolSeedAttachRequest]
