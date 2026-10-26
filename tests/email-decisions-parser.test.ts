import { describe, expect, it } from 'vitest'
import { parseReplyIntent, firstAnswerLine } from '../src/email-decisions/reply-parser'

const GMAIL_QUOTE = '\n\nOn Mon, Oct 26, 2026 at 9:00 AM Mupot <mupot@decide.mumega.com> wrote:\n> Reply yes to approve or no to reject.\n> Put your answer on the first line.'
const OUTLOOK_QUOTE = '\n\n________________________________\nFrom: Mupot <mupot@decide.mumega.com>\nSent: Monday, October 26, 2026 9:00 AM\nTo: Hadi\nSubject: Decision needed\n\nReply yes to approve or no to reject.'

const APPROVE: [string, string][] = [
  ['plain yes', 'yes'],
  ['capital Yes', 'Yes'],
  ['upper YES', 'YES'],
  ['y', 'y'],
  ['Y capital', 'Y'],
  ['approve', 'approve'],
  ['Approved', 'Approved'],
  ['yes bang', 'yes!'],
  ['yes period', 'Yes.'],
  ['yes thumbs', 'yes 👍'],
  ['yes thumbs skin tone', 'Yes 👍🏽'],
  ['yes check', 'approve ✅'],
  ['bold markdown', '**yes**'],
  ['leading blank lines', '\n\n  yes  \n'],
  ['CRLF', 'yes\r\nthanks'],
  ['gmail top-post', 'Yes' + GMAIL_QUOTE],
  ['outlook top-post', 'Yes' + OUTLOOK_QUOTE],
  ['iphone footer', 'Yes\n\nSent from my iPhone'],
  ['outlook ios footer', 'Approve\n\nGet Outlook for iOS'],
  ['apple mail quote', 'yes\n\nOn Oct 26, 2026, at 9:00 AM, Mupot <mupot@decide.mumega.com> wrote:\n\n> Reply yes'],
  ['gmail wrapped wrote', 'y\n\nOn Mon, Oct 26, 2026 at 9:00 AM Mupot\n<mupot@decide.mumega.com> wrote:\n> x'],
  ['signature after', 'yes\n-- \nHadi Servat'],
  ['original message separator', 'approved\n-----Original Message-----\nFrom: x'],
  ['zero width in front', '​yes'],
]
const REJECT: [string, string, string | null][] = [
  ['no', 'no', null],
  ['No', 'No', null],
  ['n', 'n', null],
  ['reject', 'reject', null],
  ['Rejected', 'Rejected', null],
  ['no bang', 'NO!', null],
  ['no thumbs down', 'no 👎', null],
  ['no with reason comma', 'no, the price is wrong', 'the price is wrong'],
  ['no with reason dash', 'No - missing the logo', 'missing the logo'],
  ['reject with reason colon', 'reject: wrong customer', 'wrong customer'],
  ['no gmail top-post', 'No' + GMAIL_QUOTE, null],
  ['no iphone', 'no\n\nSent from my iPhone', null],
]
const UNCLEAR: [string, string][] = [
  ['yes but', 'yes but only after Friday'],
  ['yes but ellipsis', 'yes but...'],
  ['yes thanks', 'Yes, thanks'],
  ['yes please', 'yes please'],
  ['approve with question', 'approve?'],
  ['maybe', 'maybe'],
  ['question mark', '?'],
  ['empty', ''],
  ['whitespace', '   \n \n'],
  ['only emoji', '👍'],
  ['not sure', 'not sure, call me'],
  ['no way hose', 'nope'],
  ['yeah', 'yeah'],
  ['sure', 'sure'],
  ['ok', 'ok'],
  ['non-english', 'oui'],
  ['quote first', '> Reply yes to approve\nthanks'],
  ['quote then yes (bottom post)', '> Reply yes to approve or no to reject\n\nyes'],
  ['gmail quote only', GMAIL_QUOTE.trim()],
  ['outlook separator first', '________________________________\nFrom: x\nSent: y\n\nyes'],
  ['signature first', '-- \nyes'],
  ['forwarded', '---------- Forwarded message ---------\nFrom: x\n\nyes'],
  ['original message first', '-----Original Message-----\nyes'],
  ['sentence containing yes', 'I think yes is the right call'],
  ['yes then no on line two is still yes-only', 'please say yes'],
  ['wrapped answer', 'no one\nyes'],
  ['very long line', 'yes ' + 'a'.repeat(3000)],
]

describe('reply parser fixtures', () => {
  it.each(APPROVE)('approve: %s', (_n, text) => expect(parseReplyIntent(text)).toEqual({ intent: 'approve' }))
  it.each(REJECT)('reject: %s', (_n, text, note) => expect(parseReplyIntent(text)).toEqual({ intent: 'reject', note }))
  it.each(UNCLEAR)('unclear: %s', (_n, text) => expect(parseReplyIntent(text)).toEqual({ intent: 'unclear' }))

  it('has at least 40 fixtures', () => expect(APPROVE.length + REJECT.length + UNCLEAR.length).toBeGreaterThanOrEqual(40))

  it('the quoted card text never decides the answer', () => {
    // The card itself says "Reply yes to approve": a reply whose first live line is a quote must not approve.
    expect(firstAnswerLine('> Reply yes to approve\nyes')).toBeNull()
    expect(parseReplyIntent('On Mon, Oct 26, 2026 at 9:00 AM X wrote:\nyes')).toEqual({ intent: 'unclear' })
  })
})
