//! Exact-action approval tests.

mod support;

use mupot_hostd::approval::{
    mint_approval_for_action, parse_approval_token, validate_approval, ExactAction,
};
use mupot_hostd::commit::{approval_json_for, CommitEngine, CommitRequest};
use mupot_hostd::contract::{BrokerError, Classification, Proposal, SourceRef};
use mupot_hostd::outbox::Outbox;
use mupot_hostd::adapters::inkwell::InkwellWriteAdapter;
use mupot_hostd::adapters::mirror::MirrorWriteAdapter;

fn sample_proposal(payload_hash: &str, rev: &str, expires: &str) -> Proposal {
    Proposal {
        target: SourceRef {
            system: "inkwell".into(),
            id: "obj-fixture-1".into(),
            revision: rev.into(),
        },
        expected_revision: rev.into(),
        payload_hash: payload_hash.into(),
        classification: Classification::Private,
        intended_projection: Some(SourceRef {
            system: "mirror".into(),
            id: "proj:obj-fixture-1".into(),
            revision: rev.into(),
        }),
        expires_at: expires.into(),
    }
}

#[test]
fn approval_cannot_be_reused_for_changed_payload() {
    support::run_case("approval", "payload_changed_denied");
    support::run_case("approval", "revision_changed_denied");
}

#[test]
fn free_text_is_not_an_approval_token() {
    assert_eq!(
        parse_approval_token("Hadi said yes in chat"),
        Err(BrokerError::Forbidden)
    );
    assert_eq!(
        parse_approval_token(""),
        Err(BrokerError::ApprovalRequired)
    );
}

#[test]
fn missing_approval_is_approval_required() {
    let dir = tempfile::tempdir().unwrap();
    let engine = CommitEngine {
        outbox: Outbox::open(&dir.path().join("outbox.json")).unwrap(),
        inkwell: InkwellWriteAdapter::new(),
        mirror: MirrorWriteAdapter::new(),
    };
    let proposal = sample_proposal("ph1", "r1", "2099-01-01T00:00:00Z");
    let err = engine
        .execute(&CommitRequest {
            principal: "hadi".into(),
            tenant: "mumega".into(),
            proposal,
            approval_json: None,
            now_unix: 1_780_000_000,
        })
        .unwrap_err();
    assert_eq!(err, BrokerError::ApprovalRequired);
}

#[test]
fn expired_approval_denied() {
    let proposal = sample_proposal("ph1", "r1", "2020-01-01T00:00:00Z");
    let action = ExactAction::from_proposal("hadi", "mumega", &proposal, "source_write");
    let approval = mint_approval_for_action(&action, 5);
    let err = validate_approval(&approval, &action, 1_780_000_000).unwrap_err();
    assert!(
        matches!(
            err,
            BrokerError::ApprovalExpired | BrokerError::ApprovalRequired
        ),
        "got {err:?}"
    );
}

#[test]
fn matching_approval_passes_hash() {
    let proposal = sample_proposal("ph1", "r1", "2099-01-01T00:00:00Z");
    let action = ExactAction::from_proposal("hadi", "mumega", &proposal, "source_write");
    let approval = mint_approval_for_action(&action, 5);
    validate_approval(&approval, &action, 1_780_000_000).unwrap();
    let json = approval_json_for("hadi", "mumega", &proposal);
    let parsed = parse_approval_token(&json).unwrap();
    assert_eq!(parsed.action_hash, action.action_hash());
}

#[test]
fn payload_changed_is_conflict_not_approval_required() {
    let proposal = sample_proposal("ph1", "r1", "2099-01-01T00:00:00Z");
    let action = ExactAction::from_proposal("hadi", "mumega", &proposal, "source_write");
    let approval = mint_approval_for_action(&action, 5);
    let mut drifted = proposal.clone();
    drifted.payload_hash = "ph-OTHER".into();
    let drifted_action = ExactAction::from_proposal("hadi", "mumega", &drifted, "source_write");
    let err = validate_approval(&approval, &drifted_action, 1_780_000_000).unwrap_err();
    assert_eq!(err, BrokerError::Conflict);
    assert_ne!(err, BrokerError::ApprovalRequired);
}

#[test]
fn revision_changed_is_revision_changed_not_approval_required() {
    let proposal = sample_proposal("ph1", "r1", "2099-01-01T00:00:00Z");
    let action = ExactAction::from_proposal("hadi", "mumega", &proposal, "source_write");
    let approval = mint_approval_for_action(&action, 5);
    let mut drifted = proposal.clone();
    drifted.expected_revision = "r2".into();
    drifted.target.revision = "r2".into();
    let drifted_action = ExactAction::from_proposal("hadi", "mumega", &drifted, "source_write");
    let err = validate_approval(&approval, &drifted_action, 1_780_000_000).unwrap_err();
    assert_eq!(err, BrokerError::RevisionChanged);
    assert_ne!(err, BrokerError::ApprovalRequired);
}
