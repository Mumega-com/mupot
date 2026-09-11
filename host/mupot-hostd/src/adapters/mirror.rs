//! Mirror read adapter — preserve experienced/synthesized/consolidated labels.

use crate::adapters::{narrow_scope_ok, ReadAdapter};
use crate::contract::{
    BrokerError, Classification, Freshness, Observation, Readback, SourceRef, VerifiedScope,
};
use serde_json::Value;
use std::collections::BTreeMap;

pub struct MirrorAdapter {
    pub fixtures: BTreeMap<String, Value>,
}

impl ReadAdapter for MirrorAdapter {
    fn read(&self, source: &SourceRef, scope: &VerifiedScope) -> Result<Readback, BrokerError> {
        narrow_scope_ok(&scope.scope().tenant, scope)?;
        let body = self
            .fixtures
            .get(&source.id)
            .ok_or(BrokerError::SourceUnavailable)?;
        if body.get("tenant").and_then(|t| t.as_str()) != Some(scope.scope().tenant.as_str()) {
            return Err(BrokerError::Forbidden);
        }
        if body.get("tier_denied") == Some(&Value::Bool(true)) {
            return Err(BrokerError::Forbidden);
        }
        let revision = body
            .get("revision")
            .and_then(|v| v.as_str())
            .unwrap_or("1");
        Ok(Readback {
            source: SourceRef {
                system: "mirror".into(),
                id: source.id.clone(),
                revision: revision.into(),
            },
            value_hash: format!("mirror:{revision}"),
            scope: scope.scope().clone(),
        })
    }

    fn recall(&self, query: &str, scope: &VerifiedScope) -> Result<Vec<Observation>, BrokerError> {
        let body = self
            .fixtures
            .get(query)
            .ok_or(BrokerError::SourceUnavailable)?;
        if body.get("tenant").and_then(|t| t.as_str()) != Some(scope.scope().tenant.as_str()) {
            return Err(BrokerError::Forbidden);
        }
        if body.get("tier_denied") == Some(&Value::Bool(true)) {
            return Err(BrokerError::Forbidden);
        }
        let label = body
            .get("memory_kind")
            .and_then(|v| v.as_str())
            .unwrap_or("experienced");
        let revision = body
            .get("revision")
            .and_then(|v| v.as_str())
            .unwrap_or("1");
        Ok(vec![Observation {
            fact_key: format!("mirror.{query}"),
            value: Some(serde_json::json!({"memory_kind": label, "text": body.get("text")})),
            value_hash: Some(format!("mirror:{revision}")),
            source_system: "mirror".into(),
            source_uri: Some(format!("mirror:context:{query}")),
            source_id: Some(query.into()),
            source_revision: Some(revision.into()),
            subject_type: "engram".into(),
            subject_id: query.into(),
            scope: scope.scope().clone(),
            observed_at: "2026-09-11T00:00:00Z".into(),
            valid_from: None,
            valid_until: None,
            supersedes: None,
            confidence: None,
            writer_principal: None,
            receipt_ref: Some(format!("mirror:{label}")),
            classification: Classification::Project,
            freshness: Some(Freshness::Fresh),
        }])
    }
}
