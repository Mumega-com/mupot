//! Durable outbox claim / restart / replay tests.

mod support;

use mupot_hostd::approval::ExactAction;
use mupot_hostd::contract::{Classification, Proposal, SourceRef};
use mupot_hostd::outbox::{Outbox, OutboxState};

fn action() -> ExactAction {
    let proposal = Proposal {
        target: SourceRef {
            system: "inkwell".into(),
            id: "o1".into(),
            revision: "1".into(),
        },
        expected_revision: "1".into(),
        payload_hash: "p".into(),
        classification: Classification::Private,
        intended_projection: None,
        expires_at: "2099-01-01T00:00:00Z".into(),
    };
    ExactAction::from_proposal("hadi", "mumega", &proposal, "source_write")
}

#[test]
fn outbox_restart_after_claim() {
    support::run_case("outbox", "restart_after_claim");
}

#[test]
fn claim_survives_restart_without_second_complete() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("outbox.json");
    let a = action();
    {
        let box1 = Outbox::open(&path).unwrap();
        let job = box1.enqueue(&a, "source_write", "{}").unwrap();
        let claimed = box1.claim(&job.idempotency_key, 1_780_000_000).unwrap();
        assert_eq!(claimed.state, OutboxState::Claimed);
        assert_eq!(claimed.attempts, 1);
    }
    // Restart: reopen same durable file.
    let box2 = Outbox::open(&path).unwrap();
    let recovered = box2.recover_claimed_on_restart().unwrap();
    assert_eq!(recovered.len(), 1);
    let key = recovered[0].idempotency_key.clone();
    let reclaimed = box2.claim(&key, 1_780_000_001).unwrap();
    assert_eq!(reclaimed.state, OutboxState::Claimed);
    assert_eq!(reclaimed.attempts, 2);
    let done = box2.complete(&key, "{\"ok\":true}").unwrap();
    assert_eq!(done.state, OutboxState::Completed);
    // Replay complete is idempotent — no second mutation semantics.
    let again = box2.complete(&key, "{\"ok\":true}").unwrap();
    assert_eq!(again.state, OutboxState::Completed);
    assert_eq!(again.result_json.as_deref(), Some("{\"ok\":true}"));
}

#[test]
fn enqueue_is_idempotent_by_action_stage() {
    let dir = tempfile::tempdir().unwrap();
    let box1 = Outbox::open(&dir.path().join("outbox.json")).unwrap();
    let a = action();
    let j1 = box1.enqueue(&a, "source_write", "{\"a\":1}").unwrap();
    let j2 = box1.enqueue(&a, "source_write", "{\"a\":2}").unwrap();
    assert_eq!(j1.idempotency_key, j2.idempotency_key);
    assert_eq!(j2.payload_json, "{\"a\":1}");
}
