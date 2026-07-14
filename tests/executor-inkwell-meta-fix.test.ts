// tests/executor-inkwell-meta-fix.test.ts — mupot Flight 2 slice 1.
//
// Unit coverage for toMetaFixPublishBody (executors/inkwell.ts): the seo-meta-fix
// payload mapper that REQUIRES a target slug and FORCES overwrite=true, distinct
// from toPublishBody's create-new-friendly defaults (slug optional/auto-derived,
// overwrite defaults false).

import { describe, it, expect } from 'vitest'
import { toMetaFixPublishBody, toPublishBody } from '../src/departments/executors/inkwell'

describe('toMetaFixPublishBody', () => {
  it('maps a valid meta-fix payload, forcing overwrite=true regardless of input', () => {
    const b = toMetaFixPublishBody({
      slug: 'existing-post',
      title: 'Better Title for AEO',
      content: 'unchanged body',
      description: 'better meta description',
      tags: ['seo', 'geo'],
      overwrite: false, // caller/stored value — must be ignored, forced true below
    })
    expect(b).toEqual({
      title: 'Better Title for AEO',
      content: 'unchanged body',
      slug: 'existing-post',
      author: 'mupot',
      tags: ['seo', 'geo'],
      description: 'better meta description',
      status: 'draft',
      overwrite: true,
    })
  })

  it('forces overwrite=true even when the payload omits overwrite entirely', () => {
    const b = toMetaFixPublishBody({ slug: 's', title: 't', content: 'c' })
    expect(b?.overwrite).toBe(true)
  })

  it('returns null (fail-closed) when slug is missing — never falls back to slug-from-title', () => {
    // toPublishBody WOULD auto-derive a slug from the title in this exact case —
    // confirm that create-new behavior does NOT leak into the meta-fix mapper.
    const created = toPublishBody({ title: 'My Title', content: 'c' })
    expect(created?.slug).toBeUndefined() // toPublishBody itself doesn't slugify; Inkwell does
    expect(toMetaFixPublishBody({ title: 'My Title', content: 'c' })).toBeNull()
  })

  it('returns null when slug is an empty string', () => {
    expect(toMetaFixPublishBody({ slug: '', title: 't', content: 'c' })).toBeNull()
  })

  it('returns null when title or content is missing (delegates to toPublishBody)', () => {
    expect(toMetaFixPublishBody({ slug: 's', content: 'c' })).toBeNull()
    expect(toMetaFixPublishBody({ slug: 's', title: 't' })).toBeNull()
    expect(toMetaFixPublishBody(null)).toBeNull()
  })

  it('honours an explicit published/archived status like toPublishBody does', () => {
    expect(toMetaFixPublishBody({ slug: 's', title: 't', content: 'c', status: 'published' })?.status).toBe(
      'published',
    )
  })
})
