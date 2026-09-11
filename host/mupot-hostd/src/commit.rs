//! Approved source write → readback → projection (fixture-capable).

use crate::adapters::inkwell::InkwellWriteAdapter;
use crate::adapters::mirror::MirrorWriteAdapter;
use crate::approval::{
    idempotency_key, mint_approval_for_action, parse_approval_token, require_approval,
    validate_approval, ExactAction,
};
use crate::contract::{BrokerError, Proposal, Receipt, SourceRef, Stage};
use crate::outbox::{Outbox, OutboxState};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitRequest {
    pub principal: String,
    pub tenant: String,
    pub proposal: Proposal,
    /// Structured Approval JSON only — never chat free-text.
    pub approval_json: Option<String>,
    pub now_unix: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommitResult {
    pub correlation_id: String,
    pub source_write: Receipt,
    pub source_readback: Option<Receipt>,
    pub projection: Option<Receipt>,
    pub projection_readback: Option<Receipt>,
    pub replayed: bool,
}

pub struct CommitEngine {
    pub outbox: Outbox,
    pub inkwell: InkwellWriteAdapter,
    pub mirror: MirrorWriteAdapter,
}

impl CommitEngine {
    pub fn execute(&self, req: &CommitRequest) -> Result<CommitResult, BrokerError> {
        let action = ExactAction::from_proposal(
            &req.principal,
            &req.tenant,
            &req.proposal,
            "source_write",
        );
        let approval_raw = req.approval_json.as_deref();
        let approval = match approval_raw {
            None => return Err(BrokerError::ApprovalRequired),
            Some(raw) => parse_approval_token(raw)?,
        };
        let _ = require_approval(Some(&approval))?;
        validate_approval(&approval, &action, req.now_unix)?;

        let source_key = idempotency_key(&action, "source_write");
        if let Some(existing) = self.outbox.get(&source_key)? {
            if existing.state == OutboxState::Completed {
                let raw = existing.result_json.as_deref().unwrap_or("{}");
                if raw.contains("\"uncertain\":true") {
                    // Prior timeout after possible write — no blind retry.
                    return Err(BrokerError::UncertainWrite);
                }
                let prior: CommitResult =
                    serde_json::from_str(raw).map_err(|_| BrokerError::CorruptState)?;
                return Ok(CommitResult {
                    replayed: true,
                    ..prior
                });
            }
        }

        let correlation_id = action.action_hash();
        self.outbox
            .enqueue(&action, "source_write", &serde_json::to_string(&req.proposal).unwrap())?;
        let _claim = self.outbox.claim(&source_key, req.now_unix)?;

        // Source write
        let write_res = self.inkwell.write_conditional(
            &req.proposal.target,
            &req.proposal.expected_revision,
            &req.proposal.payload_hash,
            &req.tenant,
        );
        let write_res = match write_res {
            Err(BrokerError::UncertainWrite) => {
                // Persist uncertainty; never auto-replay a non-idempotent source write.
                let _ = self
                    .outbox
                    .complete(&source_key, r#"{"uncertain":true}"#);
                return Err(BrokerError::UncertainWrite);
            }
            other => other?,
        };

        let source_write = Receipt {
            correlation_id: correlation_id.clone(),
            stage: Stage::Written,
            actor: req.principal.clone(),
            native_ref: Some(write_res.id.clone()),
            observed_at: "2026-09-11T12:00:00Z".into(),
            target: Some(write_res.clone()),
            evidence_hash: hash_str(&write_res.revision),
        };

        // Complete readback
        let readback = self.inkwell.readback(&write_res, &req.tenant)?;
        if readback.value_hash != format!("ink:{}", write_res.revision)
            && readback.value_hash != req.proposal.payload_hash
        {
            // Mismatch — no projection.
            let partial = CommitResult {
                correlation_id: correlation_id.clone(),
                source_write: source_write.clone(),
                source_readback: Some(Receipt {
                    correlation_id: correlation_id.clone(),
                    stage: Stage::ReadBack,
                    actor: req.principal.clone(),
                    native_ref: Some(readback.source.id.clone()),
                    observed_at: "2026-09-11T12:00:01Z".into(),
                    target: Some(readback.source.clone()),
                    evidence_hash: readback.value_hash.clone(),
                }),
                projection: None,
                projection_readback: None,
                replayed: false,
            };
            self.outbox
                .complete(&source_key, &serde_json::to_string(&partial).unwrap())?;
            return Err(BrokerError::Conflict);
        }

        let source_readback = Receipt {
            correlation_id: correlation_id.clone(),
            stage: Stage::ReadBack,
            actor: req.principal.clone(),
            native_ref: Some(readback.source.id.clone()),
            observed_at: "2026-09-11T12:00:01Z".into(),
            target: Some(readback.source.clone()),
            evidence_hash: readback.value_hash.clone(),
        };

        // Projection only after verified readback
        let proj_action = ExactAction {
            operation: "projection".into(),
            ..action.clone()
        };
        let proj_key = idempotency_key(&proj_action, "projection");
        self.outbox.enqueue(
            &proj_action,
            "projection",
            &json!({"source_revision": write_res.revision}).to_string(),
        )?;
        let _ = self.outbox.claim(&proj_key, req.now_unix)?;

        let dest = req
            .proposal
            .intended_projection
            .clone()
            .unwrap_or(SourceRef {
                system: "mirror".into(),
                id: format!("proj:{}", write_res.id),
                revision: write_res.revision.clone(),
            });

        let projected = match self.mirror.project(&dest, &write_res, &req.tenant) {
            Ok(p) => p,
            Err(e) => {
                let partial = CommitResult {
                    correlation_id: correlation_id.clone(),
                    source_write: source_write.clone(),
                    source_readback: Some(source_readback.clone()),
                    projection: None,
                    projection_readback: None,
                    replayed: false,
                };
                self.outbox
                    .complete(&source_key, &serde_json::to_string(&partial).unwrap())?;
                return Err(e);
            }
        };

        let projection = Receipt {
            correlation_id: correlation_id.clone(),
            stage: Stage::Projected,
            actor: req.principal.clone(),
            native_ref: Some(projected.id.clone()),
            observed_at: "2026-09-11T12:00:02Z".into(),
            target: Some(projected.clone()),
            evidence_hash: hash_str(&projected.revision),
        };

        let proj_rb = self.mirror.projection_readback(&projected, &req.tenant)?;
        if proj_rb.source.revision != write_res.revision {
            return Err(BrokerError::Conflict);
        }
        let projection_readback = Receipt {
            correlation_id: correlation_id.clone(),
            stage: Stage::ReadBack,
            actor: req.principal.clone(),
            native_ref: Some(proj_rb.source.id.clone()),
            observed_at: "2026-09-11T12:00:03Z".into(),
            target: Some(proj_rb.source),
            evidence_hash: proj_rb.value_hash,
        };

        let result = CommitResult {
            correlation_id,
            source_write,
            source_readback: Some(source_readback),
            projection: Some(projection),
            projection_readback: Some(projection_readback),
            replayed: false,
        };
        self.outbox
            .complete(&proj_key, &serde_json::to_string(&result).unwrap())?;
        self.outbox
            .complete(&source_key, &serde_json::to_string(&result).unwrap())?;
        Ok(result)
    }
}

fn hash_str(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    hex::encode(h.finalize())
}

/// Helper for tests: build matching approval JSON for a proposal.
pub fn approval_json_for(principal: &str, tenant: &str, proposal: &Proposal) -> String {
    let action = ExactAction::from_proposal(principal, tenant, proposal, "source_write");
    let approval = mint_approval_for_action(&action, 5);
    serde_json::to_string(&approval).unwrap()
}
