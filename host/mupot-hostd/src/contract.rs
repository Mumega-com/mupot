//! Shared observation / adapter contracts for every hostd adapter.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

/// Tolerated clock skew for future `observed_at` values (seconds).
pub const OBSERVED_AT_SKEW_SECS: i64 = 120;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Scope {
    pub tenant: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub squad: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seat: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flight: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<String>,
    #[serde(default)]
    pub content_tiers: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entity: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Freshness {
    Fresh,
    Stale,
    Conflicted,
    Unverified,
    Superseded,
    SourceUnreachable,
}

/// Constructed only by identity verification (Flight 2). Opaque in Task 1.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedScope {
    scope: Scope,
    credential_fingerprint: String,
    verified_at_unix: i64,
}

impl VerifiedScope {
    /// Test / future identity-module constructor. Not for harness callers.
    pub fn from_parts(scope: Scope, credential_fingerprint: String, verified_at_unix: i64) -> Self {
        Self {
            scope,
            credential_fingerprint,
            verified_at_unix,
        }
    }

    pub fn scope(&self) -> &Scope {
        &self.scope
    }

    pub fn credential_fingerprint(&self) -> &str {
        &self.credential_fingerprint
    }

    pub fn verified_at_unix(&self) -> i64 {
        self.verified_at_unix
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceRef {
    pub system: String,
    pub id: String,
    pub revision: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Readback {
    pub source: SourceRef,
    pub value_hash: String,
    pub scope: Scope,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Requested,
    Accepted,
    Delivered,
    Consumed,
    Written,
    ReadBack,
    Projected,
    Reviewed,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BrokerError {
    #[error("invalid input")]
    InvalidInput,
    #[error("unverified identity")]
    UnverifiedIdentity,
    #[error("conflict")]
    Conflict,
    #[error("forbidden")]
    Forbidden,
    #[error("revoked")]
    Revoked,
    #[error("source unavailable")]
    SourceUnavailable,
    #[error("revision changed")]
    RevisionChanged,
    #[error("approval required")]
    ApprovalRequired,
    #[error("approval expired")]
    ApprovalExpired,
    #[error("uncertain write")]
    UncertainWrite,
    #[error("unsupported contract")]
    UnsupportedContract,
    #[error("corrupt state")]
    CorruptState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Classification {
    Public,
    Squad,
    Project,
    Entity,
    Private,
    CredentialMetadata,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceCapability {
    Read,
    Write,
    CompareRevision,
    Idempotency,
    LookupAfterTimeout,
    Delete,
    ProjectionReadback,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Observation {
    pub fact_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value_hash: Option<String>,
    pub source_system: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_uri: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_revision: Option<String>,
    pub subject_type: String,
    pub subject_id: String,
    pub scope: Scope,
    pub observed_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_until: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supersedes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub writer_principal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt_ref: Option<String>,
    pub classification: Classification,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub freshness: Option<Freshness>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Proposal {
    pub target: SourceRef,
    pub expected_revision: String,
    pub payload_hash: String,
    pub classification: Classification,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intended_projection: Option<SourceRef>,
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Receipt {
    pub correlation_id: String,
    pub stage: Stage,
    pub actor: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_ref: Option<String>,
    pub observed_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<SourceRef>,
    pub evidence_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Approval {
    pub principal: String,
    pub action_hash: String,
    pub scope: Scope,
    pub target: SourceRef,
    pub expected_revision: String,
    pub expires_at: String,
    pub max_attempts: u32,
}

/// Documentary / non-owner sources that must never mint Mupot authority.
const NON_OWNER_IDENTITY_SOURCES: &[&str] = &[
    "task_title",
    "display_name",
    "qnft_prose",
    "session_label",
    "request_body",
];

const CREDENTIAL_FIELD_KEYS: &[&str] = &[
    "token",
    "access_token",
    "refresh_token",
    "bearer",
    "password",
    "secret",
    "api_key",
    "credential",
    "mupot_token",
];

/// Authority owners for fact classes (plan §authority map). Display names are never owners.
pub fn authority_for_source(source_system: &str) -> Option<&'static str> {
    match source_system {
        "mupot" | "mupot_boot" | "mupot_status" => Some("mupot"),
        "herdr" => Some("herdr"),
        "inkwell" => Some("inkwell"),
        "mirror" => Some("mirror"),
        "github" => Some("github"),
        "codex_memory" => Some("codex_memory"),
        "seatlink" => Some("seatlink"),
        _ => None,
    }
}

fn json_contains_credential_keys(value: &Value) -> bool {
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                let lower = k.to_ascii_lowercase();
                if CREDENTIAL_FIELD_KEYS.iter().any(|c| lower == *c || lower.contains(c)) {
                    return true;
                }
                if json_contains_credential_keys(v) {
                    return true;
                }
            }
            false
        }
        Value::Array(items) => items.iter().any(json_contains_credential_keys),
        _ => false,
    }
}

fn parse_rfc3339_unix(s: &str) -> Result<i64, BrokerError> {
    // Minimal RFC3339 subset: `YYYY-MM-DDTHH:MM:SSZ` or with fractional seconds.
    // Full chrono is deferred; Task 1 only needs reject-future + presence checks.
    let trimmed = s.trim().trim_end_matches('Z');
    let (date, time) = trimmed.split_once('T').ok_or(BrokerError::InvalidInput)?;
    let mut d = date.split('-');
    let y: i64 = d.next().and_then(|x| x.parse().ok()).ok_or(BrokerError::InvalidInput)?;
    let mo: i64 = d.next().and_then(|x| x.parse().ok()).ok_or(BrokerError::InvalidInput)?;
    let day: i64 = d.next().and_then(|x| x.parse().ok()).ok_or(BrokerError::InvalidInput)?;
    let time = time.split('.').next().unwrap_or(time);
    let mut t = time.split(':');
    let h: i64 = t.next().and_then(|x| x.parse().ok()).ok_or(BrokerError::InvalidInput)?;
    let mi: i64 = t.next().and_then(|x| x.parse().ok()).ok_or(BrokerError::InvalidInput)?;
    let s: i64 = t.next().and_then(|x| x.parse().ok()).ok_or(BrokerError::InvalidInput)?;
    if !(1..=12).contains(&mo) || !(1..=31).contains(&day) || h > 23 || mi > 59 || s > 60 {
        return Err(BrokerError::InvalidInput);
    }
    // Approximate days-since-unix-epoch (good enough for skew tests; not a calendar library).
    let days = (y - 1970) * 365 + (y - 1969) / 4 + (mo - 1) * 30 + (day - 1);
    Ok(days * 86_400 + h * 3600 + mi * 60 + s)
}

/// Validate a fixture case used by every adapter conformance suite.
///
/// Required keys: `fact_key`, `source_system`, `subject_id`, `scope.tenant`,
/// `expected_authority`, `required_receipt`. Rejects missing provenance and
/// non-owner authority (e.g. `task_title` claiming `mupot`).
pub fn validate_fixture(fixture: &Value) -> Result<(), BrokerError> {
    if json_contains_credential_keys(fixture) {
        return Err(BrokerError::Forbidden);
    }

    let obj = fixture.as_object().ok_or(BrokerError::InvalidInput)?;
    let fact_key = obj
        .get("fact_key")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(BrokerError::InvalidInput)?;
    let _ = fact_key;

    let source_system = obj
        .get("source_system")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(BrokerError::InvalidInput)?;

    let subject_id = obj
        .get("subject_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(BrokerError::InvalidInput)?;
    let _ = subject_id;

    let scope = obj.get("scope").ok_or(BrokerError::InvalidInput)?;
    let tenant = scope
        .get("tenant")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(BrokerError::InvalidInput)?;
    let _ = tenant;

    let expected_authority = obj
        .get("expected_authority")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(BrokerError::InvalidInput)?;

    let required_receipt = obj
        .get("required_receipt")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(BrokerError::InvalidInput)?;
    let _ = required_receipt;

    if NON_OWNER_IDENTITY_SOURCES.contains(&source_system) {
        return Err(BrokerError::Conflict);
    }

    match authority_for_source(source_system) {
        Some(owner) if owner == expected_authority => {}
        Some(_) => return Err(BrokerError::Conflict),
        None => return Err(BrokerError::UnsupportedContract),
    }

    if let Some(class) = obj.get("classification") {
        if class.as_str().is_some() {
            let _: Classification =
                serde_json::from_value(class.clone()).map_err(|_| BrokerError::InvalidInput)?;
        } else {
            return Err(BrokerError::InvalidInput);
        }
    }

    if let Some(observed_at) = obj.get("observed_at").and_then(|v| v.as_str()) {
        let observed = parse_rfc3339_unix(observed_at)?;
        if let Some(now) = obj.get("now_unix").and_then(|v| v.as_i64()) {
            if observed > now + OBSERVED_AT_SKEW_SECS {
                return Err(BrokerError::InvalidInput);
            }
        }
    }

    if let Some(rev) = obj.get("source_revision") {
        if rev.is_null() {
            let freshness = obj
                .get("freshness")
                .and_then(|v| v.as_str())
                .ok_or(BrokerError::InvalidInput)?;
            if freshness != "unverified" {
                return Err(BrokerError::InvalidInput);
            }
        }
    }

    Ok(())
}

/// Declared capabilities for a named source after inspection (Task 1 freeze).
pub fn declared_capabilities(source: &str) -> Result<BTreeSet<SourceCapability>, BrokerError> {
    use SourceCapability::*;
    let caps: &[SourceCapability] = match source {
        "mupot" => &[Read],
        "herdr" => &[Read],
        "mirror" => &[Read, Write, Delete, ProjectionReadback],
        // Inkwell KV put/get inspected: no conditional revision / idempotency evidence yet.
        "inkwell" => &[Read, Write],
        "github" => &[Read, CompareRevision],
        "codex_memory" => &[Read], // disabled until opt-out/session exclusion proven
        "seatlink" => &[Read],     // notify-only ingress; never consume
        _ => return Err(BrokerError::UnsupportedContract),
    };
    Ok(caps.iter().copied().collect())
}

#[cfg(test)]
mod unit {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_credential_payload_keys() {
        let fixture = json!({
            "fact_key": "x",
            "source_system": "mupot",
            "subject_id": "a",
            "scope": {"tenant": "t"},
            "expected_authority": "mupot",
            "required_receipt": "boot",
            "token": "do-not-store"
        });
        assert_eq!(validate_fixture(&fixture), Err(BrokerError::Forbidden));
    }
}
