# Secure moments

Status: wave W1, behind a feature flag (off by default). Wave W2 (secure drops, sealed credential delivery) is at the end of this document.

A high-stakes approval should never pass through a chat or a model. With secure moments, an agent asks for a decision through a tool and gets back a one-time link. The human opens the link on a dedicated mupot host and confirms with a passkey. The chat only carries the link and, afterwards, the outcome.

W1 covers two kinds of moment: attaching a project seed (`seed_attach_request`) and approving an agent elevation (`request_elevation`). It generalises the [Access approve page](access-approve-page.md): both channels end in the same decision code, and only the proof of the human differs.

## Configuration

| Variable | Meaning |
|---|---|
| `SECURE_MOMENTS` | `1` or `true` turns the feature on. Anything else: off. |
| `SECURE_MOMENTS_HOST` | The dedicated hostname for the secure pages. It is also the WebAuthn relying-party ID. |
| `CONNECTOR_MASTER_KEY` | Already used elsewhere. Secure moments derive their CSRF key from it; without it the pages answer 503. |

Both variables are plain variables (not secrets). The names are in the reviewed-names list, so `secret_env_request` cannot squat them.

### The host rule

`SECURE_MOMENTS_HOST` follows the same rule as the Access approval host, plus one more:

- it must be well-formed;
- it must not equal, or sit under, the colony host (`PUBLIC_ORIGIN`, or the built-in default) or `DEFAULT_POT_HOST_SUFFIX`;
- it must differ from `ACCESS_CANONICAL_HOST` (in any spelling).

A bad host never enables the feature. `/m/*` then answers 404 everywhere.

### The host gate

The gate is the first statement of `fetch`, before tenant routing, hostname dispatch, OAuth, MCP, preview or the dashboard:

- On the secure host only `/m/*` is served. Every other path is a 404. Only the literal `/m/` spelling is served there.
- On any other host `/m/*` is a 404, including percent-encoded spellings (`/%6d/...`, `/%256d/...`), a trailing dot, any case, and `workers.dev`.
- With the flag off, `/m/*` is a 404 on every host and nothing else changes.

The secure-moments app is never mounted on the main app. The gate is the only way in, so no other host can route to it.

## Flows

### Enrolling a passkey

1. The member opens `/account` in the dashboard and chooses **Add passkey**. The route needs a real browser session of an active human member who has re-authenticated in the last five minutes. A bearer token, an agent, or a stale session cannot enrol.
2. mupot mints a single-use, 10-minute enrolment token bound to that member and hands the browser to `https://<secure host>/m/enrol/<token>`. Only a hash of the token is stored; a newer link supersedes the older one.
3. The secure page runs `navigator.credentials.create` and requires user verification. mupot stores the public key (ES256) for that member.

Enrolment adds no authority. It records one more way for an existing member to prove who they are. A member can remove their own passkeys from `/account`.

### Asking for a decision

`seed_attach_request` and `request_elevation` create a moment when `SECURE_MOMENTS` is on. This is independent of `ACCESS_APPROVE_ENABLED`. The tool result carries `approve_url`, the link `https://<secure host>/m/<id>/<token>`. If both channels are on, `approve_url` is the secure link and `access_approve_url` is the Access one. With the flag off the tools return no secure link and write no moment rows.

A moment is single-use and expiring: it never outlives the request behind it, and never lasts more than 24 hours. At most one moment is pending per request. Filing the same request again rotates the link, so the old link stops working. The link token is stored only as a SHA-256 hash.

### Deciding

1. Opening the link shows the request and consumes nothing. Text written by the agent appears only inside a box marked as untrusted.
2. The human chooses approve or deny (and, for an elevation, which actions and how long). The page asks the server for a challenge. The challenge is single-use, lives at most five minutes, and is bound to the moment, the decision, and a digest of exactly what was chosen. A challenge minted for one decision cannot carry another, and a challenge for one moment cannot decide a different one.
3. The passkey signs the challenge. The server checks the origin (exactly `https://<secure host>`), the RP ID hash, user presence and user verification, the signature, and that the credential belongs to an active human member in this tenant and is not revoked. The signature counter must move forward; a non-zero regression is treated as a cloned authenticator and refused.
4. The server re-checks what that member may do, using the same rules as the other channels: org admin for a seed attach, `canDecideElevation` for an elevation. A passkey proves who decided and never grants what. An agent-bound member can never decide.
5. One guarded `UPDATE` consumes the moment (`status = 'pending'`, not expired, link hash matches). Only then does the shared decision code run (`applySeed`, `decideElevationRequest`), the same code the Access page uses. Replays, second tabs and concurrent requests produce exactly one decision; the others get a 409.
6. Receipts are written to `mutation_audit_entries` with `via: webauthn` and the moment id.

A refusal before step 5 never burns the link. After step 5 the moment is spent whatever the request's own outcome.

The link alone decides nothing: without a passkey of an authorised member there is no way to decide.

An elevation grant binds to a web session. The passkey inherits the login identity of the dashboard session it was enrolled under; if that identity is revoked, the passkey can still decide seeds but cannot decide elevations until the member enrols again.

## Cookies and headers

The secure host sets no cookies. There is no session on it, so there is nothing to scope. If a cookie is ever added there it must be `__Host-` prefixed with no `Domain`. Responses carry `Cache-Control: no-store`, `Referrer-Policy: same-origin` (the link token is in the path), a CSP that allows only one nonce-tagged inline script, `X-Frame-Options: DENY`, and a permissions policy that limits WebAuthn to the page itself. No Cloudflare Access app may cover this host.

## Limits of W1

- ES256 only. Authenticators that can only produce RSA keys cannot enrol.
- Attestation is not verified (requested as `none`). A passkey says "the same authenticator again", nothing about the make of the device.
- A moment has no named decider: any member whose authority passes the check at decision time may decide. The column exists for a later wave.
- Only two kinds of moment. Other secure requests (credential drop, Telegram Mini App) are later waves; MCP URL-mode elicitation is W3, below.
- An org admin cannot yet mint an enrolment link for another member.
- There is no rate limit on the link beyond the unguessable token and a cap on outstanding challenges per moment.
- Recovery from a lost passkey is: sign in to the dashboard and add a new one. It never runs through an agent.

# W2: secure drops

Status: wave W2, behind a second feature flag (off by default). Branch work; not deployed.

