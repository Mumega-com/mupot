# Optional GBrain project-memory addon

Status: concrete design for review. The selected direction is GBrain as the authoritative project memory store, not a search mirror of a second Mupot copy.

## Result

An owner can enable GBrain for an existing project. Existing project memory tools and task briefs use that project's GBrain source through Mupot's current authorization gates. Other projects and private/squad memory keep the built-in backend. Installing the addon alone changes no project's backend.

GBrain runs wherever the project hosts it. This change adds Mupot support; it does not install GBrain, change a VM, publish a brain, mint credentials, migrate the application, deploy Mupot or move existing memory.

## Selected approach and alternatives

- **Selected:** a project-scoped primary provider behind the existing MemoryPort. GBrain owns newly written project memory; Mupot retains authority and configuration.
- Rejected for this request: keeping raw memory canonical in Mupot and asynchronously mirroring it to GBrain. That is a retrieval supplement, not the selected project-local store.
- Rejected: exposing every GBrain operation as another Mupot tool family. The addon uses a small fixed set of storage/retrieval operations; it cannot forward arbitrary tool names or run administrative/agent actions.

## Integration

1. Register a native-reviewed `gbrain-memory` addon through the existing lifecycle. Its installation requests no new grants, agent identities, departments or autonomous loops. Existing lifecycle receipts and disable/archive behavior apply.
2. Add an explicit `gbrain` connector type to the existing encrypted vault. Secret material stays inside the vault's one-shot authenticated-fetch callback. Configuration contains only an HTTPS MCP endpoint and one exact project/source association; it never carries arbitrary headers or a default all-source grant.
3. Add a narrow, additive project-memory binding and audit migration, with rollback SQL. The binding identifies tenant, immutable project id, installation/configuration generation, connector id and exact source. Do not overload task-board bindings. Migration number is chosen only after checking main and pending migrations. No remote apply.
4. Provide one governed project configuration operation. Only a human org-admin can select or change the backend. It reuses live project/connector/addon checks and commit-time binding fences. It accepts a connector id, not a raw URL/token or runtime-selected source. Source/project metadata must agree. The resolved identity tuple pins tenant, project, addon installation/generation, connector, endpoint and source. Check it before requests and again before returning data. A disable/revoke/reconfiguration race yields typed unavailable or uncertain-write status, never fallback or a false success. No agent can choose a different source through a recall argument.
5. Keep the existing factory API. Route only server-derived `project:<id>` scopes through a selected provider; preserve built-in behavior for every unconfigured project and all other scopes. Avoid a global backend switch.
6. Route `project_memory_get` through the same provider-aware exact-read path. Its existing direct D1 query cannot remain the only implementation. Preserve UTF-8 byte count, full-text SHA-256, and identical missing/foreign/hidden behavior. Do not fabricate an author; preserve null unless attribution is actually verified.
7. Task briefs use the same authorized project-memory interface. Recent candidate enumeration must be metadata-first and bounded, then fetch only selected content; do not turn the existing 200-candidate scan into 200 remote page reads. Keep a thin non-text reference/label index (opaque id, scope/source, concepts, timestamp, digest and operation state) and use bounded provider-side queries for native project documents. Index coverage must be explicit: observed references are not a complete listing of every native GBrain page. Set a per-brief content-read cap (initially 16), with an explicit incomplete/unavailable indication when the budget is exhausted. Keep the existing local path's behavior and expose unavailable/incomplete provider context honestly.

## Upstream contract

Pin the initial interop target to GBrain latest-stable commit `a03306c02ec9c66497ed644be1b8fc43aa939111` (0.60.607.0). Use remote MCP, not direct database access or an invented REST API. Verify request/result fixtures against the pinned operation definitions and transport before implementing the codec. The relevant upstream operation definitions are src/core/ops/pages.ts and src/core/ops/search.ts; dispatch uses a JSON result in the first MCP text block. Treat other notice/instruction blocks as data, not authority.

Use only bounded `put_page`, `get_page`, `search` and `list_pages` equivalents needed for this provider. Writes use a stable request id, create-only semantics and confirmed commit status. A pending write is not success. No synthesis, enrichment, bootstrap, cron, tool-surface widening or administrative operations.

