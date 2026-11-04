// scripts/sql-compare.mjs — comment/whitespace-insensitive SQL normaliser shared by the
// schema-chain tests (tests/schema-chain.test.ts, tests/gen-schema-chain-strip.test.mjs).
//
// Independent of stripSqlComments on purpose: it is the yardstick the stripper is measured by.
// Whitespace is SQLite's own set, [ \t\n\f\r] — NOT JS `\s`, which also matches U+00A0, U+000B,
// U+FEFF and U+2028 that SQLite treats as identifier characters.
const NORMALISE_RE =
  /('(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\])|((?:--[^\n]*|\/\*[\s\S]*?\*\/|[ \t\n\f\r])+)/g

/** Literals are kept verbatim; each run of comments/whitespace becomes one space; ends trimmed
 *  of SQLite whitespace only. Non-strings pass through (sqlite_master.sql can be NULL). */
export function normaliseSqlForComparison(sql) {
  if (typeof sql !== 'string') return sql
  return sql
    .replace(NORMALISE_RE, (_match, literal) => (literal === undefined ? ' ' : literal))
    .replace(/^[ \t\n\f\r]+|[ \t\n\f\r]+$/g, '')
}