An agent that needs a credential (an API token, an SSH key) must never receive it through a chat or a model, and mupot must never hold it in the clear. A secure drop seals the secret **in the human's browser** to a key that only the agent's host holds. mupot stores ciphertext and a digest, and has no code that can open it.

```
agent host                     mupot (Worker + D1)                  human's browser (secure host)
keygen -> host-key.json
register public key  --------> host_keys (public key, fingerprint)
credential_request   --------> secure_drops(requested) + a 'credential' moment
        <-------- one-time link + fingerprint
                                                     link ------->  page shows agent, name, purpose (untrusted),
                                                                    host key FINGERPRINT
                                                                    password field -> HPKE seal in the browser
                                                                    POST {enc, ciphertext} + passkey assertion
                               verifies passkey + authority,
                               ONE batch: consume moment + store ciphertext
pull  <------------------------ {revokes, drops: [{id, agent_id, name, enc, ct, fingerprint}]}
shred revoked files FIRST, then open with own key,
write ~/.mupot/secrets/<agent id>/<name> (0600, atomic)
ack   ------------------------> ciphertext DELETED
```

## Configuration

| Variable | Meaning |
|---|---|
| `SECURE_DROP` | `1` or `true` turns secure drops on. It also needs `SECURE_MOMENTS` on and a valid `SECURE_MOMENTS_HOST`. Anything else: off. |

The name is in the reviewed-names list. With the flag off (or secure moments unusable) secure drops are a true no-op:

- the five tools are not advertised and refuse in `invokeTool` before argument handling (so a flag-off pot does not reveal their schemas);
- `/m/assets/hpke-seal.v1.js` is a 404, a credential moment cannot be viewed or decided, and no row is created in `host_keys`, `secure_drops`, `secure_moments` or `mutation_audit_entries`.

## Threat model

What this protects: the chat, the model, the bot transcript, D1 backups, logs and receipts never contain the secret. A stolen database yields ciphertext sealed to host keys.

What it does **not** protect against, by design:

- **A compromised Worker.** The browser runs the sealer that the Worker serves, and it gets the host public key from the Worker. A Worker that serves a malicious page can seal to the attacker's key. The check that catches this is the **fingerprint**: the page shows the host key's fingerprint (and recomputes it in the browser from the key it would use), and the human compares it with a reference.

  **The reference must come from the host operator, out of band.** It is the fingerprint `secure-drop.mjs keygen` printed on the host, handed over by whoever runs the host (in person, a separate channel, a ticket). It must **not** come from the agent or from the chat that carried the link: whoever can talk as the agent can also have registered a different key. mupot cannot make this comparison for you, because both the page and the agent are things under suspicion. With no independent reference, do not paste a secret.
- **A stolen agent token.** It can call `host_key_register` and silently re-key the agent. W2 makes that visible rather than impossible: every registration or rotation is receipted, lands in the inbox of the agent's governors (below), and the credential page shows when the key was registered, how many keys it replaced, and a prominent warning when it changed in the last 24 hours or the agent has been re-keyed more than once. Requiring a passkey for key registration is a follow-up (see Limits).
- **A compromised host.** Whoever controls the host reads its files. Revoke shreds the file; it cannot un-leak.
- **A compromised passkey device or a human who pastes into the wrong page.**

## Cryptography (exactly one suite, no negotiation)

HPKE RFC 9180, base mode: **DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-128-GCM** (kem `0x0020`, kdf `0x0001`, aead `0x0001`).

- Host key: X25519. The wire form is the raw 32-byte public key as base64url without padding (43 characters). Small-order points are refused at registration.
- Fingerprint: lowercase hex `sha256(raw 32-byte public key)`. Shown to humans as 16 groups of four hex digits.
- `info = "mupot-secure-drop/v2|" + agent id + "|" + drop id + "|" + name + "|" + fingerprint (hex)`; `aad = drop id`. Everything the human saw on the page is inside the ciphertext: a ciphertext opens only for that agent, that request, that **name** and that host key. A drop relabelled by a compromised Worker or D1 writer (another name, another agent) does not open on the host, so the name that picks the file on the host is cryptographically the one the human approved. The page script builds this string from `data-agent-id` and `data-name`, which the server renders from the stored request; the host builds it from its pinned agent id and the drop's fields.
- One sender context per secret, sealed once (sequence 0). Each attempt in the browser makes a fresh context and a fresh ephemeral key.
- The host recomputes the fingerprint from **its own key** to build `info`. It never trusts a fingerprint the server names: a drop whose `host_key_fingerprint` differs from the host's own is refused (a key-substitution signal).
- The WebAuthn challenge for a provide is bound server-side to `moment id + decision 'provide' + sha256(enc || ciphertext)` (raw bytes). The same bytes are digested again when the decision arrives, so a ciphertext swapped after the assertion consumes no challenge and stores nothing.

### The vendored browser bundle

The sealer is one pre-bundled, minified IIFE (global `MupotHpke`), served by the secure host itself from `/m/assets/hpke-seal.v1.js`. There is no CDN. The credential page loads it under `script-src 'self' 'nonce-...'` and a subresource-integrity hash; no other moment page allows `'self'` scripts.

| | |
|---|---|
| File | `src/secure-drop/vendor/hpke-seal.v1.js` (also embedded for the Worker in `src/secure-drop/hpke-bundle.generated.ts`) |
| Libraries | `@hpke/core 1.9.0`, `@hpke/dhkem-x25519 1.8.0` (pulls `@hpke/common 1.10.1`), bundled with `esbuild 0.25.5` |
| Size | 39,448 bytes (about 11.5 KB gzip) |
| sha256 | `c230e6c2f6a2e26eba963b36212ec1c184f05539d9a225e3193cc02f16d53a83` |
| SRI | `sha384-aSUuqGLqcAtBkgSHdpmylaxN19P7a9O8PojPxceonRUxrGSDc7iRWLrVqQLPCXMF` |
| Source / rebuild | `scripts/vendor/hpke-seal.entry.mjs`; `scripts/build-hpke-bundle.mjs <dir>` (see its header). The build is reproducible: the same pins give the same bytes. |

`tests/secure-drop.test.ts` pins the sha256 and the SRI to this document, checks that the TS copy equals the file byte for byte, and checks the bundle contains no `eval`, `new Function`, `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon` or storage access. Its only dynamic `import()` is the Node-only `crypto` fallback, taken when `globalThis.crypto` is absent (never in a browser). A changed bundle fails CI until this table is updated. `package.json` has no HPKE dependency: the library exists only as that vendored browser file.

