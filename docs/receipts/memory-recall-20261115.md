# Memory recall outage repair — 2026-11-15

Builder: Athena. Task `fe0fc7ad-b0dd-498b-8c37-de68c11a8ca9`.
Base: `5ddacb78312e9db14c781925b2a0ecc14d600e9d`.
Scope: recall fallback and additive status only. No migration, memory write-path,
identity, permission or deployment change. Durable indexing remains slice 2.

Reproduction uses the real SQLite D1 harness and complete migration chain, with
AI/Vectorize as failure-controlled dependencies. Before production changes the
new suite returned 16 failures and 2 passing controls. A subsequent dedicated
fast-path coverage assertion was also observed red before its correction.

Validation of final normal source:

- 162 passing tests in eight files: new recall reliability, read-your-writes,
  MCP project/squad memory, exact project reads, home isolation, task brief,
  and boundary/read. Exit 0.
- 97 passing compatibility tests in loop-resources, sane-brain-s3, loop-runtime
  and execute. Exit 0. Existing fixture limitations in those suites are not
  presented as new transport evidence.
- TypeScript `tsc --noEmit`: exit 0.
- Five guards were mutation-tested: semantic failure catch, lexical scope,
  canonical D1 error visibility, MCP status metadata and fast-path coverage.
  Each mutation made its relevant assertions fail; source was restored afterward.
- The original #2433 evidence draft remains intentionally red and separate.
  Its old-record indexing failure is not claimed repaired here.

Recall caller audit: MCP personal/squad/project tools use detailed results;
`src/tasks/brief.ts:512`, `src/agents/agent-do.ts:273`,
`src/agents/loop.ts:364,744`, and `src/loops/resources.ts:79,83` retain arrays.
The optional method does not make existing injected `MemoryPort` values invalid.

Semantic work has a two-second budget; late binding work may continue upstream.
Only the semantic stage is caught/timed out. D1 errors still fail. Existing
vector ranking, canonical joins and lexical/recent bounds are preserved.
`degraded: true` and fixed retrieval codes distinguish partial empty results from
normal semantic results. Coverage describes actual legs, including semantic-only
for the full-vector fast path.

CI and Kasra's two independent gates must still validate the pinned PR head.
No full-suite, production canary, deployed result or merge approval is claimed.
