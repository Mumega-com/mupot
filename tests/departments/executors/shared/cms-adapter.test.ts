import { describe, it, expect } from 'vitest'
import { mergeByChangeType, type CmsChangeRequest, type FetchedContent } from '../../../../src/departments/executors/shared/cms-adapter'
import type { CroChangeType } from '../../../../src/departments/change-types'

describe('mergeByChangeType', () => {
  const currentContent: Pick<FetchedContent, 'title' | 'description' | 'content'> = {
    title: 'Original Title',
    description: 'Original description',
    content: 'The original article body. Check out this link: [Example](https://example.com/old). Another line here.',
  }

  const base = {
    slug: 'my-post',
    author: 'jules',
    tags: ['test', 'cms'],
    status: 'published'
  }

  const makeError = (reason: string, message: string) => {
    const err = new Error(message)
    err.name = reason
    return err
  }

  it('handles meta_title and headline change types', () => {
    const changes: CroChangeType[] = ['meta_title', 'headline']

    for (const changeType of changes) {
      const change: CmsChangeRequest = {
        changeType,
        value: 'New Title',
      }

      const { body, diff } = mergeByChangeType(base, currentContent, change, makeError)

      expect(body).toEqual({
        ...base,
        title: 'New Title',
        description: 'Original description',
        content: currentContent.content,
      })

      expect(diff).toEqual({
        changeType,
        field: 'title',
        before: 'Original Title',
        after: 'New Title',
      })
    }
  })

  it('handles meta_description change type', () => {
    const change: CmsChangeRequest = {
      changeType: 'meta_description',
      value: 'New description',
    }

    const { body, diff } = mergeByChangeType(base, currentContent, change, makeError)

    expect(body).toEqual({
      ...base,
      title: 'Original Title',
      description: 'New description',
      content: currentContent.content,
    })

    expect(diff).toEqual({
      changeType: 'meta_description',
      field: 'description',
      before: 'Original description',
      after: 'New description',
    })
  })

  it('handles body_copy change type', () => {
    const change: CmsChangeRequest = {
      changeType: 'body_copy',
      value: 'Brand new body content entirely.',
    }

    const { body, diff } = mergeByChangeType(base, currentContent, change, makeError)

    expect(body).toEqual({
      ...base,
      title: 'Original Title',
      description: 'Original description',
      content: 'Brand new body content entirely.',
    })

    expect(diff).toEqual({
      changeType: 'body_copy',
      field: 'content',
      before: currentContent.content,
      after: 'Brand new body content entirely.',
    })
  })

  describe('substring replacements (cta_text, internal_links, etc.)', () => {
    it('handles successful substring replacement', () => {
      const change: CmsChangeRequest = {
        changeType: 'internal_links',
        findText: '[Example](https://example.com/old)',
        value: '[Example](https://example.com/new)',
      }

      const { body, diff } = mergeByChangeType(base, currentContent, change, makeError)

      expect(body.content).toBe('The original article body. Check out this link: [Example](https://example.com/new). Another line here.')
      expect(body.title).toBe('Original Title')
      expect(body.description).toBe('Original description')

      expect(diff).toEqual({
        changeType: 'internal_links',
        field: 'content',
        before: '[Example](https://example.com/old)',
        after: '[Example](https://example.com/new)',
      })
    })

    it('replaces text verbatim without regex pattern expansion ($$, $&, $`)', () => {
      const change: CmsChangeRequest = {
        changeType: 'cta_text',
        findText: '[Example](https://example.com/old)',
        value: 'New link with $$ and $& and $` and $\'',
      }

      const { body, diff } = mergeByChangeType(base, currentContent, change, makeError)

      expect(body.content).toBe('The original article body. Check out this link: New link with $$ and $& and $` and $\'. Another line here.')
      expect(diff.after).toBe('New link with $$ and $& and $` and $\'')
    })

    it('fails closed when findText is missing', () => {
      const change = {
        changeType: 'cta_text',
        value: 'new text',
      } as CmsChangeRequest // Intentional missing findText

      try {
        mergeByChangeType(base, currentContent, change, makeError)
        expect.fail('Should have thrown')
      } catch (err: any) {
        expect(err.name).toBe('merge_target_missing')
      }
    })

    it('fails closed when findText is not found in content', () => {
      const change: CmsChangeRequest = {
        changeType: 'cta_text',
        findText: 'This text is not in the article',
        value: 'Replacement',
      }

      try {
        mergeByChangeType(base, currentContent, change, makeError)
        expect.fail('Should have thrown')
      } catch (err: any) {
        expect(err.name).toBe('merge_target_not_found')
      }
    })

    it('fails closed when findText is ambiguous (matches multiple times)', () => {
      const repetitiveContent = {
        title: 'Title',
        description: 'Desc',
        content: 'Repeated word. Another Repeated word.',
      }

      const change: CmsChangeRequest = {
        changeType: 'cta_text',
        findText: 'Repeated word',
        value: 'Replacement word',
      }

      try {
        mergeByChangeType(base, repetitiveContent, change, makeError)
        expect.fail('Should have thrown')
      } catch (err: any) {
        expect(err.name).toBe('merge_target_ambiguous')
      }
    })
  })
})
