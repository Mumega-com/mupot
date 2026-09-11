//! GitHub read adapter — exact SHA vs branch; loopback fixtures only in tests.

use crate::adapters::{narrow_scope_ok, ReadAdapter};
use crate::contract::{
    BrokerError, Classification, Freshness, Observation, Readback, SourceRef, VerifiedScope,
};
use serde_json::Value;
use std::collections::BTreeMap;

pub struct GithubAdapter {
    pub fixtures: BTreeMap<String, Value>,
}

impl ReadAdapter for GithubAdapter {
    fn read(&self, source: &SourceRef, scope: &VerifiedScope) -> Result<Readback, BrokerError> {
        narrow_scope_ok(&scope.scope().tenant, scope)?;
        let body = self
            .fixtures
            .get(&source.id)
            .ok_or(BrokerError::SourceUnavailable)?;
        if body.get("error").and_then(|e| e.as_str()) == Some("timeout") {
            return Err(BrokerError::SourceUnavailable);
        }
        if body.get("error").and_then(|e| e.as_str()) == Some("forbidden") {
            return Err(BrokerError::Forbidden);
        }
        let revision = body
            .get("sha")
            .and_then(|v| v.as_str())
            .unwrap_or(&source.revision);
        Ok(Readback {
            source: SourceRef {
                system: "github".into(),
                id: source.id.clone(),
                revision: revision.into(),
            },
            value_hash: format!("gh:{revision}"),
            scope: scope.scope().clone(),
        })
    }

    fn recall(&self, query: &str, scope: &VerifiedScope) -> Result<Vec<Observation>, BrokerError> {
        let rb = self.read(
            &SourceRef {
                system: "github".into(),
                id: query.into(),
                revision: "HEAD".into(),
            },
            scope,
        )?;
        Ok(vec![Observation {
            fact_key: format!("github.{}", rb.source.id),
            value: None,
            value_hash: Some(rb.value_hash.clone()),
            source_system: "github".into(),
            source_uri: Some(format!("repo:{}", rb.source.id)),
            source_id: Some(rb.source.id.clone()),
            source_revision: Some(rb.source.revision.clone()),
            subject_type: "repository".into(),
            subject_id: rb.source.id.clone(),
            scope: scope.scope().clone(),
            observed_at: "2026-09-11T00:00:00Z".into(),
            valid_from: None,
            valid_until: None,
            supersedes: None,
            confidence: None,
            writer_principal: None,
            receipt_ref: Some(rb.source.revision.clone()),
            classification: Classification::Public,
            freshness: Some(Freshness::Fresh),
        }])
    }
}
