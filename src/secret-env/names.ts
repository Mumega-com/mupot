import { ENV_REVIEWED_BINDING_NAMES, RESERVED_BINDING_PREFIXES } from './env-reviewed-names'

const BINDING_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/

export const RESERVED_BINDING_NAMES: ReadonlySet<string> = new Set([
  'DB',
  'AI',
  'QUEUE',
  'TENANT_SLUG',
  'MUPOT_HANDOFF_PUBLIC_KEY',
  'OAUTH_CLIENT_SECRET',
  'BOOTSTRAP_OWNER_TOKEN',
  'CONNECTOR_MASTER_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'BUS_TOKEN',
  'GITHUB_TOKEN',
  'GITHUB_WEBHOOK_SECRET',
  'AI_GATEWAY_TOKEN',
  'IM_WEBHOOK_SECRET',
  'HERMES_RELAY_SECRET',
  'PROJECT_LINK_SIGNING_KEY',
  'EXEC_MAX_TOKENS_DAY',
  'SECRET_ENV_CF_API_TOKEN',
  'SECRET_ENV_CF_ACCOUNT_ID',
  'SECRET_ENV_CF_SCRIPT_NAME',
  'FLEET_PANEL_SK',
  'BILLING_PLAN_SECRET',
  'CC_SPEND_SECRET',
  'GHL_API_KEY',
  'GHL_WEBHOOK_SECRET',
  'POSTHOG_PERSONAL_API_KEY',
])

/** True when the worker owns/reads this name: hand-kept denylist OR any Env-declared key OR a reserved prefix. */
export function isReservedBindingName(name: string): boolean {
  return (
    RESERVED_BINDING_NAMES.has(name)
    || ENV_REVIEWED_BINDING_NAMES.has(name)
    || RESERVED_BINDING_PREFIXES.some((prefix) => name.startsWith(prefix))
  )
}

export function isValidBindingName(name: string): boolean {
  if (!BINDING_NAME_RE.test(name)) {
    return false
  }
  if (isReservedBindingName(name)) {
    return false
  }
  return true
}

export function assertBindingName(name: string): void {
  if (!BINDING_NAME_RE.test(name)) {
    throw new Error('invalid_binding_name')
  }
  if (isReservedBindingName(name)) {
    throw new Error('reserved_binding_name')
  }
}
