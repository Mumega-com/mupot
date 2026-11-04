// mupot — the one HTML text/attribute escaper.
//
// Escapes the five HTML-significant characters. The single quote is included on purpose:
// the per-file copies this replaces left it out, which made any single-quoted attribute
// an injection point (mupot#981). `&` is replaced first so the entities written by the
// later replacements are not themselves re-escaped.
//
// Use it for text nodes and for QUOTED attribute values. It is not a URL validator: a
// value placed in href/src must also be checked for an allowed scheme.
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
