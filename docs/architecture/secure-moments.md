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
- Only two kinds of moment. Other secure requests (credential drop, Telegram Mini App, MCP URL-mode elicitation) are later waves.
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
