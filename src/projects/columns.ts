/** Canonical project column list. Every reader must project these fields. */

export const PROJECT_COLUMN_LIST = [
  'id',
  'slug',
  'name',
  'description',
  'goal',
  'status',
  'parent_project_id',
  'target_date',
  'cycle_boundary_at',
  'stalled',
  'stall_threshold_days',
  'completion_proposed_by',
  'repo_url',
  'worker_name',
  'live_url',
  'assigned_squad_id',
  'deploy_status',
  'created_at',
  'updated_at',
] as const

export function projectSelectSql(alias?: string): string {
  const prefix = alias ? `${alias}.` : ''
  return PROJECT_COLUMN_LIST.map((column) => `${prefix}${column}`).join(', ')
}