## Tools

All agent tools take the agent id from the token (`auth.boundAgentId`), never from arguments.

| Tool | Caller | What it does |
|---|---|---|
| `host_key_register { public_key }` | the agent itself (agent-bound token) | Registers the host's public key. One live key per agent (partial UNIQUE index). The same key again is a no-op; a different key **rotates**: the old key is revoked and open requests and unpulled ciphertext sealed to it are closed in the same batch. A revoked key is never accepted again. A new key or a rotation notifies the agent's governors (see below). |
| `credential_request { name, purpose, scope_hint?, ttl_minutes? }` | the agent | Needs a live host key. Creates a `secure_drops` row and a `credential` moment; returns the one-time link, the request id and the grouped fingerprint. `name` is a filename slug `[a-z0-9][a-z0-9_-]{0,62}` (no dots, no slashes); `ttl_minutes` is 5 to 1440 (default 60). A re-request for the same name supersedes the open one; ciphertext still waiting for a pull blocks a new request; at most 10 open requests per agent. It never returns or accepts a secret. |
| `secure_drop_pull {}` | the agent | Lazily purges expired rows, then returns `{drops: [{id, agent_id, name, enc, ct, host_key_fingerprint}], revokes: [{id, name}]}` for **this agent's own drops sealed to its current live host key**. A drop sealed to a rotated key is never listed. |
| `secure_drop_ack { id }` | the agent | A `ready` drop becomes `delivered` and `enc`/`ct` are set to NULL in the same statement (guarded; a replay changes nothing). A delivered drop with a pending revoke instruction becomes `revoked`. Another agent's id, an expired or unknown id are refused identically (`nothing_to_ack`). |
| `secure_drop_revoke { name, agent_id? }` | a human (not agent-bound) who is org admin or admin on the agent's squad | An open request is cancelled and its link dies; unpulled ciphertext is deleted at once; a delivered credential gets a revoke instruction that the host acts on at its next pull (it shreds the file, then acks). A name that exists for several agents the caller governs needs `agent_id`. A caller with no authority gets the same `not_found` as for an unknown name. |

`SECURE_DROP` also drives advertising: with it off none of the five appear in `tools/list`.

## The decision

The credential page is a moment of kind `credential`. Opening it consumes nothing. The human chooses **Seal and send with passkey** or **Deny with passkey**. The same ceremony as W1 runs (single-use challenge, WebAuthn assertion with user verification, counter forward-only), then, before anything is consumed:

1. the passkey's member must be an **active human** (an agent's welded member row never decides);
2. the passkey's login identity must be live;
3. that member must hold **authority over this agent**: org admin, or admin on the agent's squad (`hasWorkspaceAdmin`, `canOnSquadAuth`, the predicates the other channels use, re-derived now);
4. the request must still be open and bound to this moment, and for a provide the host key must still be the live one.

Then **one batch**: a guarded `UPDATE` consumes the moment (and repeats checks 2 and 4 in its `WHERE`), an `UPDATE` stores `enc`/`ct`/`ct_sha256` only `WHERE changes() = 1`, and the receipt is inserted only `WHERE changes() = 1`. A refusal never burns the link; a stored ciphertext always has a consumed moment behind it; the result is read back before success is reported.

`secure_drops.status`: `requested -> ready | denied | expired`, `ready -> delivered | expired | revoked`, `delivered -> revoked`. Check constraints make ciphertext outside `ready` unrepresentable, so a code path that leaves it behind fails instead of leaking.

## Receipts

`mutation_audit_entries` gets a row (`handler secure_drop`) for `host_key_register`, `credential_request`, `secure_drop_provide`, `secure_drop_deny`, `secure_drop_deliver`, `secure_drop_revoke` and `secure_drop_revoke_ack`. Evidence is short scalars only: names, ids, the fingerprint, the host key id and the ciphertext **digest** (`ct_sha256`). The helper drops any value that is not a short plain scalar, and the tests assert no receipt contains the plaintext, `enc` or `ct`. For provide and deny the principal is the human member who decided (`origin admin_ui`); for the agent tools it is the agent.

## The host script

`fleet-runtime/secure-drop.mjs` (Node 20 or later, `node:crypto` only, no npm dependencies):

| Command | Does |
|---|---|
| `keygen [--rotate]` | Writes `~/.mupot/host-key.json` (mode 0600, X25519 private key as a JWK, atomic, refuses to replace an existing key without `--rotate`) and prints the public key and the fingerprint. Give that fingerprint to the human out of band. |
| `register [--agent id]` | Calls `host_key_register` with the agent's own token and **only the public key**, then **pins** this host to the agent id the server names (`~/.mupot/agent.json`, 0600). A host is never re-pinned to a different agent; `--agent` must match what the server says. |
| `pull` | Needs the pin. Processes **revoke instructions first**, then drops. For each drop it validates the name (same slug rule) and the id, requires `agent_id` to equal the pinned agent, refuses it if the server-named fingerprint differs from the host's own, opens it with a hand-rolled RFC 9180 base-mode receiver (info as above), writes the file, updates the manifest, and only then calls `secure_drop_ack`. It prints names and byte counts, never a secret. |
| `revoke <name>` | Overwrites the file with random bytes of the same length, fsyncs, unlinks it and forgets it (only a file this script wrote and that is unchanged). |
| `path <name>` | Prints where `<name>` lives. |

### Where the files go, and how a consumer reads them

All agents on a host usually run as one Unix user, so a name picked by a server-side value must never reach a path the script does not own. secure-drop writes **only** into `~/.mupot/secrets/<agent id>/`, a directory it creates itself with mode 0700 (explicit `chmod`, so a umask or a default ACL cannot widen it; only the directories it created are mode-checked, `~/.mupot` itself may be shared). It never writes into `~/.sos/keys` or any other path. Every file it creates is opened exclusively without following symlinks and set to 0600 with an explicit `fchmod`.

