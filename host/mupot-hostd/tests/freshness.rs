mod support;

#[test]
fn newer_summary_does_not_overrule_owner() {
    support::run_case("reconciler", "newer_summary_not_authority");
    support::run_case("reconciler", "equal_authority_conflict");
}
