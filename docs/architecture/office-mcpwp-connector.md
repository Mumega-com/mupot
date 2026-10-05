# Office addon: MCPWP connector auth and idempotent publish (mupot#1616)

Status: built on a branch, never exercised against a real WordPress site, no key
was ever used. The first real publish (mupot#1617) is still a human-present
acceptance test.

## Hop by hop: what `office.publish_post` does

1. `office.review_approval` (human) freezes `{title, content, installation_id,
   connector_id, site_origin}` as canonical JSON, stores its `payload_sha256` in
   `office_publish_freezes`, and the approver must echo that exact hash.
2. `office.publish_post` takes no content from the caller. It re-resolves the
   active installation, the write binding and the site origin and refuses on any
   drift from the frozen row (`binding_changed`).
3. One atomic claim (`UPDATE ... WHERE claimed_at IS NULL`) runs before any
   credential read or fetch. A claimed row is never un-claimed. The claim mints
   the idempotency key (`office_publish_freezes.idempotency_key`).
4. `useConnectorById(env, connectorId, 'mcpwp', ..., { mcpwpAuthMode: 'api_key' })`
   decrypts the vaulted secret for one fetch and builds the auth header inside the
   vault; the addon never sees the key.
5. `POST <origin>/wp-json/mcpwp/v1/posts` with `redirect: 'manual'`, an 8s timeout,
   after `assertPublicHttpsUrl`.
6. Receipt: the freeze row's `outcome` and the task's `done` receipt are written in
   one D1 batch.

## Auth contract (read from the plugin source, not guessed)

MCPWP reads the key in `get_api_key_from_request`
(`mcpwp/includes/traits/trait-mcpwp-api-auth.php:883-906`): `X-API-Key` header
first, then `Authorization: Bearer`, then an `?api_key=` query parameter. We send
`X-API-Key` only, never the query parameter (a URL is logged). A WordPress
application password sent as `Authorization: Basic` is not read by MCPWP and gets
a 401 on `/mcpwp/v1/*`; that was the defect in #1616 (`authenticatedFetch` sent
Basic for every `mcpwp` connector).

Resolution in `src/connectors/service.ts`: a caller pin (`mcpwpAuthMode`) wins,
then the connector meta `auth_mode` (`api_key` | `basic`), then legacy inference
(a `username` in meta means a pre-#1616 application-password connector and stays
Basic, because the marketing adapter and the content executor still call core
`/wp/v2` routes). The office pins `api_key` for publish, lookup and health, so
editable meta cannot steer it onto Basic. A caller-supplied `Authorization` or
`X-API-Key` header is dropped.

## Idempotency (post meta is the identity, the slug is a hint)

Create sends `meta: { mupot_office_idem: <key>, mupot_office_payload:
"sha256-<payload_sha256>" }` in the same call. The plugin has no query-by-meta
route (`wp_list_posts` takes search/status/category/ids only), so the lookup is:
collect candidates by slug search and title search (`status=any`), then read each
candidate's `GET /mcpwp/v1/post-meta/{id}` and compare. The hash is stored behind a
`sha256-` prefix because the plugin masks a bare 64-hex value to `***` on read-back
(`Mcpwp_Option_Access::looks_like_credential`).

| Situation | Result |
| --- | --- |
| a candidate has our key and the frozen hash | `found`: reconcile adopts it (task `done`, receipt `adoptedByPostMeta`) |
| a candidate has our key and a different or unreadable hash | `reconcile_conflict`: refused, never adopted, never overwritten, not overridable |
| candidates exist but none can be proven ours | `reconcile_candidate_found`: refused, not overridable |
| nothing found, or the check failed | `reconcile_check_unavailable`: only the audited, retried human override proceeds |

A conflict outranks a find, and so do two or more posts carrying the same key and hash (a WordPress author can copy custom fields onto their own post, so "first match wins" is not acceptable). A retried `publish_post` never reaches WordPress: the
one-shot claim refuses it (`publish_claimed`). Retry after "post created, receipt
write failed" goes through `office.reconcile_stalled_publish`, which adopts the post.

Adoption proves the post carries this claim's idempotency stamp (key plus approved-payload hash, written at create). It does NOT prove the post's current content still matches; the receipt says `postMetaStampVerified: true, contentReverified: false`.

Absence cannot be proven: the plugin cannot list trashed or custom-status posts,
and search is not a meta query. The existing "no inferred-absence" posture from
#1610 is kept on purpose.

## Draft first

Connector meta `publish_status: "draft"` creates the post with `status=draft`; the
receipt notes it is not public. The default (no setting) is still `publish`, so
approval semantics are unchanged. There is no separate "go public" tool: making a
draft public is a manual step in WordPress today.

## Key scope (MCPWP 3.13.0)

