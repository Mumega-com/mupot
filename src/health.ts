import { MUPOT_PUBLIC_API_VERSION } from './version'

export function publicHealth(tenant: string, releaseSha?: string) {
  const commit = /^[0-9a-f]{40}$/i.test(releaseSha ?? '')
    ? releaseSha!.toLowerCase()
    : null

  return {
    ok: true,
    service: 'mupot',
    tenant,
    version: MUPOT_PUBLIC_API_VERSION,
    commit,
  }
}
