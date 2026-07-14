// tests/content-intent.test.ts — pure unit tests for detectContentIntent
// (src/agents/content-intent.ts). No I/O, no D1 — just the "publish:" title
// convention + the optional "executor:" body directive.

import { describe, it, expect } from 'vitest'
import { detectContentIntent } from '../src/agents/content-intent'

describe('detectContentIntent', () => {
  it('detects a "publish:" title and uses the body as content', () => {
    const intent = detectContentIntent({
      title: 'publish: Why Inkwell ships drafts, not posts',
      body: 'Inkwell always writes a draft first. A human promotes it.',
    })
    expect(intent).toEqual({
      executor: 'inkwell-content',
      title: 'Why Inkwell ships drafts, not posts',
      content: 'Inkwell always writes a draft first. A human promotes it.',
    })
  })

  it('tolerates no space after the colon and mixed case', () => {
    const intent = detectContentIntent({ title: 'PUBLISH:Launch note', body: 'body text' })
    expect(intent).toEqual({ executor: 'inkwell-content', title: 'Launch note', content: 'body text' })
  })

  it('tolerates extra whitespace around the colon', () => {
    const intent = detectContentIntent({ title: 'publish  :   Spaced title  ', body: 'content' })
    expect(intent?.title).toBe('Spaced title')
  })

  it('reads an "executor: mcpwp" first line and strips it from content', () => {
    const intent = detectContentIntent({
      title: 'publish: WordPress post',
      body: 'executor: mcpwp\nActual article body starts here.\nSecond line.',
    })
    expect(intent).toEqual({
      executor: 'mcpwp',
      title: 'WordPress post',
      content: 'Actual article body starts here.\nSecond line.',
    })
  })

  it('is case-insensitive on the executor directive', () => {
    const intent = detectContentIntent({
      title: 'publish: X',
      body: 'Executor: INKWELL-CONTENT\nbody',
    })
    expect(intent?.executor).toBe('inkwell-content')
  })

  it('ignores an unrecognized executor value — treats the line as content', () => {
    const intent = detectContentIntent({
      title: 'publish: X',
      body: 'executor: wordpress\nbody',
    })
    // 'wordpress' is not in the enum, so the "executor:" line is NOT stripped —
    // it is just the first line of content, and the default executor applies.
    expect(intent).toEqual({
      executor: 'inkwell-content',
      title: 'X',
      content: 'executor: wordpress\nbody',
    })
  })

  it('returns null for an ordinary task (no "publish:" prefix)', () => {
    expect(detectContentIntent({ title: 'Draft the Q3 summary', body: 'notes' })).toBeNull()
  })

  it('returns null when the title is "publish:" with nothing after it', () => {
    expect(detectContentIntent({ title: 'publish:', body: 'some body' })).toBeNull()
    expect(detectContentIntent({ title: 'publish:   ', body: 'some body' })).toBeNull()
  })

  it('returns null when the resulting content is empty (title-only request)', () => {
    expect(detectContentIntent({ title: 'publish: A title with no body', body: '' })).toBeNull()
  })

  it('returns null when content is empty after stripping the executor directive line', () => {
    expect(detectContentIntent({ title: 'publish: X', body: 'executor: mcpwp\n   \n' })).toBeNull()
  })

  it('does not match "publish" without a colon (avoids accidental false positives)', () => {
    expect(detectContentIntent({ title: 'publish the report to slack', body: 'body' })).toBeNull()
  })

  it('a multi-line title after "publish:" is captured in full (dotall)', () => {
    const intent = detectContentIntent({ title: 'publish: Line one\nLine two', body: 'content' })
    expect(intent?.title).toBe('Line one\nLine two')
  })
})
