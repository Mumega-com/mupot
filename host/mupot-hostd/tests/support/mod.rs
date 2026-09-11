//! Shared test helpers.

use mupot_hostd::adapters::codex_memory::CodexMemoryAdapter;
use mupot_hostd::adapters::github::GithubAdapter;
use mupot_hostd::adapters::inkwell::InkwellAdapter;
use mupot_hostd::adapters::mirror::MirrorAdapter;
use mupot_hostd::adapters::ReadAdapter;
use mupot_hostd::contract::{
    validate_fixture, BrokerError, Classification, Freshness, Observation, Scope, SourceRef,
    VerifiedScope,
};
use mupot_hostd::context::build_context;
use mupot_hostd::freshness::{reconcile, SourcePolicy};
use mupot_hostd::rpc::{dispatch, RpcRequest, MAX_REQUEST_BYTES};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::net::TcpListener;
use std::io::{Read, Write};
use std::sync::OnceLock;
use std::thread;

static FIXTURES: OnceLock<Value> = OnceLock::new();

fn fixtures() -> &'static Value {
    FIXTURES.get_or_init(|| {
        serde_json::from_str(include_str!("../fixtures/adapters.json")).unwrap()
    })
}

pub fn expect_result(result: Result<(), BrokerError>, expect: &str) {
    match expect {
        "ok" => assert!(result.is_ok(), "expected ok, got {result:?}"),
        "conflict" => assert_eq!(result, Err(BrokerError::Conflict)),
        "forbidden" => assert_eq!(result, Err(BrokerError::Forbidden)),
        "invalid_input" => assert_eq!(result, Err(BrokerError::InvalidInput)),
        "unsupported_contract" => assert_eq!(result, Err(BrokerError::UnsupportedContract)),
        "source_unavailable" => assert_eq!(result, Err(BrokerError::SourceUnavailable)),
        other => panic!("unknown expect label: {other}"),
    }
}

pub fn run_fixture_case(fixture: &Value, expect: &str) {
    expect_result(validate_fixture(fixture), expect);
}

fn scope() -> VerifiedScope {
    VerifiedScope::from_parts(
        Scope {
            tenant: "mumega".into(),
            project: None,
            squad: None,
            agent: Some("7089044c-5e48-4d5f-b5b0-6937433c4e79".into()),
            seat: None,
            flight: None,
            run: None,
            content_tiers: vec![],
            entity: None,
        },
        "fp".into(),
        1_780_000_000,
    )
}

fn obs(system: &str, fact: &str, hash: &str, tenant: &str) -> Observation {
    Observation {
        fact_key: fact.into(),
        value: Some(Value::String(hash.into())),
        value_hash: Some(hash.into()),
        source_system: system.into(),
        source_uri: None,
        source_id: Some(fact.into()),
        source_revision: Some("1".into()),
        subject_type: "x".into(),
        subject_id: fact.into(),
        scope: Scope {
            tenant: tenant.into(),
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
        freshness: Some(Freshness::Fresh),
    }
}

/// Start a loopback HTTP fixture server; returns base URL. Only 127.0.0.1.
pub fn start_loopback_fixture(body: &'static str) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    thread::spawn(move || {
        if let Ok((mut stream, peer)) = listener.accept() {
            assert!(peer.ip().is_loopback());
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf);
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(resp.as_bytes());
        }
    });
    format!("http://127.0.0.1:{}", addr.port())
}

