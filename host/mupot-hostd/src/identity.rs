//! Bearer-derived identity verification. Documentary names never override.

use crate::contract::{BrokerError, Scope, VerifiedScope};
use crate::policy::FENCED_LIVE_SEAT_UUIDS;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct IdentityEvidence {
    pub bearer_agent_id: String,
    pub requested_principal: String,
    #[serde(default)]
    pub documentary_principal: Option<String>,
    #[serde(default)]
    pub seat_live: bool,
    #[serde(default)]
    pub seat_agent_id: Option<String>,
    pub tenant: String,
    #[serde(default)]
    pub credential_fingerprint: Option<String>,
    #[serde(default)]
    pub revoked: bool,
    #[serde(default)]
    pub expired: bool,
    #[serde(default)]
    pub mupot_available: Option<bool>,
}

/// Same normalization used by adapters — not a second policy path.
pub fn normalize_evidence(raw: &str) -> Result<IdentityEvidence, BrokerError> {
    serde_json::from_str(raw).map_err(|_| BrokerError::InvalidInput)
}

pub fn verify_identity(evidence: &IdentityEvidence, now: i64) -> Result<VerifiedScope, BrokerError> {
    let _ = now;
    if evidence.revoked || evidence.expired {
        return Err(BrokerError::Revoked);
    }
    if evidence.mupot_available == Some(false) {
        return Err(BrokerError::SourceUnavailable);
    }
    if evidence.bearer_agent_id.trim().is_empty() {
        return Err(BrokerError::UnverifiedIdentity);
    }
    // Documentary / requested display names cannot override bearer.
    if evidence.requested_principal != evidence.bearer_agent_id {
        return Err(BrokerError::Conflict);
    }
    if let Some(doc) = &evidence.documentary_principal {
        if doc != &evidence.bearer_agent_id {
            // Visible conflict: documentary ≠ bearer.
            return Err(BrokerError::Conflict);
        }
    }
    if evidence.seat_live {
        if let Some(seat) = &evidence.seat_agent_id {
            if seat != &evidence.bearer_agent_id {
                // Live seat label cannot override bearer mismatch.
                return Err(BrokerError::Conflict);
            }
        }
    }
    let fingerprint = evidence
        .credential_fingerprint
        .clone()
        .unwrap_or_else(|| format!("fp:{}", evidence.bearer_agent_id));
    let scope = Scope {
        tenant: evidence.tenant.clone(),
        project: None,
        squad: None,
        agent: Some(evidence.bearer_agent_id.clone()),
        seat: evidence.seat_agent_id.clone(),
        flight: None,
        run: None,
        content_tiers: vec![],
        entity: None,
    };
    Ok(VerifiedScope::from_parts(scope, fingerprint, now))
}

/// Fixture entry used by `tests/identity.rs`.
pub fn verify_fixture(input: &str, now: i64) -> Result<VerifiedScope, BrokerError> {
    let evidence = normalize_evidence(input)?;
    verify_identity(&evidence, now)
}

pub fn seat_is_fenced(agent_id: &str) -> bool {
    FENCED_LIVE_SEAT_UUIDS.contains(&agent_id)
}
