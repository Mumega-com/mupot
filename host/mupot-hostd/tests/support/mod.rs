//! Shared test helpers for contract fixtures.

use mupot_hostd::contract::{validate_fixture, BrokerError};
use serde_json::Value;

pub fn expect_result(result: Result<(), BrokerError>, expect: &str) {
    match expect {
        "ok" => assert!(result.is_ok(), "expected ok, got {result:?}"),
        "conflict" => assert_eq!(result, Err(BrokerError::Conflict)),
        "forbidden" => assert_eq!(result, Err(BrokerError::Forbidden)),
        "invalid_input" => assert_eq!(result, Err(BrokerError::InvalidInput)),
        "unsupported_contract" => assert_eq!(result, Err(BrokerError::UnsupportedContract)),
        other => panic!("unknown expect label: {other}"),
    }
}

pub fn run_fixture_case(fixture: &Value, expect: &str) {
    expect_result(validate_fixture(fixture), expect);
}
