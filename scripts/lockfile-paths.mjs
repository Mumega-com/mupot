// lockfile-paths — enumerate every causal path from a project root edge to an
// installed package NODE, using package-lock.json as ground truth.
//
// WHY THIS READS THE LOCKFILE AND NOT `npm audit --json`
//
// Three consecutive versions of the audit gate bound a PROJECTION of the dependency
// graph and each was bypassed:
//
//   `nodes`            an install LOCATION. Adding undici directly kept it identical.
//   ancestry name set  a flattened closure of dependent NAMES. Making miniflare direct
//                      kept it identical.
//   name-keyed paths   `npm audit --json` keys `vulnerabilities` by package NAME, so
//                      `wrangler-alias@npm:wrangler@4.102.0` — a second, distinct root
//                      edge — collapsed into the same "wrangler > miniflare > undici"
//                      chain and the gate passed with zero violations.
//
// The audit summary cannot express node identity, aliases, or version-distinct copies
// of the same name, because its own key space is names. No amount of care in reading it
// fixes that. The lockfile is keyed by NODE PATH, which is the identity that actually
// exists on disk, so that is what this reads.
//
// Path elements are `<lockfile path>@<resolved version>`, which distinguishes an alias
// (different path, same name) and two versions of one package (same name, different
// path and version). Root edges come from the lockfile's own root record, so a
// dependency added directly always creates a new path rather than reusing an old one.
//
// WORKSPACES ARE ROOT EDGES. npm records a workspace as a `link: true` node in
// node_modules whose `resolved` points at the workspace directory. Skipping link records
// disconnected every workspace's dependencies from the graph, so a workspace with a
// direct dependency on miniflare contributed no path at all and the gate passed (bypass
// 7). Each link is now an edge root -> link -> workspace directory, and a link whose
// target is missing fails closed.
//
// NODE IDENTITY IS NOT PATH PLUS VERSION. A locally built tarball named wrangler@4.102.0
// produced a byte-identical path while being a completely different artifact (bypass 8).
// Identity therefore carries the normalized `resolved` source and `integrity` digest, so
// substituting the artifact under an unchanged name and version changes the path.
//
// AMBIGUITY FAILS CLOSED. A declared dependency that resolves to no lockfile node, a
// target absent from the lockfile, or a node with no path to a root edge are all
// reported as errors rather than silently producing a plausible-looking path. The
// previous version synthesized a root for a missing record and quietly dropped cycle
// back-edges, which meant a malformed graph could return the accepted answer.

export class LockfileGraphError extends Error {}

/**
 * npm resolution: from a package at `fromPath`, a dependency `name` is found by walking
 * up the node_modules chain — nearest wins. Returns the winning lockfile key.
 */
function resolveDep(packages, fromPath, name) {
  const segments = fromPath === '' ? [] : fromPath.split('/node_modules/')
  for (let depth = segments.length; depth >= 0; depth -= 1) {
    const prefix = depth === 0 ? '' : `${segments.slice(0, depth).join('/node_modules/')}/`
    const candidate = `${prefix}node_modules/${name}`
    if (Object.hasOwn(packages, candidate)) return candidate
  }
  return null
}

/**
 * Declared dependency names of a lockfile record, each flagged with whether it is
 * ALLOWED to be absent. Root also contributes devDependencies — that is what makes a
 * directly-added package a new root edge.
 *
 * Optional deps and optional peers legitimately go uninstalled, so their absence is not
 * evidence of a broken graph. Everything else must resolve.
 */
function declaredDeps(record, isProject) {
  const out = new Map()
  const add = (name, optional) => {
    if (!out.has(name) || out.get(name) === true) out.set(name, optional)
  }
  for (const name of Object.keys(record?.dependencies ?? {})) add(name, false)
  // devDependencies are installed for the root AND for every workspace — a workspace's
  // devDependency is a real root edge into the tree, which is what bypass 7 exploited.
  if (isProject) for (const name of Object.keys(record?.devDependencies ?? {})) add(name, false)
  for (const name of Object.keys(record?.optionalDependencies ?? {})) add(name, true)
  for (const name of Object.keys(record?.peerDependencies ?? {})) {
    add(name, Boolean(record?.peerDependenciesMeta?.[name]?.optional))
  }
  return [...out.entries()]
}

/**
 * Build the forward edge map: lockfile path -> [lockfile path].
 *
 * Unresolvable declared dependencies are collected rather than skipped. An edge we
 * cannot resolve means the graph we are about to reason over is incomplete, and a gate
 * must not draw conclusions from an incomplete graph.
 */
