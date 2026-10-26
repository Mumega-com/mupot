// First-line reply parser. Pure. Only the first non-empty line BEFORE any quote marker is read; the quoted card text
// ("Reply yes to approve") must never be evaluated. Anything not an exact anchored yes/no is `unclear` (fail closed).

export type ReplyIntent = { readonly intent: 'approve' } | { readonly intent: 'reject'; readonly note: string | null } | { readonly intent: 'unclear' }

const UNCLEAR: ReplyIntent = { intent: 'unclear' }
const APPROVE = new Set(['yes', 'y', 'approve', 'approved'])
const REJECT = new Set(['no', 'n', 'reject', 'rejected'])
const MAX_NOTE = 500

// Zero-width / BOM / bidi controls that would let a line look empty or hide characters.
const INVISIBLE = /[​-‏‪-‮⁠-⁤﻿]/g
const TRAILING_EMOJI = /[\s\p{Extended_Pictographic}️‍\u{1F3FB}-\u{1F3FF}]+$/u

function isQuoteBoundary(line: string, next: string | undefined): boolean {
  const t = line.trim()
  if (t.startsWith('>')) return true
  if (/^-{2,}\s*(original message|forwarded message)\s*-{2,}$/i.test(t)) return true
  if (/^_{5,}$/.test(t)) return true // Outlook separator
  if (t === '--' || t === '-- ') return true // signature delimiter
  if (/^on\b.+\bwrote:?$/i.test(t)) return true
  // Gmail wraps "On <date>, <name> <addr>" and "wrote:" across two lines.
  if (/^on\b/i.test(t) && next !== undefined && /^wrote:?$/i.test(next.trim())) return true
  if (/^(from|sent|to|subject):\s/i.test(t) && next !== undefined && /^(from|sent|to|subject|date|cc):\s/i.test(next.trim())) return true
  return false
}

/** First non-empty line before any quote marker, or null when the message starts with one / is empty. */
export function firstAnswerLine(text: string): string | null {
  const lines = text.replace(/\r\n?/g, '\n').replace(INVISIBLE, '').split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === '') continue
    return isQuoteBoundary(lines[i], lines[i + 1]) ? null : lines[i].trim()
  }
  return null
}

export function parseReplyIntent(text: string): ReplyIntent {
  const line = firstAnswerLine(text)
  if (line === null || line.length > 2000) return UNCLEAR

  // Strip markdown emphasis wrappers and trailing emoji/punctuation, then compare the WHOLE remainder.
  let body = line.replace(TRAILING_EMOJI, '').replace(/^[*_`~\s]+|[*_`~\s]+$/g, '')
  const word = body.toLowerCase().replace(/[.!\s]+$/g, '')
  if (APPROVE.has(word)) return { intent: 'approve' }
  if (REJECT.has(word)) return { intent: 'reject', note: null }

  // A rejection may carry a reason after a separator ("no, the price is wrong"). Approval takes nothing after it,
  // so "yes but..." and "yes, thanks" are unclear.
  body = body.replace(/^[*_`~\s]+/, '')
  const m = /^(no|n|reject|rejected)\s*[,:;—–-]\s*(\S.*)$/is.exec(body)
  if (m) return { intent: 'reject', note: m[2].trim().slice(0, MAX_NOTE) }
  return UNCLEAR
}
