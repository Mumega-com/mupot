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

A conflict outranks a find. A retried `publish_post` never reaches WordPress: the
one-shot claim refuses it (`publish_claimed`). Retry after "post created, receipt
write failed" goes through `office.reconcile_stalled_publish`, which adopts the post.

Absence cannot be proven: the plugin cannot list trashed or custom-status posts,
and search is not a meta query. The existing "no inferred-absence" posture from
#1610 is kept on purpose.

## Draft first

Connector meta `publish_status: "draft"` creates the post with `status=draft`; the
receipt notes it is not public. The default (no setting) is still `publish`, so
approval semantics are unchanged. There is no separate "go public" tool: making a
draft public is a manual step in WordPress today.