`~/.mupot/secrets/<agent id>/.manifest.json` (0600) records, per name, the drop id and the sha256 of every version the script wrote (the manifest learns the new hash before the file changes, so a crash never orphans the script's own file). The script refuses to **replace or shred** any file that is absent from the manifest, is a symlink or a non-regular file, or whose hash differs from what it wrote. So an operator's file, another tool's file, or a file edited since can never be overwritten or destroyed by a drop or a revoke instruction, however the name was chosen.

A consumer reads `~/.mupot/secrets/<agent id>/<name>` directly (`secure-drop.mjs path <name>` prints the path), or points a symlink **at** that path from its own configuration (a symlink into the secrets tree is safe; the script only refuses symlinks inside it). A step that copies a secret to some other target path is deliberately not part of W2.

### Revoke ordering and rotation

A rotation is: revoke the old credential, ask again, provide the new one, under the same name. Two guards make that safe:

- the **server** omits a revoke instruction for a name that has a newer drop (ready or delivered, not itself being revoked) for the same agent, and closes the stale instruction once the newer drop has been delivered. If the newer drop expires unpulled, the old revoke comes back, because the old file still needs its shred;
- the **host** processes revokes before drops, and a revoke carries the drop id it was ordered for: if the file now belongs to a newer drop (manifest drop id differs) the revoke is acknowledged as `superseded` and the file is left alone.

### Who is told about a key change

`host_key_register` (new key or rotation; an unchanged key says nothing) writes the receipt, emits the `org.provisioned` bus event the other in-band provisioning writes use (`host_key_registered` / `host_key_rotated`), and delivers an inbox message through the same system-sender `sendAgentMessage` seam the wake router uses. The recipients are the **governors** of the agent: active human members with admin or owner capability on the agent's squad, its department or the org (the `capabilities` table, as `listOrgOwnerMemberIds` reads it), reached through the agents they own (`agents.owner_member_id`). The tool result reports `governors_found` and `governors_notified`. A governor who owns no agent, and an org owner who holds only the legacy role (no capability row), are not reachable this way; the bus event and the receipt still exist.

Token rules are the CLI's (`cli/mupot.mjs`): the bearer token comes from a 0600 regular file (`~/.config/mupot/<pot>.token`, the pot's `token_file`, or `MUPOT_TOKEN_FILE` for the default pot), is never accepted on argv (`--token` and friends are refused), is never printed, and is sent only to the pot's own https origin (http only for loopback; redirects are refused).

`node --test fleet-runtime/secure-drop.test.mjs` covers the RFC 9180 Appendix A.1 vector (the suite above: key schedule outputs and the sequence-0 ciphertext), interoperability with the vendored browser bundle, and every refusal named above.

## Limits of W2

- One host key per agent. Two hosts for one agent are not supported (the second registration rotates the first).
- No human can see the secret again once sent; there is no reveal. Revoke shreds the host file on the host's next pull, not synchronously.
- A single sealed secret is limited to 8 KiB of plaintext.
- The fingerprint comparison is a human step, and its reference must come from the host operator out of band. If a human skips it or takes the reference from the agent, a compromised Worker or a stolen agent token defeats confidentiality (see the threat model).
- **Follow-up (not built):** registering or rotating a host key is authorised by the agent's own token alone. Gating it with a passkey (the key would be `pending` until a governor confirms it on the secure page) would remove the stolen-token re-key. W2 only makes the change visible; tracked as a follow-up issue on the PR.
- A governor who owns no agent, and an owner with only the legacy role plane, are not reached by the inbox notice.
- The credential password field opts out of password managers (`autocomplete="new-password"`, `data-1p-ignore`, `data-lpignore`, `data-bwignore`) and the form is left in place after success, so it does not look like a login that a manager should offer to save. Managers may still ignore these hints; the field is never submitted as a form field (the page script seals it and posts JSON).
- Revoke goes through a human **bearer** token over MCP (authority is checked, but there is no passkey step-up on revoke). Revoking is the safe direction: it only removes access.
- Clock-based expiry is lazy: expired rows are closed on the next request or pull, and an expired moment is never decidable in between.

## W3: MCP URL-mode elicitation

When a request tool has just filed a request and minted a secure-moment link, the MCP layer can offer that link as a native MCP URL-mode elicitation, so a capable client opens it with a consent prompt instead of leaving it to the model to relay a string. **The plain link in the tool result stays the guaranteed path**: a client that did not declare support gets the tool result unchanged, byte for byte.

Code: `src/mcp/url-elicitation.ts`, wired in `handleJsonRpc` (`src/mcp/index.ts`) and `invokeTool` (an optional `ToolCtx.shortCircuit`). Tests: `tests/mcp-url-elicitation.test.ts`.

### Switches

`MCP_URL_ELICITATION` is `1` or `true`, off by default. It is inert unless secure moments are also usable (`SECURE_MOMENTS` on, a valid `SECURE_MOMENTS_HOST`) and `CONNECTOR_MASTER_KEY` is a 64-hex key (it signs the retry state and the capability session id; no key, no feature). With the flag off nothing here runs: no header on `initialize`, no new branch on any `tools/call`.

When the flag is on, a 2026-07-28 request (`MCP-Protocol-Version` or `_meta` naming 2026-07-28) gets `resultType: "complete"` on every result, as that version requires. Before, that stamping needed `EVENTS_ENABLED`; now either flag turns it on.

### Which tools, which link

Only `seed_attach_request` and `request_elevation`. After the tool succeeds, the layer reads the result's `approve_url` and offers it only if all hold: https, the host is exactly `SECURE_MOMENTS_HOST` (no port, no userinfo), no query or fragment, path exactly `/m/<moment id>/<token>`, and the moment row is pending, of the kind that tool mints, and filed for this caller's bound agent. Anything else leaves the plain result alone. The URL is the W1 one-time link: its token authorises nothing; the human still proves themselves with a passkey on the secure host. A future tool (W2 `credential_request`) joins by adding a row to `URL_ELICITATION_TOOLS` and a case in `readOutcome`.

An elicitation answer (`accept`, `decline`, `cancel`) is consent to open the page, never a decision. No form mode is ever used, nothing secret is put in a message, and the server never sends a mid-call `elicitation/create` (the Worker is stateless).

### Capability detection

mupot has no session store, so a declaration has to arrive with the request:

