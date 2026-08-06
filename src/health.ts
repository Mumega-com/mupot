import { MUPOT_PUBLIC_API_VERSION } from './version'

const CLEAN_SHA_RE = /^[0-9a-f]{40}$/i
// mupot#571: a dirty tree or an off-main HEAD gets a `-dirty` suffix at deploy
// time (scripts/lib/release-sha.mjs `releaseShaDeployArgs`) instead of a bare
// sha — never advertise a "clean-looking" commit identity from an unverified
// build. This is the parse side: it splits the suffix back out but ALWAYS
// reports `clean: false` for it, never silently upgrading it to look clean.
const DIRTY_SHA_RE = /^([0-9a-f]{40})-dirty$/i

export function publicHealth(tenant: string, releaseSha?: string) {
  let commit: string | null = null
  let clean = false

  if (typeof releaseSha === 'string') {
    if (CLEAN_SHA_RE.test(releaseSha)) {
      commit = releaseSha.toLowerCase()
      clean = true
    } else {
      const dirty = releaseSha.match(DIRTY_SHA_RE)
      if (dirty) {
        commit = dirty[1].toLowerCase()
        clean = false
      }
    }
  }

  return {
    ok: true,
    service: 'mupot',
    tenant,
    version: MUPOT_PUBLIC_API_VERSION,
    commit,
    clean,
  }
}
