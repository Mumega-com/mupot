mod support;

#[test]
fn newer_summary_does_not_overrule_owner() {
    support::run_case("context", "stale_hint_separate_section");
}
