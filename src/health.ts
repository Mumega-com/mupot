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
    ref: BUILD_INFO.ref,
    built_at: BUILD_INFO.builtAt,
  }
}

export type WikiBindingMode = 'scoped' | 'legacy_svc' | 'none'

interface WikiBindingEnv {
  INKWELL_WIKI?: Fetcher
  INKWELL_SVC?: Fetcher
}

/**
 * The internal wiki prefers the dedicated INKWELL_WIKI binding (carries scoped
 * ctx.props.wiki); it falls back to the unscoped INKWELL_SVC only when absent,
 * so behaviour is unchanged until the binding is configured. Connectors and
 * addons never call this: they stay on INKWELL_SVC.
 */
export function wikiFetcher(env: WikiBindingEnv): Fetcher | undefined {
  return env.INKWELL_WIKI ?? env.INKWELL_SVC
}

/** Non-secret: which fetcher the wiki uses. Props are not readable caller-side; see scripts/check-inkwell-wiki-binding.mjs. */
export function wikiBindingMode(env: WikiBindingEnv): WikiBindingMode {
  if (env.INKWELL_WIKI) return 'scoped'
  return env.INKWELL_SVC ? 'legacy_svc' : 'none'
}

/** Body of GET /health: the public identity payload plus the non-secret wiki fetcher mode. */
export function healthPayload(env: WikiBindingEnv & { TENANT_SLUG: string; RELEASE_SHA?: string }) {
  return { ...publicHealth(env.TENANT_SLUG, env.RELEASE_SHA), wiki_binding: wikiBindingMode(env) }
}
