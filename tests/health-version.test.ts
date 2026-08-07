import { describe, expect, it } from 'vitest'
import { publicHealth } from '../src/health'
import { MUPOT_PUBLIC_API_VERSION } from '../src/version'
import { BUILD_INFO } from '../src/build-info'
import { generateBuildInfo } from '../scripts/generate-build-info.mjs'

describe('public health endpoint & release truth', () => {
  it('identifies the deployed public API version without authentication', async () => {
    const releaseSha = 'a'.repeat(40)

    expect(publicHealth('mumega', releaseSha)).toEqual({
      ok: true,
      service: 'mupot',
      tenant: 'mumega',
      version: MUPOT_PUBLIC_API_VERSION,
      commit: releaseSha,
      clean: true,
      built_at: BUILD_INFO.builtAt,
    })
  })

  it('falls back to build-time BUILD_INFO when releaseSha is unconfigured or omitted', () => {
    const res = publicHealth('mumega', undefined)
    expect(res.ok).toBe(true)
    expect(res.version).toBe(MUPOT_PUBLIC_API_VERSION)
    expect(res.commit).toBe(BUILD_INFO.commit)
    expect(res.clean).toBe(BUILD_INFO.clean)
    expect(res.built_at).toBe(BUILD_INFO.builtAt)
  })

  it('parses a -dirty stamped commit, reporting the real sha with clean:false', () => {
    const sha = 'b'.repeat(40)
    expect(publicHealth('mumega', `${sha}-dirty`)).toEqual({
      ok: true,
      service: 'mupot',
      tenant: 'mumega',
      version: MUPOT_PUBLIC_API_VERSION,
      commit: sha,
      clean: false,
      built_at: BUILD_INFO.builtAt,
    })
  })

  it('generateBuildInfo script creates non-null build info timestamp', () => {
    const info = generateBuildInfo()
    expect(info.commit).toMatch(/^[0-9a-f]{40}$/i)
    expect(typeof info.clean).toBe('boolean')
    expect(typeof info.builtAt).toBe('string')
  })
})