| Client | Where it declares | Response |
| --- | --- | --- |
| 2026-07-28 (no `initialize`) | `_meta["io.modelcontextprotocol/clientCapabilities"].elicitation.url` is an object, on a request that names 2026-07-28 | `resultType: "input_required"` with `inputRequests.secure_moment = {method: "elicitation/create", params: {mode: "url", url, message}}` and a `requestState` |
| 2025-11-25 | `protocolVersion: "2025-11-25"` and `capabilities.elicitation.url` in `initialize` | `initialize` answers `protocolVersion: "2025-11-25"` and returns a signed `Mcp-Session-Id` (`mce1.<payload>.<hmac>`, HKDF label `mupot_mcp_url_elicitation_session_v1`) holding "declared url", an issue time and a random nonce (ids are unique), with `Access-Control-Expose-Headers: Mcp-Session-Id` so a browser client can read it. The client echoes it on later requests, which is what proves the declaration. A `tools/call` that carries a valid id AND `MCP-Protocol-Version: 2025-11-25` gets JSON-RPC error `-32042` with `data.elicitations = [{mode: "url", elicitationId, url, message}]`; `elicitationId` is the moment id |
| either, fallback | the same `_meta` key on a request that carries `MCP-Protocol-Version: 2025-11-25` | `-32042` |

A client that negotiated anything below 2025-11-25 (any other `initialize` version, or no header) never gets `-32042` and is never handed a session id. A modern client never gets `-32042` (removed in 2026-07-28) and never gets `input_required` without declaring `url`. The `-32042` message text also carries the plain link, so a client that ignores the code still shows it. The session id identifies nobody and authorises nothing; forging it only opts the forger into a link they could read anyway. It expires after 7 days (then the client falls back to the plain result until it re-initialises).

### Why 2025-11-25 is answered, and what that obliges

Handing a 2025-06-18 session a feature that only exists in 2025-11-25 would be a lie in the handshake, so a client that asks for exactly 2025-11-25 and declares `url` is answered 2025-11-25 (everyone else still gets 2025-06-18, byte for byte). The 2025-11-25 changelog items that touch the server surface mupot actually serves (`initialize`, `tools/list`, `tools/call`):

- SEP-1303, input validation errors are Tool Execution Errors, not Protocol Errors: on a request carrying `MCP-Protocol-Version: 2025-11-25` (flag on), a schema/`invalid_args` failure is returned as `isError` result so the model can self-correct. Unknown tools and malformed requests stay `-32602`, as the spec keeps them protocol errors.
- Streamable HTTP clarifications (GET stream, session termination): the server issues a session id, and a 404 on a request carrying one means "session terminated". There is no GET stream and nothing to delete, so while the flag is on `GET` and `DELETE` on `/mcp` answer `405` with `Allow: POST` (flag off: the unchanged 404). The OAuth wrapper re-roots every `/mcp*` request to the same Hono route, so the one handler covers both doors.
- Origin validation (clarified to HTTP 403): not a 2025-11-25 delta in substance (2025-06-18 already required it) and not added here; `/mcp` does not validate `Origin` today for any version.
- Tool-name guidance (SEP-986), JSON Schema 2020-12 default dialect (SEP-1613), icons (SEP-973), tasks (opt-in, not advertised), sampling tools, enum elicitation, SSE polling: do not apply to mupot's server surface.

### Retry is read-only

The elicitation has already filed the request and minted the moment. A retry must not file a second request and must not rotate the link: `createMoment` rotates a pending moment's token, which would kill the page the human just opened, and `request_elevation` has no de-duplication. So a matching retry short-circuits `invokeTool` after every capability and schema gate and instead of the tool body, and reports the request's current state (`pending`, `approved`, `denied`, `expired`, `applied`, ...) with `retry: true`. It writes nothing.

