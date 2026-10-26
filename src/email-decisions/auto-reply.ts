// Auto-reply / bulk / bounce filter. Pure. Runs BEFORE any lookup; a match is dropped silently and never answered
// (no reply to an auto-responder means no mail loop and no backscatter).

export interface HeaderReader {
  get(name: string): string | null
}

export type AutoReplyReason =
  | 'null_sender'
  | 'auto_submitted'
  | 'precedence'
  | 'multipart_report'
  | 'x_autoreply'
  | 'list_or_suppress'

export function autoReplyReason(headers: HeaderReader, envelopeFrom: string): AutoReplyReason | null {
  const sender = envelopeFrom.trim().toLowerCase().replace(/^<|>$/g, '')
  if (sender === '' || sender.startsWith('mailer-daemon@') || sender === 'mailer-daemon') return 'null_sender'

  const autoSubmitted = headers.get('auto-submitted')
  if (autoSubmitted !== null && autoSubmitted.trim().toLowerCase() !== 'no') return 'auto_submitted'

  const precedence = headers.get('precedence')?.trim().toLowerCase()
  if (precedence === 'bulk' || precedence === 'junk' || precedence === 'auto_reply' || precedence === 'list') return 'precedence'

  if (/^\s*multipart\/report\b/i.test(headers.get('content-type') ?? '')) return 'multipart_report'

  if (headers.get('x-autoreply') !== null || headers.get('x-autorespond') !== null) return 'x_autoreply'

  if (headers.get('x-auto-response-suppress') !== null || headers.get('list-id') !== null || headers.get('list-unsubscribe') !== null) {
    return 'list_or_suppress'
  }
  return null
}
