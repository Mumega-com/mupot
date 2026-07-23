// Strip internal lifecycle authority fields from untrusted external bodies.
//
// via_completion_gate / via_start_gate / lifecycle_principal / completion_proposed_by
// are owned exclusively by completion-gate.ts / start-gate.ts (and archive lessons).
// External surfaces (REST PATCH, MCP project_update, dashboard forms) must never
// forward them into updateProject — otherwise an admin body can forge gate passage.

export const LIFECYCLE_INTERNAL_FIELDS = [
  'via_completion_gate',
  'via_start_gate',
  'lifecycle_principal',
  'completion_proposed_by',
] as const

export type LifecycleInternalField = (typeof LIFECYCLE_INTERNAL_FIELDS)[number]

/**
 * Return a shallow copy of `body` with every internal lifecycle field removed.
 * Does not mutate the input. Safe to call on any plain object body.
 */
export function stripExternalLifecycleFields<T extends Record<string, unknown>>(
  body: T,
): Omit<T, LifecycleInternalField> {
  const out: Record<string, unknown> = { ...body }
  for (const key of LIFECYCLE_INTERNAL_FIELDS) {
    delete out[key]
  }
  return out as Omit<T, LifecycleInternalField>
}

/** True when the body still carries any internal lifecycle authority field. */
export function hasExternalLifecycleFields(body: Record<string, unknown>): boolean {
  return LIFECYCLE_INTERNAL_FIELDS.some((key) => Object.prototype.hasOwnProperty.call(body, key))
}
