import { MUPOT_PUBLIC_API_VERSION } from './version'
import { BUILD_INFO } from './build-info'

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

  const shaToUse = (typeof releaseSha === 'string' && releaseSha.trim().length > 0)
    ? releaseSha
    : BUILD_INFO.commit

  if (typeof shaToUse === 'string') {
    if (CLEAN_SHA_RE.test(shaToUse)) {
      commit = shaToUse.toLowerCase()
      clean = (shaToUse === BUILD_INFO.commit) ? BUILD_INFO.clean : true
    } else {
      const dirty = shaToUse.match(DIRTY_SHA_RE)
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
    built_at: BUILD_INFO.builtAt,
  }
}