Verified in the plugin source (`git show v3.13.0:mcpwp/includes/traits/trait-mcpwp-api-auth.php`,
`publish_gated_routes` at line 1739 and the loop at 1812): `POST /mcpwp/v1/posts`
needs an ADMIN-scope key when the body status is `publish`, `private` or `future`;
a write-scope key may create drafts. 3.11.1 had no such gate. A read-scope key
sees published posts only, so it cannot run the lookup for drafts.

The office does not change its default status (`publish`, approval semantics). A
write-scope key with the default therefore gets a 403 on the create. The 403 is
treated as an unknown outcome (the claim stays locked, a retry cannot double-post)
and `office.publish_post` returns a fixed, human-readable hint (no key, no response
body): use `publish_status: "draft"` with a write key, or an admin key.

## Runbook for a connector's first run

1. Connector meta: `{"siteUrl": "https://example.com", "publish_status": "draft"}`; the
   secret is a write-scope MCPWP key. Site URL must be a site ROOT.
2. Publish once; confirm the draft in WordPress; make it public by hand.
3. Only then consider an admin-scope key and `publish_status: "publish"`.
4. Before using `override_reason` on a reconcile, check WordPress by hand for the post
   by its title and by the `mupot_office_idem` custom field. The lookup can miss a post
   (trashed, retitled and re-slugged, or a search plugin that disabled slug matching),
   and an override after such a miss can produce a second post.

## Other limits

- Subdirectory installs (`https://example.com/blog`) are refused with
  `unsupported_site_path` (publish, lookup, health): office calls address
  `<origin>/wp-json`, which would hit a different application.
- Redirects are never followed (`redirect: "manual"`) on publish, lookup and health:
  `X-API-Key` is not stripped by fetch on a cross-origin redirect.
- The SSRF check is lexical (`assertPublicHttpsUrl`); there is no DNS-rebinding
  defence in the addon. Workers egress is the backstop.
- The lookup reads at most 20 candidates' meta and treats a truncated list as
  unverifiable (a candidate), never as nothing found.

## Approval state and the double-post invariant

A task cannot leave `approved` through a verdict reversal while its publish claim is
unresolved (`claimed_at IS NOT NULL AND outcome IS NULL`): the stamp of
`reversed_at` carries `NOT EXISTS (unresolved claim)` in the same statement, and a
publish claim itself requires the verdict to be unreversed, so exactly one of
{reversal, claim} wins any race. The refusal is `office_publish_unresolved`
("a publish is in flight or unresolved; run office.reconcile_stalled_publish first").
The 'done' receipt is all-or-nothing in both directions: the freeze UPDATE needs the
task still `approved`, the task UPDATE needs the freeze UPDATE to have landed. If the
task left `approved` anyway, nothing is written, the claim stays open, and the result
is `publish_unreconciled` with the post id and link. A freeze that says `done` while
its task is not `done` also blocks a fresh freeze.

The invariant now lives in the shared generic task UPDATE (`buildTaskUpdateStatement`,
`src/tasks/service.ts`): for an APPROVED gate:office task it carries
`NOT EXISTS (unresolved publish claim)` in its own WHERE, so a claim that lands after
any pre-check (a claim does not touch `updated_at`) still refuses the write
atomically. Writers: MCP `task_update`, REST PATCH, routine actions
(`persistTaskUpdate`), `task_verdict_reverse` and the reversal step 2 all go through
that statement and inherit it; the reversal also keeps its own guard on the verdict
stamp; the dashboard gate-execute `approved -> done` uses
`markApprovedTaskDoneFromGate` with the same guard. A refused write surfaces as
`office_publish_unresolved` with the reconcile hint (MCP error, REST 409, dashboard
409), never a generic invalid transition. Every other task runs the UNCHANGED statement
(two variants chosen by the gate_owner already read in the request), so non-office tasks
never reference `office_publish_freezes`, and a schema without that table cannot make a
non-office update throw. Reject only applies from `review`, where no claim can exist.

The runbook warning "do not mark an office task done while a claim is open" is
therefore enforced by the system, not only by the runbook. This is code-only: no
migration (`office_publish_freezes` is core migration 0179, in every pot schema chain).

## First real publish: pre-flight

1. Use a WRITE-scope MCPWP key (not admin).
2. Connector meta exactly `{"siteUrl":"https://digid.ca","publish_status":"draft"}` with
   the literal lowercase key `publish_status` (any other spelling or value publishes
   PUBLICLY).
3. `siteUrl` is a bare https site root (no path, query or fragment).
4. Confirm the plugin version (3.13.0+ has the scope gate; the latest tag is 3.14.10).
5. Confirm permalinks resolve `/wp-json`.
6. Give the task a distinctive title (the lookup searches by title).
7. Run the addon health check and expect ok.
8. Approve the exact payload hash, then publish ONCE.
9. Check the draft in wp-admin.
10. If the result is `publish_outcome_unknown`, do NOT reverse the task: wait out the
    staleness window, then run `office.reconcile_stalled_publish`.
