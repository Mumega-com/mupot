// Single source for fleet_agents.runtime (POST /api/fleet/attach) and the
// check_in harness values that may be stored as a runtime.
//
// Adding grok-cli here makes attach able to write a correct value. attach is
// one of the second writers anchor 49752349 exists to remove. This is a
// deliberate trade: a mislabelled live grok fleet costs this week; the
// architectural convergence (one live-seat attestation surface; fleet_agents,
// agents.model, and presence as projections) lands post-v0.30. Do not treat
// this file as that convergence. Do not change what dispatch reads.
//
// check_in harness names are not this list: attach `codex` ≠ check_in
// `codex-cli`. Unioning them is not cheap. GROK_CLI is the one token both
// surfaces import so they cannot drop the grok spelling independently.

export const GROK_CLI = 'grok-cli' as const

export const FLEET_RUNTIME_KINDS = [
  'codex',
  'claude-code',
  'nous',
  'hermes',
  'hermes-cron',
  'systemd-user',
  'tmux',
  'python',
  'pi',
  'prime-agent',
  'herdr',
  GROK_CLI,
] as const

export type FleetRuntimeKind = (typeof FLEET_RUNTIME_KINDS)[number]

export const FLEET_RUNTIME_KIND_SET: ReadonlySet<string> = new Set(FLEET_RUNTIME_KINDS)
