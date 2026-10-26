// tests/helpers/fake-pages-port.ts — a provider-agnostic in-memory PagesPort that SUPPORTS bodies, so the service's
// v2 semantics (body, backlinks, squad-tier visibility) are proven independent of the Inkwell adapter, which
// refuses bodies until inkwell-api stores them. Mirrors the Inkwell store's link rules (additive; identified by
// (to, relation)).
import { PagesPortError, type PageBacklink, type PagePutInput, type PageRecord, type PagesPort } from '../../src/pages/port'

export class FakePagesPort implements PagesPort {
  readonly id = 'fake-memory'
  readonly supportsBody: boolean
  readonly store = new Map<string, PagePutInput>()
  constructor(opts: { supportsBody?: boolean } = {}) {
    this.supportsBody = opts.supportsBody ?? true
  }
  async get(projectId: string, slug: string): Promise<PageRecord | null> {
    const hit = this.store.get(`${projectId}/${slug}`)
    if (!hit) return null
    return {
      slug: hit.slug, title: hit.title, summary: hit.summary, tags: hit.tags, links: hit.links, envelope: hit.envelope,
      ...(hit.body !== undefined && hit.body !== '' ? { body: hit.body } : {}),
    }
  }
  async put(projectId: string, input: PagePutInput) {
    if (input.body !== undefined && input.body !== '' && !this.supportsBody) throw new PagesPortError('unsupported', 'body_unsupported')
    for (const l of input.links) {
      if (!this.store.has(`${projectId}/${l.toSlug}`)) throw new PagesPortError('rejected', 'edge_target_invalid')
    }
    const key = `${projectId}/${input.slug}`
    const prior = this.store.get(key)
    const created = !prior
    const rel = (l: { toSlug: string; relation?: string }) => `${l.toSlug}|${l.relation ?? 'related'}`
    const incoming = input.links.map((l) => ({ toSlug: l.toSlug, relation: l.relation ?? 'related' }))
    const merged = [...(prior?.links ?? []).filter((p) => !incoming.some((n) => rel(n) === rel(p))), ...incoming]
    // body omitted = unchanged (PagePutInput contract)
    const body = input.body !== undefined ? input.body : prior?.body
    this.store.set(key, { ...input, ...(body !== undefined ? { body } : {}), links: merged })
    return { slug: input.slug, created, linksWritten: input.links.length }
  }
  async listBacklinks(projectId: string, slug: string): Promise<PageBacklink[]> {
    const out: PageBacklink[] = []
    for (const [key, page] of this.store) {
      if (!key.startsWith(`${projectId}/`)) continue
      for (const l of page.links) {
        if (l.toSlug === slug) out.push({ slug: page.slug, title: page.title, relation: l.relation, tier: page.envelope.tier })
      }
    }
    return out.sort((a, b) => a.slug.localeCompare(b.slug))
  }
}
