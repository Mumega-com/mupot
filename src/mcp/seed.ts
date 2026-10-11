// mupot — seed_attach: validate a mupot.seed/v1 document and show what attaching it
// would ask for. Contract: docs/architecture/seed-v1.md.
//
// AUTHZ / SAFETY
//   - Validation grants nothing. Every want in the seed comes back as a request that
//     needs a human to accept it in a later step.
//   - dry_run defaults to TRUE and writes nothing. dry_run:false (apply) is not built
//     in this slice and answers 501 seed_apply_not_built.
//   - The "diffs" read goes through the same project-visibility primitive project_get
//     uses (readAccess + readableProject). A project the caller cannot read produces
//     no diff and no signal that it exists.

import { validateSeed } from '../seeds/validate'
import { renderRequest } from '../seeds/render'
import type { SeedV1 } from '../seeds/contract'
import { readAccess, readableProject } from './projects'
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
  scope: 'validate a mupot.seed/v1 and list what it requests (dry run only; nothing is written or granted)',
  min: 'member',
  args: '{ seed: string (YAML or JSON), dry_run?: boolean (default true; false = 501 until apply ships) }',
  inputSchema: {
    type: 'object',
    properties: {
      seed: { type: 'string', description: 'mupot.seed/v1 document as YAML or JSON (max 32 KiB).' },
      dry_run: { type: 'boolean', description: 'Default true. Validate and report only. false is not implemented yet.' },
    },
    required: ['seed'],
    additionalProperties: false,
  },
  // Dry run must write NOTHING, including the framework's post-call presence bump.
  shouldTouchPresence: () => false,
  async run(auth, env, args) {
    if (args.dry_run !== undefined && typeof args.dry_run !== 'boolean') return fail(400, 'invalid_args', 'dry_run must be a boolean')
    if (args.dry_run === false) return fail(501, 'seed_apply_not_built', 'only dry_run is available in this release')

    const result = await validateSeed(args.seed)
    if (!result.ok) return fail(400, 'invalid_seed', result.error)

    let diffs: SeedDiff[] = []
    const row = await env.DB.prepare('SELECT id FROM projects WHERE slug = ?').bind(result.seed.slug).first<{ id: string }>()
    if (row) {
      const project = await readableProject(env, row.id, readAccess(auth))
      if (project) diffs = diffAgainst(project, result.seed)
    }
    return done({
      ok: true,
      dry_run: true,
      seed_sha256: result.seedSha256,
      requests: result.requests.map((r) => ({ ...r, text: renderRequest(r) })),
      diffs,
    })
  },
}

export const SEED_TOOLS: ToolSpec[] = [toolSeedAttach]
