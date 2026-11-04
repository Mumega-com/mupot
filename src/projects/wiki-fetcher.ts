// Wiki fetcher selection. Kept out of health.ts so the wiki client (and the project-office worker that
// imports it) never pulls in the build-time generated ./build-info module.

export type WikiBindingMode = 'scoped' | 'legacy_svc' | 'none'

export interface WikiBindingEnv {
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

