# Secure moments

Status: wave W1, behind a feature flag (off by default).

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
