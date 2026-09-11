//! Inkwell read/write adapter — object ID/revision after authenticated read only.
//! Writes are fixture-first (F3); live canary is opt-in elsewhere.

use crate::adapters::{narrow_scope_ok, ReadAdapter};
use crate::contract::{
    BrokerError, Classification, Freshness, Observation, Readback, Scope, SourceRef, VerifiedScope,
};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Mutex;

pub struct InkwellAdapter {
    pub fixtures: BTreeMap<String, Value>,
}

/// Fixture write surface for approved commits. Tracks mutation count for replay safety.
#[derive(Debug, Default)]
pub struct InkwellWriteAdapter {
    objects: Mutex<BTreeMap<String, Value>>,
    /// Per-object write attempts (including rejected / uncertain).
    write_counts: Mutex<BTreeMap<String, u32>>,
    /// Scripted failure modes keyed by object id.
    modes: Mutex<BTreeMap<String, String>>,
}

impl InkwellWriteAdapter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn seed(&self, id: &str, body: Value) {
        self.objects.lock().unwrap().insert(id.into(), body);
    }

    pub fn set_mode(&self, id: &str, mode: &str) {
        self.modes.lock().unwrap().insert(id.into(), mode.into());
    }

    pub fn write_count(&self, id: &str) -> u32 {
        self.write_counts
            .lock()
            .unwrap()
            .get(id)
            .copied()
            .unwrap_or(0)
    }

    pub fn write_conditional(
        &self,
        target: &SourceRef,
        expected_revision: &str,
        payload_hash: &str,
        tenant: &str,
    ) -> Result<SourceRef, BrokerError> {
        let mut counts = self.write_counts.lock().map_err(|_| BrokerError::CorruptState)?;
        *counts.entry(target.id.clone()).or_insert(0) += 1;
        drop(counts);

        let mode = self
            .modes
            .lock()
            .map_err(|_| BrokerError::CorruptState)?
            .get(&target.id)
            .cloned()
            .unwrap_or_default();

        if mode == "timeout_uncertain" {
            return Err(BrokerError::UncertainWrite);
        }

        let mut objects = self.objects.lock().map_err(|_| BrokerError::CorruptState)?;
        let current = objects.get(&target.id).cloned();
        if let Some(body) = &current {
            let rev = body
                .get("revision")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if rev != expected_revision {
                return Err(BrokerError::RevisionChanged);
            }
            if body.get("tenant").and_then(|t| t.as_str()) != Some(tenant) {
                return Err(BrokerError::Forbidden);
            }
        }

        let new_rev = format!("{}+1", expected_revision);
        let mut body = current.unwrap_or_else(|| {
            serde_json::json!({
                "auth": true,
                "tenant": tenant,
            })
        });
        body["revision"] = Value::String(new_rev.clone());
        body["payload_hash"] = Value::String(payload_hash.into());
        body["auth"] = Value::Bool(true);
        body["tenant"] = Value::String(tenant.into());
        if mode == "mismatch_readback" {
            body["readback_hash"] = Value::String("drifted-hash".into());
        } else {
            body["readback_hash"] = Value::String(payload_hash.into());
        }
        objects.insert(target.id.clone(), body);

        Ok(SourceRef {
            system: "inkwell".into(),
            id: target.id.clone(),
            revision: new_rev,
        })
    }

    pub fn readback(&self, written: &SourceRef, tenant: &str) -> Result<Readback, BrokerError> {
        let objects = self.objects.lock().map_err(|_| BrokerError::CorruptState)?;
        let body = objects
            .get(&written.id)
            .ok_or(BrokerError::SourceUnavailable)?;
        if body.get("tenant").and_then(|t| t.as_str()) != Some(tenant) {
            return Err(BrokerError::Forbidden);
        }
        let value_hash = body
            .get("readback_hash")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        Ok(Readback {
            source: written.clone(),
            value_hash,
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
