//! Inkwell read adapter — object ID/revision after authenticated read only.

use crate::adapters::{narrow_scope_ok, ReadAdapter};
use crate::contract::{
    BrokerError, Classification, Freshness, Observation, Readback, SourceRef, VerifiedScope,
};
use serde_json::Value;
use std::collections::BTreeMap;

pub struct InkwellAdapter {
    pub fixtures: BTreeMap<String, Value>,
}

impl ReadAdapter for InkwellAdapter {
    fn read(&self, source: &SourceRef, scope: &VerifiedScope) -> Result<Readback, BrokerError> {
        narrow_scope_ok(&scope.scope().tenant, scope)?;
        let body = self
            .fixtures
            .get(&source.id)
            .ok_or(BrokerError::SourceUnavailable)?;
        if body.get("auth") != Some(&Value::Bool(true)) {
            return Err(BrokerError::Forbidden);
        }
        if body.get("tenant").and_then(|t| t.as_str()) != Some(scope.scope().tenant.as_str()) {
            return Err(BrokerError::Forbidden);
        }
        let revision = body
            .get("revision")
            .and_then(|v| v.as_str())
            .ok_or(BrokerError::UnverifiedIdentity)?;
        Ok(Readback {
            source: SourceRef {
                system: "inkwell".into(),
                id: source.id.clone(),
                revision: revision.into(),
            },
            value_hash: format!("ink:{revision}"),
            scope: scope.scope().clone(),
        })
    }

    fn recall(&self, query: &str, scope: &VerifiedScope) -> Result<Vec<Observation>, BrokerError> {
        let rb = self.read(
            &SourceRef {
                system: "inkwell".into(),
                id: query.into(),
                revision: "".into(),
            },
            scope,
        )?;
        Ok(vec![Observation {
            fact_key: format!("inkwell.{}", rb.source.id),
            value: None,
            value_hash: Some(rb.value_hash),
            source_system: "inkwell".into(),
            source_uri: Some(format!("inkwell:{}", rb.source.id)),
            source_id: Some(rb.source.id.clone()),
            source_revision: Some(rb.source.revision.clone()),
            subject_type: "document".into(),
            subject_id: rb.source.id,
            scope: scope.scope().clone(),
            observed_at: "2026-09-11T00:00:00Z".into(),
            valid_from: None,
            valid_until: None,
            supersedes: None,
            confidence: None,
            writer_principal: scope.scope().agent.clone(),
            receipt_ref: Some(rb.source.revision),
            classification: Classification::Private,
            freshness: Some(Freshness::Fresh),
        }])
    }
}
