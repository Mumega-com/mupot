// Untrusted text rendering shared by every human-facing card (approval bot, decision pages, sudo exact-call).
/** Invisible or blank-looking characters: ZW space/joiners + LRM/RLM (200B-200F), ALM (061C), word joiner + invisible operators
 *  (2060-2064), BOM/ZWNBSP (FEFF), soft hyphen, CGJ, Mongolian vowel separator, Khmer inherent vowels, and the Hangul fillers
 *  (115F, 1160, 3164, FFA0). */
const INVISIBLE_RE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u2060-\u2064\u3164\ufeff\uffa0]/g

/** Untrusted text (the agent wrote it): one line, no control characters, bounded. Shown in quotes and labelled as the agent's words. */
export function untrustedLine(text: string | null | undefined, max: number): string {
  const flat = (text ?? '')
    .replace(INVISIBLE_RE, '') // zero-width / mark / filler chars render as nothing: drop them so the card shows exactly what is there
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}...` : flat
}

const NAME_LOOKALIKES: Readonly<Record<string, string>> = { '"': '\u2033', '(': '\u2768', ')': '\u2769' }
/** An untrusted NAME that is printed inside `kind <id> ("name")`: untrustedLine plus quotes and parentheses swapped for look-alikes
 *  (U+2033, U+2768, U+2769), so a name can neither close the quoted name nor open a parenthetical that reads as a second id. */
export function untrustedName(text: string | null | undefined, max: number): string {
  return untrustedLine(text, max)
    .replace(ID_LIKE_RE, '\u2026') // an id-shaped token inside a NAME is replaced: the only id a card shows is the one the server printed
    .replace(/["()]/g, (ch) => NAME_LOOKALIKES[ch] ?? ch)
}

/** Id-shaped text an attacker could embed in a name: `id <token>`, prefixed ids (mem-, agent-, squad-, ...), uuids, long hex. */
const ID_LIKE_RE = /\bids?\b[\s:=#]*[\w-]+|\b(?:mem|member|agent|squad|proj|project|task|flight|usr|user|tok|dept|host)[-_][\w-]+|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{4,}\b|\b[0-9a-f]{12,}\b/gi
