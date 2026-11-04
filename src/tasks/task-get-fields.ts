// The column set the single-task readers expose. ONE definition, shared by MCP task_get and the bearer branch of
// GET /api/tasks/:id (#2308), so the two can never drift apart.
export const TASK_GET_FIELDS = [
  'id', 'squad_id', 'project_id', 'title', 'body', 'done_when', 'status', 'assignee_agent_id',
  'assignee_member_id', 'gate_owner', 'result', 'execution_receipt_id', 'completed_at',
  'created_at', 'updated_at',
] as const