export function buildGraph(lock) {
  const packages = lock?.packages
  if (!packages || typeof packages !== 'object') {
    throw new LockfileGraphError('package-lock.json has no `packages` map (lockfileVersion 2+ required)')
  }
  const edges = new Map()
  const unresolved = []
  const rootExtra = []
  for (const [path, record] of Object.entries(packages)) {
    if (record?.link) {
      // A workspace. Previously skipped, which disconnected the workspace's own
      // dependencies from the graph entirely (bypass 7). A workspace IS a root edge:
      // root -> link node -> workspace directory record.
      const target = record.resolved
      if (!target || !Object.hasOwn(packages, target)) {
        unresolved.push(`${path} -> link target ${target ?? '<missing>'}`)
        continue
      }
      edges.set(path, [target])
      rootExtra.push(path)
      continue
    }
    const targets = []
    // Project records — the root and every workspace directory — live outside
    // node_modules and contribute their devDependencies.
    const isProject = !path.includes('node_modules/')
    for (const [name, optional] of declaredDeps(record, isProject)) {
      const to = resolveDep(packages, path, name)
      if (to === null) {
        if (optional) continue // legitimately uninstalled, not a gap in the graph
        unresolved.push(`${path || '<root>'} -> ${name}`)
        continue
      }
      targets.push(to)
    }
    edges.set(path, targets)
  }
  // Attach every workspace link as a root edge. Workspaces are not necessarily listed in
  // the root's dependencies, so without this they are reachable from nothing.
  if (rootExtra.length > 0) {
    edges.set('', [...new Set([...(edges.get('') ?? []), ...rootExtra])])
  }
  return { edges, packages, unresolved }
}

/**
 * Identity of an installed node.
 *
 * Path plus version was NOT enough (bypass 8): a local tarball built as
 * wrangler@4.102.0 occupied the same path at the same version and produced a
 * byte-identical path, while being a different artifact entirely. `integrity` pins the
 * bytes; `resolved` pins where they came from, and is what changes for a `file:` or git
 * source that carries no integrity. Both are normalized so incidental registry-URL
 * differences do not churn the allowlist.
 */
function identity(packages, path) {
  const record = packages[path] ?? {}
  const version = record.version ?? 'unknown'
  const source = record.integrity
    ?? (record.resolved ? `resolved:${String(record.resolved).replace(/^https?:\/\/[^/]+/, 'registry:')}` : null)
    ?? (record.link ? `link:${record.resolved ?? 'unknown'}` : 'source:unknown')
  return `${path}@${version}#${source}`
}

/** Hard bound: a combinatorial blow-up must fail closed, not hang or truncate. */
export const MAX_PATHS = 512

/**
 * Every simple path from the lockfile root to `targetPath`, root-first, as arrays of
 * `<path>@<version>` identities. Sorted for stable comparison.
 *
 * ON CYCLES. Real lockfiles contain legitimate cycles in subtrees that have nothing to
 * do with the target (browserslist <-> update-browserslist-db is in this very tree), so
 * throwing on any cycle anywhere would make the gate unusable. Revisits are pruned,
 * which is exactly simple-path semantics: a cycle cannot create a NEW simple path from
 * root to target, so pruning loses nothing.
 *
 * This is NOT the cycle-erasure that review objected to in the previous version. There,
 * the input was `npm audit`'s effects SUMMARY, dropping a back-edge silently returned
 * the accepted answer, and a malformed summary was indistinguishable from a good one.
 * Here the input is the lockfile itself — ground truth rather than a projection of it —
 * so a cycle is a fact about the dependency graph, not evidence the graph is unreliable.
 */
export function pathsToNode(lock, targetPath) {
  const { edges, packages, unresolved } = buildGraph(lock)

  if (unresolved.length > 0) {
    throw new LockfileGraphError(
      `cannot resolve ${unresolved.length} declared dependency edge(s) — the dependency ` +
      `graph is incomplete and must not be used to justify an exemption:\n    ` +
      unresolved.slice(0, 10).join('\n    '),
    )
  }
  if (!Object.hasOwn(packages, targetPath)) {
    throw new LockfileGraphError(`target ${targetPath} is not present in package-lock.json`)
  }

  // Restrict the search to nodes that can actually reach the target. Without this the
  // walk explores the entire tree, which is both slow and pointless.
  const reverse = new Map()
  for (const [from, tos] of edges) {
    for (const to of tos) {
      if (!reverse.has(to)) reverse.set(to, [])
      reverse.get(to).push(from)
    }
  }
  const relevant = new Set([targetPath])
  const queue = [targetPath]
  while (queue.length > 0) {
    for (const parent of reverse.get(queue.pop()) ?? []) {
      if (relevant.has(parent)) continue
      relevant.add(parent)
      queue.push(parent)
    }
  }
  if (!relevant.has('')) {
    throw new LockfileGraphError(
      `${targetPath} is in the lockfile but reachable from no root dependency edge — ` +
      `refusing to treat an orphan as an accepted transitive dependency`,
    )
  }

  const found = []
  const stack = []
  const onStack = new Set()

  const walk = (current) => {
    if (current === targetPath && stack.length > 0) {
      found.push([...stack.slice(1), current].map((p) => identity(packages, p)))
      return
    }
    if (found.length > MAX_PATHS) return
    onStack.add(current)
    stack.push(current)
    for (const next of edges.get(current) ?? []) {
      if (!relevant.has(next) || onStack.has(next)) continue
      walk(next)
    }
    stack.pop()
    onStack.delete(current)
  }

  walk('')

  if (found.length > MAX_PATHS) {
    throw new LockfileGraphError(
      `more than ${MAX_PATHS} distinct paths reach ${targetPath} — refusing to compare a ` +
      `truncated path set, which would silently accept an unreviewed route`,
    )
  }
  if (found.length === 0) {
    throw new LockfileGraphError(`no path from the lockfile root to ${targetPath}`)
  }

  return [...new Set(found.map((p) => JSON.stringify(p)))].sort().map((p) => JSON.parse(p))
}
