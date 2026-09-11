//! Canary / commit path fixture tests. Live stays ignored without Hadi's four facts.

mod support;

use mupot_hostd::adapters::inkwell::InkwellWriteAdapter;
use mupot_hostd::adapters::mirror::MirrorWriteAdapter;
use mupot_hostd::commit::{approval_json_for, CommitEngine, CommitRequest};
use mupot_hostd::contract::{BrokerError, Classification, Proposal, SourceRef};
use mupot_hostd::outbox::Outbox;
use serde_json::json;
use std::path::PathBuf;

fn proposal(id: &str, rev: &str, payload: &str) -> Proposal {
    Proposal {
        target: SourceRef {
            system: "inkwell".into(),
            id: id.into(),
            revision: rev.into(),
        },
        expected_revision: rev.into(),
        payload_hash: payload.into(),
        classification: Classification::Private,
        intended_projection: Some(SourceRef {
            system: "mirror".into(),
            id: format!("proj:{id}"),
            revision: rev.into(),
        }),
        expires_at: "2099-01-01T00:00:00Z".into(),
    }
}

fn engine(dir: &std::path::Path) -> CommitEngine {
    CommitEngine {
        outbox: Outbox::open(&dir.join("outbox.json")).unwrap(),
        inkwell: InkwellWriteAdapter::new(),
        mirror: MirrorWriteAdapter::new(),
    }
}

#[test]
fn projection_waits_for_verified_source_readback() {
    support::run_case("commit", "source_readback_mismatch_no_projection");
    support::run_case("commit", "source_success_projection_failure");
    support::run_case("commit", "timeout_after_remote_write_no_duplicate");
}

#[test]
fn happy_path_separate_stage_receipts() {
    let dir = tempfile::tempdir().unwrap();
    let eng = engine(dir.path());
    let id = "canary-ok";
    eng.inkwell.seed(
        id,
        json!({"auth": true, "tenant": "mumega", "revision": "1"}),
    );
    let prop = proposal(id, "1", "payload-ok");
    let approval = approval_json_for("hadi", "mumega", &prop);
    let result = eng
        .execute(&CommitRequest {
            principal: "hadi".into(),
            tenant: "mumega".into(),
            proposal: prop,
            approval_json: Some(approval),
            now_unix: 1_780_000_000,
        })
        .unwrap();
    assert!(!result.replayed);
    assert!(result.source_readback.is_some());
    assert!(result.projection.is_some());
    assert!(result.projection_readback.is_some());
    assert_eq!(eng.inkwell.write_count(id), 1);

    // Restart/replay same approved action — no second mutation.
    let eng2 = CommitEngine {
        outbox: Outbox::open(&dir.path().join("outbox.json")).unwrap(),
        inkwell: eng.inkwell,
        mirror: eng.mirror,
    };
    let prop2 = proposal(id, "1", "payload-ok");
    let approval2 = approval_json_for("hadi", "mumega", &prop2);
    let again = eng2
        .execute(&CommitRequest {
            principal: "hadi".into(),
            tenant: "mumega".into(),
            proposal: prop2,
            approval_json: Some(approval2),
            now_unix: 1_780_000_000,
        })
        .unwrap();
    assert!(again.replayed);
    assert_eq!(eng2.inkwell.write_count(id), 1);
}

#[test]
fn source_readback_mismatch_no_projection() {
    let dir = tempfile::tempdir().unwrap();
    let eng = engine(dir.path());
    let id = "canary-mismatch";
    eng.inkwell.seed(
        id,
        json!({"auth": true, "tenant": "mumega", "revision": "1"}),
    );
    eng.inkwell.set_mode(id, "mismatch_readback");
    let prop = proposal(id, "1", "payload-x");
    let approval = approval_json_for("hadi", "mumega", &prop);
    let err = eng
        .execute(&CommitRequest {
            principal: "hadi".into(),
            tenant: "mumega".into(),
            proposal: prop,
            approval_json: Some(approval),
            now_unix: 1_780_000_000,
        })
        .unwrap_err();
    assert_eq!(err, BrokerError::Conflict);
    assert_eq!(eng.mirror.project_count(&format!("proj:{id}")), 0);
}

