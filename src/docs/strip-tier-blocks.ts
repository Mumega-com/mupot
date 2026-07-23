/**
 * Block-level "rbac text" — server-side strip of remark-directive / <Tier> MDX.
 *
 * Syntax (either form tags a BLOCK with its own content tier):
 *   :::tier{squad}
 *   …body…
 *   :::
 *
 *   <Tier require="squad">…body…</Tier>
 *
 * Blocks the viewer cannot claim are removed from the payload BEFORE it leaves
 * the Worker / build step — never CSS-hidden client-side. Decisions go through
 * the same `checkContentTier` keystone as document-level gating (no parallel
 * agent-RBAC). Cerbos WASM PDP is deferred (slice 6) — do not introduce here.
 *
 * Greenfield: no OSS MDX plugin does role-based block stripping. This is the
 * MDX analog of a Postgres RLS row-predicate, applied per block.
 */

import {
  checkContentTier,
  type ContentTier,
  type ContentTierContext,
  type TierClaims,
} from './content-tier'

const CONTENT_TIERS: ReadonlySet<string> = new Set([
  'public',
  'squad',
  'project',
  'role',
  'entity',
  'private',
])

/** Document-level defaults applied when a block omits entity_id / created_by. */
export interface TierBlockDefaults {
  entity_id: string | undefined
  created_by: string | undefined
}

export interface StripTierBlocksOptions {
  claims: TierClaims | null
  defaults: TierBlockDefaults
}

interface ParsedTierAttrs {
  tier: ContentTier
  entity_id: string | undefined
  created_by: string | undefined
  permitted_roles: string[] | undefined
}

/**
 * Parse the `{…}` attribute blob from `:::tier{…}` / directive attrs.
 * Accepts:
 *   {squad}                         → tier=squad
 *   {require=squad} / {tier=squad}  → tier=squad
 *   {private entity_id="org-1"}     → tier + attrs
 *   {private created_by=alice}      → tier + attrs
 *   {squad permitted_roles="a,b"}   → tier + role allowlist
 */
export function parseTierDirectiveAttrs(raw: string): ParsedTierAttrs {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    throw new Error('strip-tier-blocks: empty :::tier{} attributes')
  }

  const tokens = tokenizeAttrs(trimmed)
  if (tokens.length === 0) {
    throw new Error('strip-tier-blocks: empty :::tier{} attributes')
  }

  let tier: ContentTier | undefined
  let entity_id: string | undefined
  let created_by: string | undefined
  let permitted_roles: string[] | undefined

  for (const token of tokens) {
    if (!token.includes('=')) {
      if (!CONTENT_TIERS.has(token)) {
        throw new Error(`strip-tier-blocks: unknown tier '${token}'`)
      }
      if (tier !== undefined) {
        throw new Error('strip-tier-blocks: multiple bare tier names in attributes')
      }
      tier = token as ContentTier
      continue
    }

    const eq = token.indexOf('=')
    const key = token.slice(0, eq).trim()
    const value = unquote(token.slice(eq + 1).trim())

    if (key === 'require' || key === 'tier') {
      if (!CONTENT_TIERS.has(value)) {
        throw new Error(`strip-tier-blocks: unknown tier '${value}'`)
      }
      tier = value as ContentTier
    } else if (key === 'entity_id') {
      entity_id = value
    } else if (key === 'created_by') {
      created_by = value
    } else if (key === 'permitted_roles') {
      permitted_roles = value
        .split(',')
        .map((role) => role.trim())
        .filter((role) => role.length > 0)
    } else {
      throw new Error(`strip-tier-blocks: unknown attribute '${key}'`)
    }
  }

  if (tier === undefined) {
    throw new Error('strip-tier-blocks: :::tier block missing tier name')
  }

  return { tier, entity_id, created_by, permitted_roles }
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

/** Split an attribute blob on whitespace outside of quotes. */
function tokenizeAttrs(raw: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!
    if (quote !== null) {
      current += ch
      if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      current += ch
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }

  if (current.length > 0) {
    tokens.push(current)
  }
  return tokens
}

function resolveContext(
  attrs: ParsedTierAttrs,
  defaults: TierBlockDefaults,
): ContentTierContext {
  return {
    tier: attrs.tier,
    entity_id: attrs.entity_id ?? defaults.entity_id,
    created_by: attrs.created_by ?? defaults.created_by,
    permitted_roles: attrs.permitted_roles,
  }
}

/**
 * Strip one balanced region starting at `openEnd` (index after the open tag),
 * returning the index after the matching close and whether the body was kept.
 */
interface RegionResult {
  /** Index just after the close delimiter. */
  end: number
  /** Body with nested strips already applied (only meaningful when kept). */
  body: string
  kept: boolean
}

/**
 * Recursively strip tier-gated regions from MDX/markdown source.
 * Public (ungated) text is preserved verbatim. Denied blocks — including
 * their markers — are removed entirely so private text is absent from the
 * returned payload.
 */
export function stripTierBlocks(source: string, options: StripTierBlocksOptions): string {
  return stripRegions(source, options)
}

function stripRegions(source: string, options: StripTierBlocksOptions): string {
  let out = ''
  let i = 0

  while (i < source.length) {
    const directiveOpen = matchDirectiveOpen(source, i)
    if (directiveOpen !== null) {
      const region = consumeDirectiveRegion(source, directiveOpen, options)
      if (region.kept) {
        out += region.body
      }
      i = region.end
      continue
    }

    const tierOpen = matchTierJsxOpen(source, i)
    if (tierOpen !== null) {
      const region = consumeTierJsxRegion(source, tierOpen, options)
      if (region.kept) {
        out += region.body
      }
      i = region.end
      continue
    }

    out += source[i]!
    i += 1
  }

  return out
}

