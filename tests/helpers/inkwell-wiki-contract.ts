// tests/helpers/inkwell-wiki-contract.ts — the Inkwell wiki-documents/v1 wire contract mupot's tests replay.
// ONE place that names the server commit it models, so a drift check has a single line to compare:
//   mumega-com 914bf4fe  feat(wiki): expected_id page-identity fence on document writes (#1657) (#1660)
//   workers/inkwell-api/src/routes/internal-wiki.ts (service PUT /api/internal/wiki/topics/:slug)
// PUT evaluation ORDER on the server:
//   1. expected_version not a safe int >= 0 (and not legacy metadata)  -> 400 expected_version_required
//   2. expected_id present but empty / > 128 chars after trim           -> 400 invalid_expected_id
//   3. row exists but is another project's or not service-readable      -> 409 {topic_write_conflict}   (bare)
//      (an UNPUBLISHED but service-readable row PASSES this step, and a matching write republishes it)
//   4. create-vs-missing mismatch (v0 on an existing page, vN on none)  -> 409 (rich only if the row is published+readable)
//   5. body write, no expected_id, expected_version > 0:
//        published readable page -> 400 expected_id_required ; hidden, unpublished or absent -> 409 (bare)
//   6. expected_id given and != the row's id                            -> 409 (+ reason page_replaced when published+readable)
//   6b. a body write onto a corrupt stored document                     -> 409 invalid_content_blocks
//   7. version mismatch                                                 -> 409 {current_version,last_writer}
// Orderings that are NOT vacuous (each is asserted in tests/wiki-documents-caller.test.ts):
//   - 3 before 5: a hidden row never earns the typed 400 (existence oracle).
//   - 5 and 6 before 6b: a corrupt page written with a wrong id is page_replaced, with no id is expected_id_required;
//     only a matching id reaches invalid_content_blocks.
//   - 2 before 3: a blank id is 400 even on a hidden row.
// (4 vs 5 cannot overlap: 5 needs expected_version > 0, 4's collision needs 0. Do not claim an order between them.)
// GET /topics/:slug answers 404 for hidden AND unpublished rows. A "rich" 409 (current_version, last_writer) is sent only
// when the CURRENT row is in this project, readable and published.
// Handshake: capabilities carry expected_id:true.

export const INKWELL_MODELED_COMMIT = '914bf4fe' as const

export const INKWELL_V1_CAPABILITIES = {
  contract: 'wiki-documents/v1', body: true, max_body_bytes: 65536, conditional_writes: true, revision_history: true,
  expected_id: true,
} as const

export const INKWELL_PAGE_REPLACED_REASON = 'page_replaced' as const
export const INKWELL_MAX_EXPECTED_ID_LENGTH = 128 as const
