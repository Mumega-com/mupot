import { MUPOT_PUBLIC_API_VERSION } from './version'

export function publicHealth(tenant: string) {
  return {
    ok: true,
    service: 'mupot',
    tenant,
    version: MUPOT_PUBLIC_API_VERSION,
  }
}
