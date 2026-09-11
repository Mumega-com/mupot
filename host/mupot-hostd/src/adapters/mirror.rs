//! Mirror read/write adapter — preserve experienced/synthesized/consolidated labels.
//! Projection writes are fixture-first (F3).

use crate::adapters::{narrow_scope_ok, ReadAdapter};
use crate::contract::{
    BrokerError, Classification, Freshness, Observation, Readback, Scope, SourceRef, VerifiedScope,
};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Mutex;

pub struct MirrorAdapter {
    pub fixtures: BTreeMap<String, Value>,
}

#[derive(Debug, Default)]
pub struct MirrorWriteAdapter {
    projections: Mutex<BTreeMap<String, Value>>,
    project_counts: Mutex<BTreeMap<String, u32>>,
    modes: Mutex<BTreeMap<String, String>>,
}

impl MirrorWriteAdapter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_mode(&self, id: &str, mode: &str) {
        self.modes.lock().unwrap().insert(id.into(), mode.into());
    }

    pub fn project_count(&self, id: &str) -> u32 {
        self.project_counts
            .lock()
            .unwrap()
            .get(id)
            .copied()
            .unwrap_or(0)
    }

    pub fn project(
        &self,
        dest: &SourceRef,
        source: &SourceRef,
        tenant: &str,
    ) -> Result<SourceRef, BrokerError> {
        let mut counts = self
            .project_counts
            .lock()
            .map_err(|_| BrokerError::CorruptState)?;
        *counts.entry(dest.id.clone()).or_insert(0) += 1;
        drop(counts);

        let mode = self
            .modes
            .lock()
            .map_err(|_| BrokerError::CorruptState)?
            .get(&dest.id)
            .cloned()
            .unwrap_or_default();
        if mode == "projection_fail" {
            return Err(BrokerError::SourceUnavailable);
        }

        let mut projections = self
            .projections
            .lock()
            .map_err(|_| BrokerError::CorruptState)?;
        projections.insert(
            dest.id.clone(),
            serde_json::json!({
                "tenant": tenant,
                "source_id": source.id,
                "revision": source.revision,
                "memory_kind": "experienced",
            }),
        );
        Ok(SourceRef {
            system: "mirror".into(),
            id: dest.id.clone(),
            revision: source.revision.clone(),
        })
    }

    pub fn projection_readback(
        &self,
        projected: &SourceRef,
        tenant: &str,
    ) -> Result<Readback, BrokerError> {
        let projections = self
            .projections
            .lock()
            .map_err(|_| BrokerError::CorruptState)?;
        let body = projections
            .get(&projected.id)
            .ok_or(BrokerError::SourceUnavailable)?;
        if body.get("tenant").and_then(|t| t.as_str()) != Some(tenant) {
            return Err(BrokerError::Forbidden);
        }
        let revision = body
            .get("revision")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        Ok(Readback {
            source: SourceRef {
                system: "mirror".into(),
                id: projected.id.clone(),
                revision: revision.clone(),
            },
            value_hash: format!("mirror:{revision}"),
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
        })
    }
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
