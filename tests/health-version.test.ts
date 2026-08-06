import { describe, expect, it } from 'vitest'
import { publicHealth } from '../src/health'
import { MUPOT_PUBLIC_API_VERSION } from '../src/version'

describe('public health endpoint', () => {
  it('identifies the deployed public API version without authentication', async () => {
    const releaseSha = 'a'.repeat(40)

    expect(publicHealth('mumega', releaseSha)).toEqual({
      ok: true,
      service: 'mupot',
      tenant: 'mumega',
      version: MUPOT_PUBLIC_API_VERSION,
      commit: releaseSha,
      clean: true,
    })
  })

  it('does not publish an invalid release commit', () => {
    expect(publicHealth('mumega', 'main').commit).toBeNull()
  })

  // mupot#571 fix 2 — a dirty/off-main deploy is stamped with a `-dirty`
  // suffix (scripts/lib/release-sha.mjs releaseShaDeployArgs). The pre-fix
  // publicHealth only recognized a bare 40-hex sha, so this shape either (a)
  // was never produced at all, or (b) if it somehow arrived, was rejected as
  // fully invalid (commit: null) — losing the real commit identity entirely
  // instead of reporting it honestly alongside `clean: false`.
  it('parses a -dirty stamped commit, reporting the real sha with clean:false', () => {
    const sha = 'b'.repeat(40)
    expect(publicHealth('mumega', `${sha}-dirty`)).toEqual({
      ok: true,
      service: 'mupot',
      tenant: 'mumega',
      version: MUPOT_PUBLIC_API_VERSION,
      commit: sha,
      clean: false,
    })
  })

  it('never reports clean:true for anything other than a bare, exact 40-hex sha', () => {
    expect(publicHealth('mumega', undefined).clean).toBe(false)
    expect(publicHealth('mumega', 'main').clean).toBe(false)
    expect(publicHealth('mumega', `${'c'.repeat(40)}-dirty`).clean).toBe(false)
  })
})
