import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const dir = resolve(process.argv[2] ?? '../v034-stale-situation-evidence/mutations')
mkdirSync(dir, { recursive: true })
const service = resolve('src/routines/actions.ts')
const dispatch = resolve('src/routines/dispatch.ts')
const originals = new Map([service, dispatch].map(path => [path, readFileSync(path, 'utf8')]))
function replace(source, from, to) {
  if (!source.includes(from)) throw new Error(`mutation anchor missing: ${from}`)
  return source.replace(from, to)
}
const mutants = [
  ['global-board-gate', service, s => replace(s, 'return live !== null && live.digest === proposal.source_observation.digest', 'return await currentSituationDigest(env, run, policy) === run.situation_digest'), 'accepts a long read-only audit'],
  ['submit-freshness', service, s => replace(s, 'if (!await proposalSituationCurrent(env, run, policy, proposal))', 'if (false)'), 'refuses changed declared source facts'],
  ['execution-freshness', service, s => replace(s, 'if (!await proposalSituationCurrent(env, run, policy, storedProposal.value))', 'if (false)'), 'rechecks sources at execution'],
  ['action-binding', service, s => replace(s, 'action: proposal.action, sources,', 'action: null, sources,'), 'binds observation to the exact action'],
  ['attempt-binding', service, s => replace(s, 'attempt: run.attempt, situation_digest:', 'attempt: 0, situation_digest:'), 'different attempt'],
  ['dispatch-binding', service, s => replace(s, 'situation_digest: run.situation_digest,\n      policy, project:', 'situation_digest: null,\n      policy, project:'), 'different dispatch digest'],
  ['declared-context', service, s => replace(s, 'const references = [...(proposal.source_observation?.references ?? [])]', 'const references = [] as RoutineProposalReference[]'), 'protects an explicitly declared source'],
  ['implicit-ask-sources', service, s => replace(s, "if (action.kind === 'ask_human') references.push(...action.input.references)", ''), 'accepts a long read-only audit'],
  ['implicit-flight-tasks', service, s => replace(s, "references.push(...action.input.task_ids.map(id => ({ type: 'task' as const, id })))", ''), 'pins intrinsic flight task sources'],
  ['implicit-review-source', service, s => replace(s, "if (action.kind === 'request_review') references.push({ type: action.input.source_type, id: action.input.source_id })", ''), 'rechecks sources at execution'],
  ['task-body-fact', service, s => replace(s, 'fact = await env.DB.prepare(`SELECT ${TASK_SELECT_COLUMNS} FROM tasks', "fact = await env.DB.prepare(`SELECT ${TASK_SELECT_COLUMNS.replace('body, ', '')} FROM tasks"), 'refuses changed declared source facts.*Changed evidence'],
  ['task-archive', service, s => replace(s, 'squad_id = ? AND ${TASK_NOT_ARCHIVED_SQL()}`)', 'squad_id = ? AND 1=1`)'), 'refuses changed declared source facts.*Archived after observation'],
  ['empty-source-set', service, s => replace(s, 'unique.length === 0 || unique.length > 200', 'unique.length > 200'), 'requires at least one declared source'],
  ['observation-budget', service, s => replace(s, "parsed.value.action.kind === 'project_access' || proposalSourceReferences(parsed.value).length > 200", "parsed.value.action.kind === 'project_access'"), 'rejects an over-budget source union'],
  ['privileged-observation', service, s => replace(s, "parsed.value.action.kind === 'project_access' || proposalSourceReferences(parsed.value).length > 200", 'proposalSourceReferences(parsed.value).length > 200'), 'keeps privileged project_access'],
  ['assigned-agent', service, s => replace(s, "if (principal.actor_id !== run.assigned_agent_id) return { ok: false, error: 'assigned_agent_mismatch' }", ''), 'refuses another agent'],
  ['member-principal', service, s => replace(s, "principal.actor_type !== 'agent' || !await principalCanRunForSquad", '!await principalCanRunForSquad'), 'refuses a member principal'],
  ['capability-floor', service, s => replace(s, "principal.actor_type !== 'agent' || !await principalCanRunForSquad(env, principal, run.project_id, policy.responsible_squad_id)", "principal.actor_type !== 'agent'"), 'refuses a member principal'],
  ['live-project-access', service, s => replace(s, '!run || principal.tenant !== env.TENANT_SLUG || !await principalCanReadProject(env, principal, run.project_id)', '!run || principal.tenant !== env.TENANT_SLUG'), 'observes no run state writes'],
  ['run-status', service, s => replace(s, "!['running', 'waiting'].includes(run.status) || !run.situation_digest", '!run.situation_digest'), 'refuses observation after run eligibility.*status'],
  ['cancellation-fence', service, s => replace(s, '|| await isCancellationPending(env, run.id, run.tenant)) return', ') return'), 'refuses observation after run eligibility.*cancellation_requested'],
  ['active-project', service, s => replace(s, "if (run.project_status !== 'active') return { ok: false, error: 'project_not_active' }", ''), 'refuses observation after run eligibility.*paused'],
  ['task-response-projection', service, s => replace(s, "? ['id', 'squad_id', 'project_id', 'title', 'body', 'done_when', 'status', 'assignee_agent_id',", "? ['external_source', 'id', 'squad_id', 'project_id', 'title', 'body', 'done_when', 'status', 'assignee_agent_id',"), 'accepts a long read-only audit'],
  ['flight-response-projection', service, s => replace(s, "? ['id', 'project_id', 'agent', 'goal', 'status', 'gate_verdict', 'gate_reason',", "? ['meta', 'id', 'project_id', 'agent', 'goal', 'status', 'gate_verdict', 'gate_reason',"), 'pins declared flight records'],
  ['flight-all-squads', service, s => replace(s, 'if (!meta || meta.squad_ids.some(id => id !== policy.responsible_squad_id)) return null', 'if (!meta) return null'), 'out-of-scope flight observation: multi-squad'],
  ['historical-control-exclusions', dispatch, s => replace(s, 'const exclusions = run.attempt > 1', 'const exclusions = false'), 'historical active controls'],
]
const files = ['tests/routine-source-observation.test.ts', 'tests/routine-dispatch.test.ts']
function run(name, pattern) {
  const args = ['vitest', 'run', ...files, '--maxWorkers=2', ...(pattern ? ['-t', pattern] : [])]
  const r = spawnSync('npx', args, { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 })
  const output = (r.stdout ?? '') + (r.stderr ?? '')
  writeFileSync(resolve(dir, `${name}.log`), output)
  return { r, output }
}
const baseline = run('baseline')
if (baseline.r.status !== 0) throw new Error('baseline is not green; no mutation claims')
console.log('baseline: PASS (exit 0)')
let failed = false
try {
  for (const [name, path, mutate, pattern] of mutants) {
    for (const [p, bytes] of originals) writeFileSync(p, bytes)
    writeFileSync(path, mutate(originals.get(path)))
    const { r, output } = run(name, pattern)
    const killed = r.status !== 0 && r.status !== null && /AssertionError/.test(output)
    console.log(`${name}: ${killed ? 'KILLED' : 'UNPROVEN'} (exit ${r.status})`)
    if (!killed) failed = true
  }
} finally {
  for (const [path, bytes] of originals) writeFileSync(path, bytes)
}
process.exitCode = failed ? 1 : 0