#[test]
fn source_success_projection_failure() {
    let dir = tempfile::tempdir().unwrap();
    let eng = engine(dir.path());
    let id = "canary-proj-fail";
    eng.inkwell.seed(
        id,
        json!({"auth": true, "tenant": "mumega", "revision": "1"}),
    );
    eng.mirror
        .set_mode(&format!("proj:{id}"), "projection_fail");
    let prop = proposal(id, "1", "payload-y");
    let approval = approval_json_for("hadi", "mumega", &prop);
    let err = eng
        .execute(&CommitRequest {
            principal: "hadi".into(),
            tenant: "mumega".into(),
            proposal: prop,
            approval_json: Some(approval),
            now_unix: 1_780_000_000,
        })
        .unwrap_err();
    assert_eq!(err, BrokerError::SourceUnavailable);
    assert_eq!(eng.inkwell.write_count(id), 1);
}

#[test]
fn timeout_after_remote_write_no_duplicate() {
    let dir = tempfile::tempdir().unwrap();
    let eng = engine(dir.path());
    let id = "canary-timeout";
    eng.inkwell.seed(
        id,
        json!({"auth": true, "tenant": "mumega", "revision": "1"}),
    );
    eng.inkwell.set_mode(id, "timeout_uncertain");
    let prop = proposal(id, "1", "payload-z");
    let approval = approval_json_for("hadi", "mumega", &prop);
    let err = eng
        .execute(&CommitRequest {
            principal: "hadi".into(),
            tenant: "mumega".into(),
            proposal: prop.clone(),
            approval_json: Some(approval.clone()),
            now_unix: 1_780_000_000,
        })
        .unwrap_err();
    assert_eq!(err, BrokerError::UncertainWrite);
    assert_eq!(eng.inkwell.write_count(id), 1);
    // Replay of same approved action must not mutate again — still UncertainWrite.
    let err2 = eng
        .execute(&CommitRequest {
            principal: "hadi".into(),
            tenant: "mumega".into(),
            proposal: prop,
            approval_json: Some(approval),
            now_unix: 1_780_000_000,
        })
        .unwrap_err();
    assert_eq!(err2, BrokerError::UncertainWrite);
    assert_eq!(eng.inkwell.write_count(id), 1);
}

/// Live canary — refuses unless env + local config with owner IDs (no secrets in-repo).
/// Hadi has not supplied the four facts; this must stay skipped by default.
#[test]
#[ignore = "live canary requires MUPOT_HOSTD_LIVE_CANARY=1 and local owner config"]
fn live_private_object() {
    if std::env::var("MUPOT_HOSTD_LIVE_CANARY").ok().as_deref() != Some("1") {
        panic!("refusing live canary: set MUPOT_HOSTD_LIVE_CANARY=1");
    }
    let config_path = std::env::var("MUPOT_HOSTD_LIVE_CANARY_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs_live_config_fallback()
        });
    if !config_path.is_file() {
        panic!(
            "refusing live canary: missing local config at {} (no secrets in-repo; do not invent IDs)",
            config_path.display()
        );
    }
    let raw = std::fs::read_to_string(&config_path).expect("read live config");
    let cfg: serde_json::Value = serde_json::from_str(&raw).expect("parse live config");
    for key in [
        "rava_principal",
        "inkwell_object_id",
        "inkwell_expected_revision",
        "projection_destination",
    ] {
        let v = cfg.get(key).and_then(|x| x.as_str()).unwrap_or("");
        if v.is_empty() {
            panic!("refusing live canary: missing {key} in local config (Hadi must supply; do not invent)");
        }
    }
    // Secrets must not be embedded in config consumed by this test.
    if cfg.get("token").is_some() || cfg.get("secret").is_some() || cfg.get("api_key").is_some() {
        panic!("refusing live canary: config must not contain secrets");
    }
    panic!("live canary config present but live adapters are not enabled in this seat build — stop before inventing Rava/object/tokens");
}

fn dirs_live_config_fallback() -> PathBuf {
    // Local-only path; never commit. Not created by tests.
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()))
        .join(".config/mupot-hostd/live-canary.json")
}
