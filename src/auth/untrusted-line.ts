// Untrusted text rendering shared by every human-facing card (approval bot, decision pages, sudo exact-call).
/** Untrusted text (the agent wrote it): one line, no control characters, bounded. Shown in quotes and labelled as the agent's words. */
export function untrustedLine(text: string | null | undefined, max: number): string {
  const flat = (text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}...` : flat
}