interface DirectiveOpen {
  attrsRaw: string
  /** Index of first char of the body (after the opening line's newline, if any). */
  bodyStart: number
}

function matchDirectiveOpen(source: string, index: number): DirectiveOpen | null {
  // Only match at line start (or start of string) — remark-directive container form.
  if (index > 0 && source[index - 1] !== '\n') {
    return null
  }

  const slice = source.slice(index)
  const match = /^:::tier\{([^}]*)\}[ \t]*(?:\r?\n|$)/.exec(slice)
  if (match === null) {
    return null
  }

  return {
    attrsRaw: match[1]!,
    bodyStart: index + match[0].length,
  }
}

function consumeDirectiveRegion(
  source: string,
  open: DirectiveOpen,
  options: StripTierBlocksOptions,
): RegionResult {
  const attrs = parseTierDirectiveAttrs(open.attrsRaw)
  const ctx = resolveContext(attrs, options.defaults)
  const allowed = checkContentTier(ctx, options.claims).allowed

  // Scan body for nested opens / the closing `:::` at line start.
  let i = open.bodyStart
  let body = ''

  while (i < source.length) {
    if (isLineStart(source, i)) {
      const close = /^:::[ \t]*(?:\r?\n|$)/.exec(source.slice(i))
      if (close !== null) {
        const nestedBody = stripRegions(body, options)
        return {
          end: i + close[0].length,
          body: nestedBody,
          kept: allowed,
        }
      }

      const nestedOpen = matchDirectiveOpen(source, i)
      if (nestedOpen !== null) {
        // Always consume nested regions so we can find our closing `:::`.
        // Only splice kept nested bodies into a kept parent.
        const nested = consumeDirectiveRegion(source, nestedOpen, options)
        if (allowed && nested.kept) {
          body += nested.body
        }
        i = nested.end
        continue
      }
    }

    const nestedJsx = matchTierJsxOpen(source, i)
    if (nestedJsx !== null) {
      const nested = consumeTierJsxRegion(source, nestedJsx, options)
      if (allowed && nested.kept) {
        body += nested.body
      }
      i = nested.end
      continue
    }

    body += source[i]!
    i += 1
  }

  throw new Error('strip-tier-blocks: unclosed :::tier directive')
}

interface TierJsxOpen {
  requireRaw: string
  bodyStart: number
  selfClosing: boolean
}

function matchTierJsxOpen(source: string, index: number): TierJsxOpen | null {
  const slice = source.slice(index)
  // <Tier require="squad"> or <Tier require='squad' /> or <Tier require=squad>
  const match =
    /^<Tier\s+require\s*=\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z][A-Za-z0-9_-]*))\s*(\/)?>/.exec(
      slice,
    )
  if (match === null) {
    return null
  }

  const requireRaw = match[1] ?? match[2] ?? match[3] ?? ''
  return {
    requireRaw,
    bodyStart: index + match[0].length,
    selfClosing: match[4] === '/',
  }
}

function consumeTierJsxRegion(
  source: string,
  open: TierJsxOpen,
  options: StripTierBlocksOptions,
): RegionResult {
  const attrs = parseTierDirectiveAttrs(open.requireRaw)
  const ctx = resolveContext(attrs, options.defaults)
  const allowed = checkContentTier(ctx, options.claims).allowed

  if (open.selfClosing) {
    return { end: open.bodyStart, body: '', kept: allowed }
  }

  let i = open.bodyStart
  let body = ''
  let depth = 1

  while (i < source.length) {
    if (source.startsWith('</Tier>', i)) {
      depth -= 1
      if (depth === 0) {
        const nestedBody = stripRegions(body, options)
        return {
          end: i + '</Tier>'.length,
          body: nestedBody,
          kept: allowed,
        }
      }
      body += '</Tier>'
      i += '</Tier>'.length
      continue
    }

    const nestedOpen = matchTierJsxOpen(source, i)
    if (nestedOpen !== null) {
      if (nestedOpen.selfClosing) {
        const nested = consumeTierJsxRegion(source, nestedOpen, options)
        if (allowed && nested.kept) {
          body += nested.body
        }
        i = nested.end
        continue
      }
      // Nested open increases depth; consume via recursive call so its close
      // is not mistaken for ours.
      const nested = consumeTierJsxRegion(source, nestedOpen, options)
      if (allowed && nested.kept) {
        body += nested.body
      }
      i = nested.end
      continue
    }

    const nestedDirective = matchDirectiveOpen(source, i)
    if (nestedDirective !== null) {
      const nested = consumeDirectiveRegion(source, nestedDirective, options)
      if (allowed && nested.kept) {
        body += nested.body
      }
      i = nested.end
      continue
    }

    body += source[i]!
    i += 1
  }

  throw new Error('strip-tier-blocks: unclosed <Tier> component')
}

function isLineStart(source: string, index: number): boolean {
  return index === 0 || source[index - 1] === '\n'
}

/**
 * Edge/build render helper: strip gated blocks, then normalize excess blank
 * lines left behind by removals. The returned string is the payload a viewer
 * may receive — private text must not appear in it.
 */
export function renderDocPayloadForClaims(
  source: string,
  options: StripTierBlocksOptions,
): string {
  const stripped = stripTierBlocks(source, options)
  return stripped.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '\n')
}
