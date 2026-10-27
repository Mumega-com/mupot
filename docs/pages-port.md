# PagesPort (agent-written text records)

`src/pages/port.ts` is the provider-agnostic seam; the default adapter is the Inkwell wiki
(`src/pages/inkwell-adapter.ts`). Google Drive, SharePoint or any other store replaces it by implementing
`PagesPort` and changing nothing above it. **mupot keeps all authority; an adapter stores and returns text only.**

## v2 contract

- `get`, `put` (create-or-update by project + slug), `listBacklinks(projectId, slug)`.
- Optional markdown `body`, at most 64 KiB in UTF-8 bytes (`MAX_BODY_BYTES`). Over the cap is refused (400), never
  truncated. On `put`, `body` omitted = leave the stored body unchanged; a string (including `''`) replaces it.
- `supportsBody`: an adapter that cannot store a body refuses a non-empty one with
  `PagesPortError('unsupported', 'body_unsupported')`, surfaced as **501 `body_unsupported`**. Never dropped silently.
  The Inkwell adapter is `supportsBody: false` until inkwell-api stores bodies.
- `version` is server-stamped (monotonic counter in D1 `page_versions` plus the stamped envelope).

## Squad tier (enforced in mupot, not the adapter)

A `tier: "squad"` page is readable and writable only by workspace admins and members of a squad that has access to
the project (`callerHasSquadAccessToProject`, built on `projectVisibilityClause`). Org-wide observers and
department-only readers can read the project but not its squad pages. The check runs in the service layer on the
adapter's result, before anything reaches a caller, on `project_wiki_get`, backlinks, link lists, and every
surface that renders the raw graph (`project_wiki`, the dashboard wiki tab, `task_brief`). A hidden page answers
exactly like an absent one. The tier lives in the stamped envelope in the text record, so the service must ask the
adapter for the page to learn its tier; it never returns the raw result.

Tests: `tests/pages-v2.test.ts` (fake body-capable store, `tests/helpers/fake-pages-port.ts`) and
`tests/pages-port-contract.test.ts`.
