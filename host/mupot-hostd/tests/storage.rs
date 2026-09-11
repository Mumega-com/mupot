use mupot_hostd::contract::{
    Classification, Observation, Receipt, Scope, SourceRef, Stage,
};
use mupot_hostd::store::Store;

#[test]
fn restart_preserves_cursor_and_observation() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("host.sqlite");
    let mut store = Store::open(&path).unwrap();
    store.record_cursor("mirror", "test-tenant", "42").unwrap();
    let obs = Observation {
        fact_key: "k1".into(),
        value: None,
        value_hash: Some("h".into()),
        source_system: "mirror".into(),
        source_uri: None,
        source_id: Some("obj1".into()),
        source_revision: Some("1".into()),
        subject_type: "doc".into(),
        subject_id: "obj1".into(),
        scope: Scope {
            tenant: "test-tenant".into(),
            project: None,
            squad: None,
            agent: None,
            seat: None,
            flight: None,
            run: None,
            content_tiers: vec![],
            entity: None,
        },
        observed_at: "2026-09-11T00:00:00Z".into(),
        valid_from: None,
        valid_until: None,
        supersedes: None,
        confidence: None,
        writer_principal: None,
        receipt_ref: None,
        classification: Classification::Project,
        freshness: None,
    };
    store.record_observation(&obs).unwrap();
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(
        store.cursor("mirror", "test-tenant").unwrap(),
        Some("42".into())
    );
    store.verify_audit_chain().unwrap();
}

#[test]
fn duplicate_receipt_conflicts() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("host.sqlite");
    let mut store = Store::open(&path).unwrap();
    let receipt = Receipt {
        correlation_id: "c1".into(),
        stage: Stage::Accepted,
        actor: "hostd".into(),
        native_ref: Some("n1".into()),
        observed_at: "2026-09-11T00:00:00Z".into(),
        target: Some(SourceRef {
            system: "inkwell".into(),
            id: "tenant-a".into(),
            revision: "1".into(),
        }),
        evidence_hash: "e".into(),
    };
    store.record_receipt(&receipt).unwrap();
    assert!(store.record_receipt(&receipt).is_err());
}

#[test]
fn backup_restore_preserves_cursor() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("host.sqlite");
    let backup = temp.path().join("backup.sqlite");
    let mut store = Store::open(&path).unwrap();
    store.record_cursor("github", "t1", "abc").unwrap();
    store.backup_to(&backup).unwrap();
    let restored = Store::open(&backup).unwrap();
    assert_eq!(restored.cursor("github", "t1").unwrap(), Some("abc".into()));
}

#[test]
fn corrupt_audit_chain_detected() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("host.sqlite");
    let mut store = Store::open(&path).unwrap();
    store.record_cursor("mirror", "t", "1").unwrap();
    // Tamper via raw sqlite
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute(
            "UPDATE audit_events SET event_hash='deadbeef' WHERE id=1",
            [],
        )
        .unwrap();
    }
    let store = Store::open(&path).unwrap();
    assert!(store.verify_audit_chain().is_err());
}