- **2026-07-28**: the client echoes `requestState` (plus `inputResponses`). The state is `mus1.<payload>.<hmac>`, HMAC-SHA256 under a key derived from `CONNECTOR_MASTER_KEY` with HKDF label `mupot_mcp_url_elicitation_state_v1`. It carries the principal (member and bound agent, plus the exact agent session for an elevation, because `request_elevation` and `elevation_status` scope a request to the session that filed it and a sibling session of the same agent is a different principal), tool name, a digest of the arguments, moment id and kind, request id, and an expiry (the moment's, at most 24h). It is attacker-controlled: the MAC is checked first, then every binding. A bad state is refused with JSON-RPC `-32602`, message `invalid_request_state`, `data` the reason (`malformed`, `integrity`, `tool`, `expired`, `principal`, `args`, `not_found`), and a present state NEVER falls through to running the tool: if its moment or outcome cannot be found it is refused with `not_found`. The refusal is produced inside `invokeTool` (the `shortCircuit` hook), after the harness chokepoint, the capability floor and schema validation, so a caller who is not allowed to call the tool gets that refusal instead. The state is not single-use; the retry only reads.
- **2025-11-25**: nothing travels, so "the same ask" is found by natural key, among this caller's own requests that were issued through a secure moment: `seed_attach_request` by (member, seed digest), `request_elevation` by (bound agent and agent session, actions as a set, scope, duration, reason; a blank `scope_id` counts as absent, exactly as the tool stores it). A seed request must also have been filed by the same bound agent. A matching request counts as a retry while it is pending and younger than 10 minutes, or was decided in the last 10 minutes. Anything older, or different, is a new ask and a new elicitation. An older pending seed request is re-asked through the tool, which reuses the request and rotates the link, exactly as without elicitation.

### W3.1: the plain link survives a client that cancels

A headless client (Claude Code in print mode was measured) cancels a URL elicitation on its own and retries with `requestState` and `inputResponses` carrying `cancel`. The link was handed to a client that discarded it, and the token is stored only as a hash, so it cannot be shown again. The retry therefore does this, for a 2026-07-28 retry whose request and moment are both still pending and whose answer is anything but an explicit `accept` (`decline`, `cancel`, a missing or unrecognised answer):

- It rotates the pending moment's link (the same `createMoment` rotation, same moment id; the old link stops working) and returns the new `approve_url` in the tool result, plus `access_approve_url` when the Access channel is on, with a note telling the agent to give the link to the human. The result still has `retry: true` and `elicitation_action`.
- `accept` while pending stays read-only (no rotation, no link): the human has the link open and rotating would break the page.
- A decided, expired or no-longer-pending request returns its outcome with no link and no rotation.
- Rotation is bounded per moment: at most one per minute and five in total, enforced by one atomic insert into `mutation_audit_entries` (operation `moment_link_rotate`, no token in the evidence) that is both the receipt and the counter. A throttled or capped call returns the pending outcome with `link_reissue: "throttled"` or `"capped"` and no link; if the receipt cannot be written (`link_reissue: "error"`) nothing is rotated.
- It stays principal-bound: the same state checks as any retry (principal, tool, arguments, moment ownership) run first.

The 2025-11-25 retry carries no answer at all, so it is read as consent and stays read-only; that path's plain link is already in the `-32042` message text of the first response. `credential_request` is not in the tool map and is never elicited (tested with every carrier).

### Client support (as of 2026-10-12)

| Client | URL-mode elicitation |
| --- | --- |
| Claude Code | confirmed declares `url` (docs); its docs say nothing about `-32042` or `input_required` handling, so the retry behaviour is unverified |
| VS Code Copilot | confirmed `url` (1.107) |
| Claude Desktop, claude.ai, ChatGPT, Codex, Cursor | unknown: no documentation found; Codex and Cursor are documented for form mode only |

Because most clients are unknown, nothing depends on the elicitation: the plain `approve_url` is always in the result for a client that did not declare support.

### Not verified

No real client has been driven through either flow; the tests speak the wire shapes directly. The 2026-07-28 field names (`inputResponses`, `requestState` as `tools/call` params, the `input_required` result) follow the SEP-2322 text as recorded in research, not a client implementation. Whether a given client echoes `Mcp-Session-Id` after `initialize` through the OAuth wrapper in front of `/mcp` is unmeasured. The wrapper's own CORS block does not set `Expose-Headers`; the `initialize` response sets it itself and the wrapper copies response headers, which the tests do not exercise.

## W4: the Telegram Mini App

Status: wave W4, behind its own flag `TELEGRAM_MINIAPP` (off by default; needs `SECURE_MOMENTS`). With the flag off, every `/m/tg*` path falls through to the routing that existed before W4 and answers what it always answered (404); the helper tool is not advertised; no table is read or written.

The Mini App is a second way to prove "this human decided": a page on the secure host that Telegram opens inside the app. It decides through the same shared decision core as the passkey page (`src/access/decision-core.ts`) with `HumanProof { via: 'telegram_miniapp' }`.

### The threat model, stated plainly

**It is weaker than a passkey.** A WebAuthn passkey is verified by mupot against a public key. The Telegram step-up is a device secret that Telegram's `BiometricManager` releases after a fingerprint or face check. mupot cannot see the biometric.

What the two factors prove, exactly:

- **initData** (Ed25519, Telegram-signed): "Telegram launched a Mini App of *our dedicated bot* for Telegram user U, minutes ago."
- **device secret** (released by the biometric): "a Telegram client **running a page of this dedicated bot** unlocked the secret, once, for this member's enrolled phone."

Two facts about Telegram make the *bot* the root of trust, not the host:

1. `BiometricManager` tokens are stored **per bot**, not per origin.
2. `initData` carries **no URL**; it only names the bot and the user.

So *any* page the bot can launch (a menu button, an attachment-menu entry, another Mini App, a `web_app` button an LLM-driven gateway sends) can collect both factors from a genuine client: genuine initData plus one fingerprint tap that releases the secret. A server could then replay a decision from anywhere (`Origin` is just a header). Therefore:

- **The Mini App bot must be dedicated.** Its token is held by the worker alone (worker secret `TELEGRAM_MINIAPP_BOT_TOKEN`, required while the flag is on). It must not be the gateway bot (`kayhermes_mubot`), the notification bot (`TELEGRAM_BOT_TOKEN`; the worker refuses to enable if they match), or any bot an agent or harness can drive. It must have **no other Mini Apps, no menu button and no attachment-menu entries**: only the secure host. mupot cannot verify that last part; it is a human step (see the checklist below).
- **The worker sends the button itself** (Bot API `sendMessage`, a `web_app` inline button to `https://<secure host>/m/tg/<moment id>`), to the member's own bound private chat. A caller (an agent or a dashboard session) only *requests* delivery and receives a receipt. No harness ever handles a launch URL or an enrolment token.
- **The bot token is used only to send.** It never validates anything. Validation is Ed25519 against Telegram's published key, so the HMAC path was removed.
- **The device secret rotates on every won decision.** The old digest is retired. A retired secret presented later is, by construction, a copy (the genuine client holds the next one): the device is revoked on the spot and a receipt with `suspicious: 1` is written. A harvested copy therefore dies at the next real use, and its later use is detected. A copy that is *never* replayed before the next rotation simply stays dead.

What remains: whoever controls the dedicated bot's token, or code running in the Mini App origin after a human unlocks the secret once, can still act as that human for that session. That is why sensitive grants stay on passkeys. A lost response to a decision (the rotation landed but the client never stored the next secret) reads as a stale secret on the next use and revokes the device: the human sets the phone up again. That is the price of treating a stale secret as hostile.

### Configuration

| Variable | Meaning |
|---|---|
| `TELEGRAM_MINIAPP` | `1` or `true` turns the adapter on. |
| `TELEGRAM_MINIAPP_BOT_ID` | Numeric id of the **dedicated** Mini App bot. It goes into the string Telegram's signature is checked against, so data signed for any other bot is refused. Required. |
| `TELEGRAM_MINIAPP_BOT_TOKEN` | **Required worker secret** (`wrangler secret put`) of the same bot, used only to send the button. It must start with `<TELEGRAM_MINIAPP_BOT_ID>:`; if it is missing, malformed, names another bot, or matches `TELEGRAM_BOT_TOKEN`, the channel stays off (everything answers 404). |
| `TELEGRAM_MINIAPP_MAX_AGE_SECONDS` | How old the launch data's `auth_date` may be. Default 300, hard cap 3600; zero, negative or unparseable means the default. |
| `TELEGRAM_MINIAPP_EXTRA_PUBKEYS` | Staging only: comma-separated extra Ed25519 public keys (64 hex). Production leaves this unset and accepts Telegram's production key alone. |

The names are in the reviewed-names list.

### Verifying the launch data (no bot token involved)

1. Parse the `initData` query string strictly: every segment is `key=value`, keys are plain and unique, no empty segments, no control characters or whitespace in the raw string. **Decoded values are checked too**: a `%0A`, `%0D` or `%00` that decodes to a control character is refused in every field (it would fold one field's value into extra data-check-string lines, e.g. to fake `chat_type`). A duplicate key, including a second `signature` or `user`, is refused.
2. Build the data-check-string: `<bot_id>:WebAppData`, a line feed, then every received field **except `hash` and `signature`**, sorted alphabetically, as `key=<value>` lines joined by line feeds. The bot id comes from `TELEGRAM_MINIAPP_BOT_ID`, never from the payload.
3. Verify the `signature` as an Ed25519 signature over the UTF-8 bytes with Telegram's published public key. It is mandatory: a client that sends none (older than Bot API 8.0) is refused with a message to update Telegram. Telegram sends unpadded base64url; trailing `=` padding is tolerated (same bytes) and nothing else is.
4. Only then check `auth_date` (a positive integer, not older than the window, not more than 60 seconds in the future) and read the user id (a positive safe integer).

Source: <https://core.telegram.org/bots/webapps#validating-data-for-third-party-use> (read 2026-10-12). Telegram publishes no worked test vector, so the tests sign with `node:crypto` keys, an implementation independent of the WebCrypto verifier, and build the signed string in the test from the documented rules.

| Environment | Ed25519 public key (hex) | Accepted by default |
|---|---|---|
| Production | `e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d` | yes |
| Test | `40055058a4ee38156a06562e52eece92a771bcd8346a8c4615cb7376eddf72ec` | **no**, only via `TELEGRAM_MINIAPP_EXTRA_PUBKEYS` |

Launch data is a bearer for a few minutes: whoever has it can read a request they are entitled to see. It cannot decide anything on its own.

### Who is this Telegram user

The signed Telegram user id is compared with `members.telegram_chat_id`, the one binding the codebase has between a Telegram account and a member. It is set only by My Account, Connect Telegram, the invite bind and the pairing flow, never by the Mini App. In a private chat the chat id equals the user id, which is the private-chat rule the harness-attested verdict path (#1425) relies on.

- No member bound to that id, in this tenant: refused with "this Telegram account is not linked", with the way to link it.
- A bound member who is archived, suspended or welded to an agent (`memberIsActiveHuman`): refused as not eligible.
- `chat_type`: a launch whose `chat_type` is `group`, `supergroup` or `channel` (or any unknown value) is refused whoever signed it. `sender`, `private` and **an absent `chat_type`** are accepted. Absence is normal: a `web_app` inline button (the only way the worker launches it) is private-chat-only by Telegram's own rule and the launch data then carries no `chat_type` or `chat_instance`. The fence therefore rejects what is positively *not* private; it cannot prove privacy from an absence, which is why the button is only ever sent to the member's bound private chat id (a positive integer).
- The member comes from the signed id only; nothing in the request body can name one.
- Unlinking Telegram (`DELETE /members/<id>/telegram`) revokes the member's devices (`revoked_reason: telegram_unbound`). Binding only ever moves NULL to an id (never id to id), and a device is checked against the live binding at every use and inside the consume `WHERE`, so a re-link to another Telegram account never finds a device live.

### Setting up a phone

In the dashboard, **My Account, Telegram device**: the list of the member's devices (set-up and last-used times, a Remove button each) and **Set up this phone**.

1. **Set up this phone** (`POST /account/telegram-device/enrol`) has the same session rules as the passkey link (`checkEnrolmentSession`: a real web session of an active human, recent re-auth, live login identity). The **worker** mints the single-use ten-minute link and sends it as a `web_app` button to the member's own bound private chat. Nothing is returned to the page except a receipt. A member with no bound Telegram is told to connect it first.
2. Tapping the button opens `/m/tg/enrol/<token>` inside Telegram.
3. `start`: fresh launch data, and the Telegram user must be bound to **the member the link names**. The server issues `<device id>.<random secret>` and stores only the secret's sha256 in a pending row bound to the member, the Telegram user id and the login identity of the dashboard session. A second `start` under the same link supersedes the first.
4. The Mini App stores the secret with `updateBiometricToken`, then reads it back through `authenticate` (a biometric prompt).
5. `confirm`: the secret read back must hash to the stored digest, for the same member and Telegram user, with a live login identity. One batch activates the device and spends the link; a refusal on either side leaves the link unspent.

At most five active devices per member. At most five Mini App messages per member per ten minutes (a `tg_miniapp_deliveries` row per attempt is both the receipt and the ledger). Enrolment adds no authority.

**Not built:** enrolment by a mupot passkey assertion from inside the Mini App. Telegram's in-app browsers do not reliably support WebAuthn, and the challenge table's `purpose` CHECK would need a rebuild.

### Asking for a decision

An agent that filed a moment calls `moment_miniapp_link { moment_id, member_id? }` (advertised only while the flag is on). The worker checks that the caller is the filing agent or an org admin, that the moment is live and not a credential moment, and that the target member (the moment's named decider, else `member_id`) is an active human, bound to Telegram, **and able to decide this moment right now**; then it sends the button and returns `{ delivery_id, status, sent_at }`. Anything else reads as "cannot be reached" with nothing sent.

### Deciding

1. The page (`/m/tg/<moment id>`) loads Telegram's script and POSTs `Telegram.WebApp.initData` to `/m/tg/view`. The moment comes from the page the worker sent (`start_param` selects nothing). It is shown only to a member who may decide it and when it is addressed to that member or to anyone; unknown, out of authority and another tenant's moment all read as the same 404. A credential moment is refused with "open on a browser with a passkey".
2. `/m/tg/challenge`: fresh launch data, the policy below, and a single-use nonce bound to the moment, the decision, the exact parameters, the member **and** the Telegram user id. The nonces live in the Telegram channel's **own** table with its own cap (five live per member per moment), so a flood here cannot exhaust the passkey channel's challenge cap and the reverse. The member must already have an active device.
3. The Mini App unlocks the device secret with a biometric prompt and POSTs `/m/tg/decide`.
4. The server re-runs steps 1 to 2, then verifies the device secret **before** consuming the nonce (a bad secret never burns it) in constant time, for exactly this member and Telegram user, on a live login identity. A retired secret revokes the device. Then the nonce is consumed and the shared core runs with the channel's one guarded `UPDATE` as its gate. Every refusal the core could raise runs **before** the gate, exactly as in W1.
5. The gate re-checks inside its own `WHERE` that the moment is pending, unexpired, of a kind the Mini App may decide, addressed to this member or anyone, and that the device is still active for this member and Telegram user with this digest, on a live identity, with the Telegram binding still in place. In the same batch, each statement guarded by `changes() = 1`: the decision row (`tg_miniapp_decisions`), the retirement of the presented digest, and the new digest. The response carries `device_token_next` whenever the gate was won, whatever the core then did, and the page stores it with `updateBiometricToken`.
6. Receipts carry `via: telegram_miniapp`, the moment id, the Telegram user id and the device id. `secure_moments.decided_via` stays NULL for a Telegram decision; `tg_miniapp_decisions` is the channel record. `seed_attach_requests.decided_via` is `telegram_miniapp`.

### The step-up policy

| Decision | Telegram | Passkey |
|---|---|---|
| Seed attach, approve or deny | accepted | accepted |
| Deny of anything | accepted | accepted |
| Elevation approve, every selected action known and not passkey-only | accepted | accepted |
| Elevation approve containing a member of `SENSITIVE_STEP_UP_ACTIONS`, `action:home_access`, or any unknown action | **refused**: "untick the sensitive actions, or open on a browser with a passkey" | required |

`SENSITIVE_STEP_UP_ACTIONS` is the existing classification (`src/auth/elevation-actions.ts`), reused. `action:home_access` is Telegram's **own** addition (`TELEGRAM_PASSKEY_ONLY_EXTRA`): the dashboard does not demand a fresh reauth for it, but it reaches a member's private home squad and a client-attested secret is too weak for it. The policy is an allowlist: an action the registry does not know is refused too. It is applied to the actions the human **selected** (narrowing a request to its non-sensitive part is allowed), at challenge and again at decide. The page disables those checkboxes.

### Revocation

A device is revoked by sign out everywhere (`revokeAllWebSessions`), by revoking a login identity (only the devices enrolled under it), by unlinking Telegram, by the owner (`POST /account/telegram-device/<id>/revoke`, the Remove button), and by a stale-secret replay. A device on a revoked identity is also refused at use and inside the consume `WHERE`. A device never works for a different Telegram user id.

### CSP and the page

The Mini App pages (`/m/tg`, `/m/tg/<id>`, `/m/tg/enrol/<token>`) allow exactly one extra script source, `https://telegram.org/js/telegram-web-app.js`, beside the per-response nonce. Every other page and every JSON response keeps the W1 policy with no Telegram origin. The page is not frameable (`frame-ancestors 'none'`, `X-Frame-Options: DENY`): Telegram Web, which embeds Mini Apps in an iframe, is not supported (it has no `BiometricManager` either). The script is not pinned with Subresource Integrity because Telegram updates the file in place; the CSP path source is the pin.

The page gates on `Telegram.WebApp.isVersionAtLeast('8.0')` with a clear message (signatures need 8.0), offers `BiometricManager.openSettings()` after a permission denial, and tells "no saved device secret on this phone: set it up again" apart from "the biometric check was cancelled".

### Before a canary: the human steps

1. Create a **new** bot with BotFather. Not `kayhermes_mubot`, not `Sos_mumega_bot`.
2. In BotFather set the bot's **domain** to the secure host (`SECURE_MOMENTS_HOST`) and make sure the bot has **no** menu button, attachment-menu entry or other Mini App registered.
3. `wrangler secret put TELEGRAM_MINIAPP_BOT_TOKEN` (the new bot's token, held by the worker alone) and set `TELEGRAM_MINIAPP_BOT_ID` (its numeric id) and `TELEGRAM_MINIAPP=1`.
4. Each member opens a private chat with that bot once (Telegram refuses to let a bot message someone who never started it), and has Telegram connected to their member (My Account, Connect Telegram).
5. Then My Account, Telegram device, **Set up this phone**, on a phone with Telegram 8.0 or newer and biometrics enabled.

### W4.1: "Approve with passkey in your browser"

Telegram Desktop has no `BiometricManager`, so the Mini App used to dead-end at "Biometrics unavailable". The Mini App now always offers a second option, and shows it in place of the dead end: **Approve with passkey in your browser**.

`POST /m/tg/<moment id>/passkey-link` (same flag, same host, same-origin JSON) takes the Mini App `init_data` and runs the SAME door as view/challenge/decide: the existing Ed25519 verifier (pinned bot id, freshness, private chat), `resolveTelegramMember` (bound, active, human), then `loadDecidable` (moment pending, unexpired, a kind the Mini App supports, addressed to this member, and the member's current authority over it). A bound member without authority reads as 404, exactly like an unknown moment. It then rotates the moment's link token with the existing guarded rotation (`reserveRotation` then `reissueMomentLink`, by moment id) and returns `https://<secure host>/m/<id>/<token>` once. The client opens it with `Telegram.WebApp.openLink`, in the user's real browser, where the unchanged W1 passkey page decides.

- **The link alone grants nothing.** The decision still needs the member's WebAuthn passkey. Telegram proves only who asked for the link.
- **Bounded by the same ledger as the MCP plain-link fallback**: one rotation per moment per minute, five per moment in total, shared between both callers. The receipt is a `mutation_audit_entries` row (`moment_link_rotate`, handler `secure_moment`, evidence `{moment_id, reason: telegram_passkey_link, via: telegram_initdata}`) written by the reservation itself. The token and the initData are never logged or stored in a receipt.
- **Side effect**: rotating kills the previous link of that moment, including one an agent relayed. That is intended and the same as W3.1.

### Accepted limits

- The device secret is client-attested. Anything that can run in the Mini App origin after a human unlocks it can read it for that session. It is bound to a Telegram user and a member and useless without fresh launch data, but it is not a hardware-bound key.
- The secret is sent inside TLS on every decision (the server stores only a hash, so it cannot verify a keyed response). Rotation bounds what a copy is worth; it does not make a live copy useless within the same use.
- Retired digests are kept for the life of the device (one small row per decision); there is no pruning yet.
- Launch data cannot be refreshed in place: a human who leaves the Mini App open past the window must reopen it.
- Whoever controls a member's Telegram account and unlocked phone controls their Telegram approvals (the W1 accepted risk).
- `readParams` and `loadLiveSubject` are small copies of the same-named private functions in `routes.ts` (importing them would make a cycle with the mount); keep them in step until they are extracted.
- Needs a real phone: `BiometricManager` behaviour, the `web_app` button delivery by the dedicated bot, the CSP in Telegram's real webview, and whether the webview sends `Origin` on same-origin fetch have not been exercised against a live client.

**Before first use, each member presses Start on the approvals bot.** Telegram does not let a bot message someone who never started it; the worker reports that as `chat_unreachable` and the account page and `moment_miniapp_link` say so. Deliveries reserve their slot atomically before sending (5 per member per 10 minutes, shared by enrolment and moment buttons). A retired device secret revokes the device only when it is presented by that same member and Telegram user; from anyone else it is simply unknown.
