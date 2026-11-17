# Agent identity and inbox echo: confirmed scope cut

Task: 7a7cc34a-1b03-4bce-bf6a-4fde9ba2d748. Builder: Athena. Independent narrow confirmation: Kasra and the separate lens.

Kasra rejected head 2513ef91 after the independent lens reproduced another false wake-proof interleaving. This is a scope cut under the repeated-class rule, not a third repair round. The native-proof algorithm and its polling witnesses are removed from this PR. Native proof belongs to a separate design task owned by Kasra.

## Retained behavior

- `connection_check` resolves the server's canonical agent-bound credential or live attachment. Identity step zero returns agent ID, slug and credential kind. A person credential stops and asks its human. No argument selects another agent.
- SEND/RECEIVE remain own-agent diagnostics. Agent-bound connections acknowledge their receive probe; attached chats use their own handled record.
- `connection_check {echo:true}` creates a system-sender nonce message in that agent's own inbox. The initial result does not contain the nonce. The challenge expires at exactly ten minutes.
- A valid `echo_reply` records only `echo_roundtrip`, with `path: inbox_echo`, `echo_returned_at` and `latency_ms`. Latency is challenge issue to nonce reply, including queue/read/poll time. Receipt tables, delivery timing and polling are never interpreted as proof.
- Person refusal, nonce mismatch, expiry, replay, exact credential/attachment/harness and token/runtime invalidation remain checked. Token inventory includes revoked history, so a new token cannot be revoked to resurrect old status. Runtime transition history is retained only for echo invalidation, including away-and-back changes.
- The agent page, `fleet_agent_get` and `connection_check` say **Echo returned**. Boot prompts for the inbox echo until `echo_roundtrip`; it does not ask the agent to prove wake. Historical echo status becomes stale after seven days, retaining the existing refresh policy.

## What is removed

`src/agents/messages.ts` is byte-identical to approved base `2b8b54d3` (SHA256 `2d7ccfd4c26d35bf97b4c66998666ed1b6082b8728c1d6339067d0d5a5026c48`). There are no exceptions. The observer module, poll audit writes, SSE active-window query, pre/post read instrumentation, native/doorbell receipt inspection and proof-state constructors are gone. The base idle SSE budget and ordinary consume/lease behavior are restored.

The diagnostic no longer returns a configured wake-path leg. Existing platform native-subscription configuration metadata in boot is unchanged from base; it is not an echo path or a proof result. Unrelated native notification delivery remains outside this cut.

The runtime transition helper and its fleet-writer calls are retained solely to invalidate echo challenges/status when the runtime changes. They do not observe inbox reads or inspect delivery receipts.

## Evidence and gate boundary

The cut includes tests pinning the exact base bytes and observer absence, plus a behavioral test where even a successful native receipt yields only the inbox roundtrip. Applicable expiry, attachment/agent and explicit credential-weld guards remain tested. Native-proof-specific tests are removed with the removed capability; they are not waived for a remaining proof path.

The final local test counts, retained-guard mutation table, source/test hashes and exact-head CI result are recorded on PR #2442 and the task submission. The PR stays draft. The gates confirm the cut, base-byte identity and unreachable proof states; this builder neither merges nor deploys. No migration, flag, credential operation or dispatch-policy change is introduced.

Local verification for the cut: 605 regression checks across 16 files passed, followed by the final 31-check echo core run including the two added pending-invalidation cases. Typecheck, schema/refusal guards and diff checks passed. The retained-scope table has 36 assertion-killed mutations (including proof-state/path promotion, exact expiry, binding and stale attachment guards, boot completion and base-byte/observer-removal contracts). Its hashes and exact-head CI completion are attached to PR #2442. Earlier wake-proof receipts are superseded and confer no approval on this slice.
