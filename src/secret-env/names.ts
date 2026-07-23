const BINDING_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/

export const RESERVED_BINDING_NAMES: ReadonlySet<string> = new Set([
  'DB',
  'AI',
  'QUEUE',
  'TENANT_SLUG',
  'CONNECTOR_MASTER_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
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

export function isValidBindingName(name: string): boolean {
  if (!BINDING_NAME_RE.test(name)) {
    return false
  }
  if (RESERVED_BINDING_NAMES.has(name)) {
    return false
  }
  return true
}

export function assertBindingName(name: string): void {
  if (!BINDING_NAME_RE.test(name)) {
    throw new Error('invalid_binding_name')
  }
  if (RESERVED_BINDING_NAMES.has(name)) {
    throw new Error('reserved_binding_name')
  }
}
