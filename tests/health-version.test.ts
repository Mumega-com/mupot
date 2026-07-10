import { describe, expect, it } from 'vitest'
import { publicHealth } from '../src/health'
import { MUPOT_PUBLIC_API_VERSION } from '../src/version'

describe('public health endpoint', () => {
  it('identifies the deployed public API version without authentication', async () => {
    expect(publicHealth('mumega')).toEqual({
      ok: true,
      service: 'mupot',
      tenant: 'mumega',
      version: MUPOT_PUBLIC_API_VERSION,
    })
  })
})