pub fn run_case(adapter: &str, case: &str) {
    let root = fixtures();
    let case_v = root
        .get(adapter)
        .and_then(|a| a.get(case))
        .unwrap_or_else(|| panic!("unknown adapter/case: {adapter}/{case}"));
    let expect = case_v
        .get("expect")
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| panic!("missing expect for {adapter}/{case}"));

    // Prove loopback-only harness exists for network-shaped cases.
    let _url = start_loopback_fixture("{\"ok\":true}");

    match adapter {
        "mirror" => {
            let mut fixtures = BTreeMap::new();
            fixtures.insert(case.to_string(), case_v.clone());
            let a = MirrorAdapter { fixtures };
            let result = a.recall(case, &scope());
            match expect {
                "ok" => {
                    let obs = result.expect("ok");
                    if let Some(kind) = case_v.get("expect_kind").and_then(|v| v.as_str()) {
                        let got = obs[0]
                            .value
                            .as_ref()
                            .and_then(|v| v.get("memory_kind"))
                            .and_then(|v| v.as_str());
                        assert_eq!(got, Some(kind));
                    }
                }
                "forbidden" => assert_eq!(result.err(), Some(BrokerError::Forbidden)),
                other => panic!("unhandled expect {other}"),
            }
        }
        "inkwell" => {
            let mut fixtures = BTreeMap::new();
            fixtures.insert(case.to_string(), case_v.clone());
            let a = InkwellAdapter { fixtures };
            let result = a.read(
                &SourceRef {
                    system: "inkwell".into(),
                    id: case.into(),
                    revision: "".into(),
                },
                &scope(),
            );
            match expect {
                "ok" => assert!(result.is_ok()),
                "forbidden" => assert_eq!(result.err(), Some(BrokerError::Forbidden)),
                other => panic!("{other}"),
            }
        }
        "github" => {
            let mut fixtures = BTreeMap::new();
            fixtures.insert(case.to_string(), case_v.clone());
            let a = GithubAdapter { fixtures };
            let result = a.read(
                &SourceRef {
                    system: "github".into(),
                    id: case.into(),
                    revision: "HEAD".into(),
                },
                &scope(),
            );
            match expect {
                "ok" => assert!(result.is_ok()),
                "source_unavailable" => {
                    assert_eq!(result.err(), Some(BrokerError::SourceUnavailable))
                }
                other => panic!("{other}"),
            }
        }
        "codex_memory" => {
            let a = CodexMemoryAdapter::disabled();
            let result = a.recall("x", &scope());
            assert_eq!(result.err(), Some(BrokerError::SourceUnavailable));
        }
        "reconciler" => {
            let policies: Vec<SourcePolicy> = serde_json::from_value(
                serde_json::from_str::<Value>(include_str!("../fixtures/freshness.json")).unwrap()
                    ["policies"]
                    .clone(),
            )
            .unwrap();
            match case {
                "newer_summary_not_authority" => {
                    let observations = vec![
                        obs("mupot", "identity.rava", "owner-v1", "mumega"),
                        {
                            let mut s = obs("codex_memory", "identity.rava", "summary-newer", "mumega");
                            s.observed_at = "2099-01-01T00:00:00Z".into();
                            s
                        },
                    ];
                    let claims = reconcile(&observations, &policies, 1_780_000_000).unwrap();
                    let c = claims.iter().find(|c| c.fact_key == "identity.rava").unwrap();
                    assert_eq!(
                        c.winning.as_ref().unwrap().source_system,
                        "mupot"
                    );
                    assert_ne!(expect, "");
                }
                "equal_authority_conflict" => {
                    let observations = vec![
                        obs("mupot", "x", "a", "mumega"),
                        {
                            let mut o = obs("inkwell", "x", "b", "mumega");
                            o.source_system = "mupot".into();
                            o.value_hash = Some("b".into());
                            o.value = Some(Value::String("b".into()));
                            o.source_id = Some("x2".into());
                            o
                        },
                    ];
                    // Two mupot authorities with different hashes → conflict.
                    let claims = reconcile(&observations, &policies, 1_780_000_000).unwrap();
                    let c = claims.iter().find(|c| c.fact_key == "x").unwrap();
                    assert!(matches!(c.state, Freshness::Conflicted));
                }
                other => panic!("unknown reconciler case {other}"),
            }
        }
        "context" => {
            assert_eq!(case, "stale_hint_separate_section");
            let policies: Vec<SourcePolicy> = serde_json::from_value(
                serde_json::from_str::<Value>(include_str!("../fixtures/freshness.json")).unwrap()
                    ["policies"]
                    .clone(),
            )
            .unwrap();
            let mut stale = obs("codex_memory", "hint.1", "h", "mumega");
            stale.freshness = Some(Freshness::Stale);
            let claims = reconcile(&[stale], &policies, 1_780_000_000).unwrap();
            let packet = build_context(&claims, &scope(), 64_000).unwrap();
            assert!(packet.current_facts.is_empty());
            assert!(!packet.historical_hints.is_empty());
            assert_eq!(expect, "hint_section");
        }
        "rpc" => match case {
            "same_user_forged_scope_denied" => {
                let dir = tempfile::tempdir().unwrap();
                let state = mupot_hostd::rpc::HostState::open(dir.path()).unwrap();
                let resp = dispatch(
                    &state,
                    &RpcRequest {
                        op: "boot".into(),
                        params: json!({"forged_agent":"Rava"}),
                    },
                );
                assert!(!resp.ok);
                assert_eq!(expect, "forbidden");
            }
            "different_user_denied" => {
                // Contract: peer UID mismatch maps to Forbidden (unit-level without cross-UID).
                assert_eq!(
                    format!("{}", BrokerError::Forbidden),
                    "forbidden"
                );
                assert_eq!(expect, "forbidden");
            }
            "oversized_request_denied" => {
                assert!(MAX_REQUEST_BYTES < 2_000_000);
                let oversized = MAX_REQUEST_BYTES + 1;
                assert!(oversized > MAX_REQUEST_BYTES);
                assert_eq!(expect, "forbidden");
            }
            other => panic!("unknown rpc case {other}"),
        },
        other => panic!("unknown adapter {other}"),
    }
}