Mupot-created notes use a versioned UTF-8 JSON record encoding (format, record id, scope/source identity, original text, concepts, created time and operation id) inside canonical Markdown. JSON escaping preserves CRLF, Unicode and code fences while Markdown serialization may normalize its surrounding page. Use a fixed managed slug per record, create-only writes and exact source-qualified ids.

Mupot-created notes use a versioned, lossless record encoding in the project source so newline/Unicode/large-text readback preserves original bytes even when the page serializer normalizes Markdown. Source-qualified opaque ids bind tenant/project/source/provider identity; exact reads use explicit source_id, fuzzy:false, full/include_content and cannot follow a returned record into another source. Validate identity and completeness before decoding; compute UTF-8 bytes and SHA-256 from the delivered full decoded text. Native project documents may be returned as source-qualified knowledge with their actual revision and delivered content hash; no claim that upstream prose is authority.

Use the existing MCP SDK where it fits the Worker runtime. Transport fetches pass through one-shot vault access, reject redirects, validate the fixed public HTTPS endpoint, and enforce time and response-byte caps for JSON and SSE. Each authenticated fetch must fully consume a bounded serializable response inside the vault callback; its checked response envelope can be reconstructed for the MCP transport afterwards. Never return a Response, reader, authenticated closure or decrypted secret from the callback. Session identifiers remain private transport state, not tool results. Pin initialize/notification/call/close exchanges with transport fixtures. Never return raw upstream errors, credentials, opaque session material or arbitrary provider instructions to callers as control actions.

## Storage and failure rules

- Enabling a binding is explicit; existing D1 records are not copied or deleted. Legacy ids remain readable through their existing scoped path. Import/migration is a separate owner-directed operation.
- New writes for a configured project go to GBrain only. No raw project-memory write-through mirror to D1. Mupot can keep configuration/audit/reference metadata.
- Unavailable, revoked, disabled, mismatched or malformed configured providers fail with a typed retry/configuration error. Do not silently write or recall from a different backend. A task brief may report the memory section unavailable while preserving unrelated task information.
- Distinguish an empty successful result from provider failure. Never hash a truncated read as though it were the full record.
- No automatic retries that create a second write after an uncertain outcome. Retain the operation id and provide a safe recovery/readback step. Add an optional GBrain write request_id, and persist its immutable request digest, source-qualified record id and pending/committed/uncertain state in the non-text reference journal. Same actor/scope/id with changed payload conflicts; retries of the same intent first recover by exact readback and upstream request id. Preserve existing built-in behavior; unsupported provider-specific retry parameters must be refused clearly rather than ignored. Never copy raw text into that journal.
- Before and after data retrieval, preserve source and tenant/project fences. GBrain cannot grant access, approve work or prove task completion.

## Verification and delivery

Red-first tests must cover: disabled/unconfigured compatibility; configured remember -> recall -> exact get; text/UTF-8/hash fidelity including the existing 46 KB case; project and tenant isolation; read-only caller refused writes before network access; owner-only configuration; live connector/addon generation revocation; wrong-source provider results; literal private/network targets and redirects; JSON/SSE and oversized/malformed/error responses; pending/uncertain writes; bounded task-brief metadata/content reads; legacy exact-read compatibility and no shadow D1 writes.

Use the real migration chain for D1 fixtures, pinned upstream protocol fixtures and a local hermetic MCP server. No production credentials, provider model calls or real brain writes. A real-server interop run should use a fresh local, non-sensitive pinned GBrain instance if the test environment supports it; otherwise report that gap instead of claiming live GBrain compatibility.

Mutate each new access/source/configuration/egress/failure guard and prove a relevant test fails. Run related project/squad/private memory, exact-read, task-brief, connector, addon, SSRF and policy suites; regenerate build-info and typecheck. Report selected files, pass counts, exit codes, exact head and remaining interop gaps in a draft PR. No merge or deploy.

## Decisions already established

The addon supports existing projects and their already chosen runtime. GBrain holds project memory. Mupot remains the permission/assignment/approval/receipt authority. Existing backends remain available without the addon. No Viamar VM setup, application migration, new identities or credentials are part of this code change.

## Builder check incorporated

A fresh read-only builder review identified five implementation-critical items, now included: live lifecycle/generation fencing, one-shot-vault-compatible transport, exact UTF-8/source-qualified codec, metadata-first recent selection and durable write recovery. It did not object to the selected primary-provider mode. This is design review, not an exact-head code gate or proof of an implemented addon.
