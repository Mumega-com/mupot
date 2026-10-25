// mupot — gardener_preview MCP tool (first slice of mupot#1544). READ-ONLY: it only SELECTs.
// Logic lives in src/gardener/preview.ts. Authorization: the shared task-visibility chokepoint
// (canReadSquadTasks, src/tasks/visibility.ts) — the caller must be able to read the squad.

import { type ToolSpec, fail, done, str, getSquad } from './index'
import { canReadSquadTasks } from '../tasks/visibility'
import {
  buildGardenerPreview,
  renderGardenerCard,
  DEFAULT_WINDOW_DAYS,
  MIN_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
} from '../gardener/preview'

export const toolGardenerPreview: ToolSpec = {
  name: 'gardener_preview',
  scope: 'squad',
  min: 'member',
  args: `{ squad_id: string (required; id|prefix|slug), window_days?: number (${MIN_WINDOW_DAYS}-${MAX_WINDOW_DAYS}, default ${DEFAULT_WINDOW_DAYS}), as_of?: string (ISO-8601 snapshot time; default now) }` +
    ' -- READ-ONLY. Per-agent last meaningful activity, open assignments, waits, measured cost (or "unknown"), one rule-based' +
    ' recommendation (rest|ask|shrink|feed) naming its rule, 30-day archive candidates with exception reasons, and evidence ids.' +
    ' Deterministic JSON plus a short Markdown card. Never writes, dispatches, archives, or calls a model.',
  // Zero writes means zero: opt out of the framework's post-call presence bump too.
  shouldTouchPresence: () => false,
  inputSchema: {
    type: 'object',
    properties: {
      squad_id: { type: 'string', description: 'Squad id, short id prefix, or slug. Required; you must be able to read the squad.' },
      window_days: { type: 'number', description: `Activity/cost window in days (${MIN_WINDOW_DAYS}-${MAX_WINDOW_DAYS}).` },
      as_of: { type: 'string', description: 'ISO-8601 snapshot time (UTC). Same snapshot => same output.' },
    },
    required: ['squad_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const ref = str(args.squad_id)
    if (!ref) return fail(400, 'invalid_args', 'squad_id required')
    let windowDays = DEFAULT_WINDOW_DAYS
    if (args.window_days !== undefined) {
      const w = args.window_days
      if (typeof w !== 'number' || !Number.isInteger(w) || w < MIN_WINDOW_DAYS || w > MAX_WINDOW_DAYS) {
        return fail(400, 'invalid_args', `window_days must be an integer ${MIN_WINDOW_DAYS}-${MAX_WINDOW_DAYS}`)
      }
      windowDays = w
    }
    let nowMs = Date.now()
    if (args.as_of !== undefined) {
      const raw = str(args.as_of)
      const t = raw ? Date.parse(raw) : Number.NaN
      if (Number.isNaN(t)) return fail(400, 'invalid_args', 'as_of must be an ISO-8601 timestamp')
      nowMs = t
    }
    const squadRes = await getSquad(env, ref)
    if (!squadRes.ok) return squadRes
    if (!(await canReadSquadTasks(env, auth, squadRes.squad.id))) {
      return fail(403, 'forbidden', { need: 'member', scope: 'squad' })
    }
    const preview = await buildGardenerPreview(env, {
      squadId: squadRes.squad.id,
      tenant: env.TENANT_SLUG,
      nowMs,
      windowDays,
    })
    return done({ ...preview, markdown: renderGardenerCard(preview) })
  },
}

export const GARDENER_TOOLS: ToolSpec[] = [toolGardenerPreview]
