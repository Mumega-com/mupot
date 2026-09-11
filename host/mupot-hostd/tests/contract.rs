mod support;

use mupot_hostd::contract::{declared_capabilities, validate_fixture, BrokerError, SourceCapability};
use mupot_hostd::policy::{
    allowed_herdr_methods, allowed_mupot_rpcs, herdr_method_allowed, is_fenced_live_seat_uuid,
    mupot_rpc_allowed, refuse_seat_consumer, AllowedMupotRpc, FENCED_LIVE_SEAT_UUIDS,
    ForbiddenSeatConsumerAction, SeatConsumerAttempt, HERDR_ADAPTER_DOC, HERDR_ALLOWED_METHODS,
    HERDR_FORBIDDEN_METHODS, HERDR_PROTOCOL, INBOX_FENCE_DOC,
};
use serde_json::Value;

#[test]
fn observation_contract_rejects_authority_from_display_name() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/contract.json")).unwrap();
    assert!(validate_fixture(&fixture).is_err());
    assert_eq!(validate_fixture(&fixture), Err(BrokerError::Conflict));
}

#[test]
fn contract_vectors_cover_identity_tenant_stale_delete_supersession_partial() {
    let root: Value = serde_json::from_str(include_str!("fixtures/vectors.json")).unwrap();
    for case in root["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let expect = case["expect"].as_str().unwrap();
        support::run_fixture_case(&case["fixture"], expect);
        let _ = name;
    }
}

#[test]
fn inkwell_capabilities_do_not_claim_unproven_idempotency() {
    let caps = declared_capabilities("inkwell").unwrap();
    assert!(caps.contains(&SourceCapability::Read));
    assert!(caps.contains(&SourceCapability::Write));
    assert!(!caps.contains(&SourceCapability::CompareRevision));
    assert!(!caps.contains(&SourceCapability::Idempotency));
}

#[test]
fn dual_consumer_hostd_must_not_sse_poll_consume_or_ack_live_seat_uuids() {
    let root: Value =
        serde_json::from_str(include_str!("fixtures/dual_consumer.json")).unwrap();
    assert_eq!(root["bindings"]["inbox_fence_doc"], INBOX_FENCE_DOC);
    assert_eq!(root["bindings"]["herdr_adapter_doc"], HERDR_ADAPTER_DOC);

    let uuids = root["live_seat_uuids"].as_array().unwrap();
    assert_eq!(uuids.len(), FENCED_LIVE_SEAT_UUIDS.len());
    for uuid in uuids {
        let id = uuid.as_str().unwrap();
        assert!(
            is_fenced_live_seat_uuid(id),
            "fixture uuid {id} missing from FENCED_LIVE_SEAT_UUIDS"
        );
    }
    assert!(
        uuids
            .iter()
            .any(|u| u.as_str() == Some("870a5024-afd2-407e-86b3-fe2596e89bd1")),
        "Hermes UUID 870a5024 must be in dual_consumer fixture"
    );
    assert!(
        uuids
            .iter()
            .any(|u| u.as_str() == Some("f23a6c2c-7377-492f-8d69-96c3946a7148"))
    );
    assert!(
        uuids
            .iter()
            .any(|u| u.as_str() == Some("bec1bb7a-b37e-4594-b018-1f608ae38d47"))
    );

    let actions = [
        ForbiddenSeatConsumerAction::Sse,
        ForbiddenSeatConsumerAction::PollCursor,
        ForbiddenSeatConsumerAction::Consume,
        ForbiddenSeatConsumerAction::InboxAck,
    ];
    for uuid in uuids {
        let id = uuid.as_str().unwrap();
        for action in actions {
            let attempt = SeatConsumerAttempt {
                seat_or_delivery_uuid: id.to_string(),
                action,
            };
            assert_eq!(
                refuse_seat_consumer(&attempt),
                Err(BrokerError::Forbidden),
                "uuid={id} action={action:?}"
            );
        }
    }

    assert_eq!(
        mupot_rpc_allowed("inbox_ack"),
        Err(BrokerError::Forbidden)
    );
    assert_eq!(mupot_rpc_allowed("inbox"), Err(BrokerError::Forbidden));
    assert_eq!(mupot_rpc_allowed("connect"), Err(BrokerError::Forbidden));
    assert_eq!(
        mupot_rpc_allowed("boot_context"),
        Ok(AllowedMupotRpc::BootContext)
    );
    assert_eq!(
        allowed_mupot_rpcs(),
        [
            AllowedMupotRpc::BootContext,
            AllowedMupotRpc::Status,
            AllowedMupotRpc::ReceiptGet
        ]
        .into_iter()
        .collect()
    );
}

#[test]
fn herdr_adapter_allow_deny_names_match_river_spec() {
    assert_eq!(HERDR_PROTOCOL, 22);

    assert!(HERDR_ALLOWED_METHODS.contains(&"session.snapshot"));
    assert!(HERDR_ALLOWED_METHODS.contains(&"agent.list"));
    assert!(!HERDR_ALLOWED_METHODS.contains(&"snapshot"));
    assert_eq!(herdr_method_allowed("session.snapshot"), Ok(()));
    assert_eq!(herdr_method_allowed("agent.list"), Ok(()));
    assert_eq!(herdr_method_allowed("ping"), Ok(()));

    assert_eq!(
        herdr_method_allowed("agent.prompt"),
        Err(BrokerError::Forbidden)
    );
    assert_eq!(
        herdr_method_allowed("server.stop"),
        Err(BrokerError::Forbidden)
    );
    assert!(HERDR_FORBIDDEN_METHODS.contains(&"agent.prompt"));
    assert!(HERDR_FORBIDDEN_METHODS.contains(&"server.stop"));
    assert!(HERDR_FORBIDDEN_METHODS.contains(&"snapshot"));

    // Disproven bare name: not allowed, and explicitly forbidden.
    assert_eq!(
        herdr_method_allowed("snapshot"),
        Err(BrokerError::Forbidden)
    );

    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/dual_consumer.json")).unwrap();
    for method in fixture["allowed_herdr_methods"].as_array().unwrap() {
        let name = method.as_str().unwrap();
        assert_eq!(
            herdr_method_allowed(name),
            Ok(()),
            "allowed fixture method {name}"
        );
        assert!(allowed_herdr_methods().contains(name));
    }
    for method in fixture["forbidden_herdr_methods"].as_array().unwrap() {
        let name = method.as_str().unwrap();
        assert_eq!(
            herdr_method_allowed(name),
            Err(BrokerError::Forbidden),
            "forbidden fixture method {name}"
        );
    }

    // Inbox/stream/consume are not Herdr read methods — refuse as unsupported or via seat fence.
    assert_eq!(
        herdr_method_allowed("inbox"),
        Err(BrokerError::UnsupportedContract)
    );
    assert_eq!(
        herdr_method_allowed("stream"),
        Err(BrokerError::UnsupportedContract)
    );
    assert_eq!(
        herdr_method_allowed("consume"),
        Err(BrokerError::UnsupportedContract)
    );
}
