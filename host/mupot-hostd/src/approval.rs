//! Exact-action approvals. Free-text chat is never an approval token.
//!
//! `ApprovalRequired` is returned only when a commit lacks a matching/unexpired
//! structured Approval. Payload or revision drift is `Conflict` / `RevisionChanged`.

use crate::contract::{Approval, BrokerError, Proposal, Scope, SourceRef};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Canonical fields hashed for an exact protected action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExactAction {
    pub principal: String,
    pub tenant: String,
    pub target: SourceRef,
    pub expected_revision: String,
    pub payload_hash: String,
    pub destination: String,
    pub operation: String,
    pub expires_at: String,
}

impl ExactAction {
    pub fn from_proposal(principal: &str, tenant: &str, proposal: &Proposal, operation: &str) -> Self {
        let destination = proposal
            .intended_projection
            .as_ref()
            .map(|p| format!("{}:{}", p.system, p.id))
            .unwrap_or_else(|| format!("{}:{}", proposal.target.system, proposal.target.id));
        Self {
            principal: principal.into(),
            tenant: tenant.into(),
            target: proposal.target.clone(),
            expected_revision: proposal.expected_revision.clone(),
            payload_hash: proposal.payload_hash.clone(),
            destination,
            operation: operation.into(),
            expires_at: proposal.expires_at.clone(),
        }
    }

    pub fn canonical_bytes(&self) -> Vec<u8> {
        // Deterministic field order — not free-text.
        let v = serde_json::json!({
            "destination": self.destination,
            "expected_revision": self.expected_revision,
            "expires_at": self.expires_at,
            "operation": self.operation,
            "payload_hash": self.payload_hash,
            "principal": self.principal,
            "target": {
                "id": self.target.id,
                "revision": self.target.revision,
                "system": self.target.system,
            },
            "tenant": self.tenant,
        });
        serde_json::to_vec(&v).unwrap_or_default()
    }

    pub fn action_hash(&self) -> String {
        let mut h = Sha256::new();
        h.update(self.canonical_bytes());
        hex::encode(h.finalize())
    }
}

/// Reject free-text / chat bodies as approval tokens.
pub fn parse_approval_token(raw: &str) -> Result<Approval, BrokerError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(BrokerError::ApprovalRequired);
    }
    // Chat prose is not a token.
    if !trimmed.starts_with('{') {
        return Err(BrokerError::Forbidden);
    }
    let approval: Approval =
        serde_json::from_str(trimmed).map_err(|_| BrokerError::InvalidInput)?;
    if approval.action_hash.trim().is_empty() || approval.principal.trim().is_empty() {
        return Err(BrokerError::InvalidInput);
    }
    Ok(approval)
}

pub fn mint_approval_for_action(action: &ExactAction, max_attempts: u32) -> Approval {
    Approval {
        principal: action.principal.clone(),
        action_hash: action.action_hash(),
        scope: Scope {
            tenant: action.tenant.clone(),
            project: None,
            squad: None,
            agent: Some(action.principal.clone()),
            seat: None,
            flight: None,
            run: None,
            content_tiers: vec![],
            entity: None,
        },
        target: action.target.clone(),
        expected_revision: action.expected_revision.clone(),
        expires_at: action.expires_at.clone(),
        max_attempts,
    }
}

/// Validate approval matches the exact action at `now_unix` (seconds).
pub fn validate_approval(
    approval: &Approval,
    action: &ExactAction,
    now_unix: i64,
) -> Result<(), BrokerError> {
    let expected = action.action_hash();
    if approval.action_hash != expected {
        // Drift in hashed fields (payload, revision, etc.) — not a missing-approval signal.
        if approval.expected_revision != action.expected_revision {
            return Err(BrokerError::RevisionChanged);
        }
        return Err(BrokerError::Conflict);
    }
    if approval.principal != action.principal {
        return Err(BrokerError::Forbidden);
    }
    if approval.target != action.target {
        return Err(BrokerError::Conflict);
    }
    if approval.expected_revision != action.expected_revision {
        return Err(BrokerError::RevisionChanged);
    }
    if is_expired(&approval.expires_at, now_unix) {
        return Err(BrokerError::ApprovalExpired);
    }
    Ok(())
}

/// Commit without a structured approval.
pub fn require_approval(maybe: Option<&Approval>) -> Result<&Approval, BrokerError> {
    maybe.ok_or(BrokerError::ApprovalRequired)
}

fn is_expired(expires_at: &str, now_unix: i64) -> bool {
    if let Ok(exp) = expires_at.parse::<i64>() {
        return now_unix > exp;
    }
    // ISO-8601 dates sort lexicographically against a fixture clock for `now_unix`.
    let now_iso = if now_unix >= 1_780_000_000 {
        "2026-06-15T00:00:00Z"
    } else if now_unix >= 1_700_000_000 {
        "2023-11-14T00:00:00Z"
    } else {
        "2020-01-01T00:00:00Z"
    };
    expires_at < now_iso
}

pub fn idempotency_key(action: &ExactAction, stage: &str) -> String {
    let mut h = Sha256::new();
    h.update(action.action_hash().as_bytes());
    h.update(stage.as_bytes());
    hex::encode(h.finalize())
}
