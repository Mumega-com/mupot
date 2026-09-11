mod support;

#[test]
fn mirror_conformance_keeps_tenant_and_synthesis_labels() {
    support::run_case("mirror", "tenant_denied");
    support::run_case("mirror", "bm25_tier_denied");
    support::run_case("mirror", "synthesized_not_experienced");
}

#[test]
fn inkwell_and_github_and_codex_cases() {
    support::run_case("inkwell", "auth_required");
    support::run_case("inkwell", "ok_object");
    support::run_case("github", "exact_sha");
    support::run_case("github", "timeout");
    support::run_case("codex_memory", "disabled");
}
