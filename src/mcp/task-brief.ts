// src/mcp/task-brief.ts — task_brief: the one-call context pack for whoever picks up a task.
//
// RBAC IS task_get's, not a copy of it: the row gate is canReadTask (src/tasks/visibility.ts), and a
// task the caller cannot read answers the SAME 404 task_not_found as an id that does not exist. On top
// of that the project-level sections need project READ (readableProject, the project_recall gate); a
// caller who can read the task but not its project simply gets a brief without the project sections.
// Dispatch-failure detail rides canViewTaskReceipts, exactly as task_get's dispatch timeline does.
// Flights and objectives are gated by flight-spine's own visibleFlight / visibleObjective (never re-derived from the task scope).
// Everything else (what is assembled, how it is filtered) lives in src/tasks/brief.ts.
//
// READ-ONLY. The wiki leg is a GET to the Inkwell wiki service (best effort, 2s), which is why the
// annotation row is open-world.

import { buildTaskBrief, type BriefTask } from '../tasks/brief'
import { canViewTaskReceipts } from '../tasks/index'
import { TASK_SELECT_COLUMNS } from '../tasks/ranking'
import { canReadTask, resolveVisibleTaskScope } from '../tasks/visibility'
import { observedFloorDecision } from '../members/vip-lane'
import { callerHasSquadAccessToProject } from '../projects/access'
import { done, fail, projectMemoryScope, str, type ToolSpec } from './index'
import { readAccess, readableProject } from './projects'
import { visibleFlight, visibleObjective } from './flight-spine'

interface BriefTaskRow extends Record<string, unknown> {
  id: string
  squad_id: string
  project_id: string | null
  parent_task_id: string | null
  title: string
  body: string | null
  done_when: string | null
  status: string
  priority: string | null
  gate_owner: string | null
  assignee_agent_id: string | null
  assignee_member_id: string | null
  hold_task_id: string | null
  hold_held_at: string | null
  hold_released_at: string | null
}

export const toolTaskBrief: ToolSpec = {
  name: 'task_brief',
  scope: 'squad',
  min: 'member',
  args: '{ task_id: string }' +
    ' -- READ-ONLY, same visibility as task_get. ONE compact context pack (~2,500 tokens max): the task (done_when, gate, last notes),' +
    ' why it matters (project goal, flight/objective), what the team knows (top relevant project memory, wiki and lessons),' +
    ' related work (sibling tasks, last project verdicts and why, failed attempts), how the team works (playbook, project rules,' +
    ' who can approve what) and open questions. Every line carries a [kind:id] handle for drill-in with the existing tools.' +
    ' Call this FIRST when you pick up a task.',
  inputSchema: {
    type: 'object',
    properties: { task_id: { type: 'string' } },
    required: ['task_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const taskId = str(args.task_id)
    if (!taskId) return fail(400, 'invalid_args', 'task_id required')
    // Same shape as task_get's read: shared projection + the execution hold on one round-trip.
    const row = await env.DB.prepare(
      `SELECT ${TASK_SELECT_COLUMNS},
              hold.hold_task_id, hold.hold_held_at, hold.hold_released_at
         FROM tasks
         LEFT JOIN (SELECT task_id AS hold_task_id, held_at AS hold_held_at, released_at AS hold_released_at
                      FROM execution_holds) hold ON hold.hold_task_id = tasks.id
        WHERE id = ?1 LIMIT 1`,
    ).bind(taskId).first<BriefTaskRow>()
    if (!row || !(await canReadTask(env, auth, { id: row.id, squad_id: row.squad_id }))) {
      return fail(404, 'task_not_found')
    }

    const isAssignee = !!auth.boundAgentId && row.assignee_agent_id === auth.boundAgentId
    const [scope, canViewReceipts, project] = await Promise.all([
      resolveVisibleTaskScope(env, auth),
      isAssignee
        ? Promise.resolve(true)
        : canViewTaskReceipts(env, auth, { squad_id: row.squad_id, gate_owner: row.gate_owner, assignee_agent_id: row.assignee_agent_id }),
      row.project_id ? readableProject(env, row.project_id, readAccess(auth)) : Promise.resolve(null),
    ])

    const task: BriefTask = {
      id: row.id,
      squad_id: row.squad_id,
      project_id: row.project_id,
      parent_task_id: row.parent_task_id,
      title: row.title,
      body: row.body,
      done_when: row.done_when,
      status: row.status,
      priority: row.priority,
      gate_owner: row.gate_owner,
      assignee_agent_id: row.assignee_agent_id,
      assignee_member_id: row.assignee_member_id,
      hold: row.hold_task_id != null && row.hold_released_at == null
        ? { held: true, escalated_at: row.hold_held_at }
        : null,
    }
    // An OBSERVED seat (floor not lifted by an attachment) may call task_brief but not objective_get, so the legs behind tools the
    // floor refuses (objective, seed risk lists, verdict notes) are left out rather than served through this one.
    const floor = await observedFloorDecision(env, auth, 'task_brief')
    const flooredSeat = (floor.status === 'observed' || floor.status === 'held') && !auth.seatBinding?.attached
    const brief = await buildTaskBrief(env, {
      task,
      project,
      memoryScope: project ? projectMemoryScope(project.id) : null,
      scope,
      canViewReceipts,
      flooredSeat,
      canSeeSquadPages: project ? await callerHasSquadAccessToProject(env, readAccess(auth), project.id) : false,
      // Each source's OWN visibility function (the class rule): the flight check is flight-spine's visibleFlight
      // (observer on every squad of the flight + project read), the objective check its visibleObjective.
      visible: {
        flight: async (flightId) => (await visibleFlight(env, auth, flightId)) !== null,
        objective: async (objectiveId) => {
          const o = await visibleObjective(env, auth, objectiveId)
          return o && o.tenant === env.TENANT_SLUG ? { title: o.title, successContract: o.successContract } : null
        },
      },
    })
    return done(brief)
  },
}

export const TASK_BRIEF_TOOLS: ToolSpec[] = [toolTaskBrief]
