import type { Env } from '../types'

export interface SecretEnvCfConfig {
  accountId: string
  scriptName: string
  apiToken: string
}

export function getSecretEnvCfConfig(env: Env): SecretEnvCfConfig | null {
  const accountId = env.SECRET_ENV_CF_ACCOUNT_ID?.trim() ?? ''
  const scriptName = env.SECRET_ENV_CF_SCRIPT_NAME?.trim() ?? ''
  const apiToken = env.SECRET_ENV_CF_API_TOKEN?.trim() ?? ''
  if (!accountId || !scriptName || !apiToken) return null
  return { accountId, scriptName, apiToken }
}

function scriptSecretsUrl(config: SecretEnvCfConfig): string {
  return (
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}` +
    `/workers/scripts/${encodeURIComponent(config.scriptName)}/secrets`
  )
}

export async function putScriptSecrets(
  config: SecretEnvCfConfig,
  secrets: ReadonlyArray<{ name: string; text: string }>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  for (const secret of secrets) {
    const res = await fetchImpl(scriptSecretsUrl(config), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: secret.name, text: secret.text, type: 'secret_text' }),
    })
    if (!res.ok) {
      return { ok: false, error: 'cf_secrets_put_failed', status: res.status }
    }
  }
  return { ok: true }
}

export async function deleteScriptSecret(
  config: SecretEnvCfConfig,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const url = `${scriptSecretsUrl(config)}/${encodeURIComponent(name)}`
  const res = await fetchImpl(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
    },
  })
  if (!res.ok) {
    return { ok: false, error: 'cf_secrets_delete_failed' }
  }
  return { ok: true }
}
