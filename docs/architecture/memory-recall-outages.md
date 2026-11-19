# Memory recall during semantic-provider outages

`MemoryPort.recall` keeps its `MemoryHit[]` return type. The optional
`recallDetailed` method also returns `retrieval` status. The built-in MCP tools
`recall`, `squad_recall` and `project_recall` preserve their existing keys and add
`degraded: true|false` and that status beside `hits`. The boolean is true only
when semantic retrieval was unavailable.

- `semantic: available` means embedding/query succeeded. `coverage` identifies
  whether only semantic retrieval ran (`semantic-only`) or the bounded D1
  fallback also ran (`semantic-and-bounded-text`). It does not promise exhaustive
  recall or that every saved vector is searchable.
- `semantic: unavailable`, `coverage: bounded-text-only` means the provider
  failed, returned an invalid result, or exceeded the two-second semantic budget.
  `reason` is a fixed code: `embedding_failed`, `vector_query_failed` or `timeout`.
- An empty degraded result cannot establish that no saved fact exists. The
  existing fallback scans only recent records and bounded exact-token/quoted
  substring matches. Exact ID reads remain independent of AI/Vectorize.

The timeout bounds the semantic stage, not the entire request or D1 read latency.
Binding operations cannot necessarily be cancelled; late resolution/rejection is
consumed and cannot modify returned hits. Canonical D1 errors still fail the read.
No query text, memory content, provider response body or credentials are logged.

All reads retain the same caller-resolved personal, squad or project scope.
Project/squad authorization happens before retrieval. Normal vector ranking,
tenant filters, canonical D1 joins, lexical wildcard escaping and scan caps remain.
This change does not repair failed index writes; durable indexing retries are a
separate repair. Rollback is a code revert and requires no schema migration.
