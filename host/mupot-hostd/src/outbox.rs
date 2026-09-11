//! Durable outbox: claim → work → complete/dead-letter. Survives restart.

use crate::approval::{idempotency_key, ExactAction};
use crate::contract::BrokerError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutboxState {
    Pending,
    Claimed,
    Completed,
    DeadLetter,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutboxJob {
    pub idempotency_key: String,
    pub action_hash: String,
    pub stage: String,
    pub state: OutboxState,
    pub attempts: u32,
    pub payload_json: String,
    pub result_json: Option<String>,
    pub claimed_at_unix: Option<i64>,
}

#[derive(Default)]
struct OutboxInner {
    jobs: HashMap<String, OutboxJob>,
}

pub struct Outbox {
    path: PathBuf,
    inner: Mutex<OutboxInner>,
}

impl Outbox {
    pub fn open(path: &Path) -> Result<Self, BrokerError> {
        let mut inner = OutboxInner::default();
        if path.exists() {
            let bytes = std::fs::read(path).map_err(|_| BrokerError::CorruptState)?;
            if !bytes.is_empty() {
                let jobs: HashMap<String, OutboxJob> =
                    serde_json::from_slice(&bytes).map_err(|_| BrokerError::CorruptState)?;
                inner.jobs = jobs;
            }
        }
        Ok(Self {
            path: path.to_path_buf(),
            inner: Mutex::new(inner),
        })
    }

    fn persist(&self, inner: &OutboxInner) -> Result<(), BrokerError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| BrokerError::CorruptState)?;
        }
        let bytes = serde_json::to_vec_pretty(&inner.jobs).map_err(|_| BrokerError::CorruptState)?;
        std::fs::write(&self.path, bytes).map_err(|_| BrokerError::CorruptState)?;
        Ok(())
    }

    pub fn enqueue(
        &self,
        action: &ExactAction,
        stage: &str,
        payload_json: &str,
    ) -> Result<OutboxJob, BrokerError> {
        let key = idempotency_key(action, stage);
        let mut guard = self.inner.lock().map_err(|_| BrokerError::CorruptState)?;
        if let Some(existing) = guard.jobs.get(&key) {
            return Ok(existing.clone());
        }
        let job = OutboxJob {
            idempotency_key: key.clone(),
            action_hash: action.action_hash(),
            stage: stage.into(),
            state: OutboxState::Pending,
            attempts: 0,
            payload_json: payload_json.into(),
            result_json: None,
            claimed_at_unix: None,
        };
        guard.jobs.insert(key, job.clone());
        self.persist(&guard)?;
        Ok(job)
    }

    pub fn claim(&self, key: &str, now_unix: i64) -> Result<OutboxJob, BrokerError> {
        let mut guard = self.inner.lock().map_err(|_| BrokerError::CorruptState)?;
        let job = guard.jobs.get_mut(key).ok_or(BrokerError::InvalidInput)?;
        match job.state {
            OutboxState::Completed => return Ok(job.clone()),
            OutboxState::DeadLetter => return Err(BrokerError::Forbidden),
            OutboxState::Claimed => {
                // Restart recovery: re-claim same lease (no second mutation semantics).
                job.claimed_at_unix = Some(now_unix);
                job.attempts = job.attempts.saturating_add(1);
            }
            OutboxState::Pending => {
                job.state = OutboxState::Claimed;
                job.claimed_at_unix = Some(now_unix);
                job.attempts = job.attempts.saturating_add(1);
            }
        }
        if job.attempts > 5 {
            job.state = OutboxState::DeadLetter;
            self.persist(&guard)?;
            return Err(BrokerError::Forbidden);
        }
        let out = job.clone();
        self.persist(&guard)?;
        Ok(out)
    }

    pub fn complete(&self, key: &str, result_json: &str) -> Result<OutboxJob, BrokerError> {
        let mut guard = self.inner.lock().map_err(|_| BrokerError::CorruptState)?;
        let job = guard.jobs.get_mut(key).ok_or(BrokerError::InvalidInput)?;
        if job.state == OutboxState::Completed {
            return Ok(job.clone());
        }
        job.state = OutboxState::Completed;
        job.result_json = Some(result_json.into());
        let out = job.clone();
        self.persist(&guard)?;
        Ok(out)
    }

    pub fn get(&self, key: &str) -> Result<Option<OutboxJob>, BrokerError> {
        let guard = self.inner.lock().map_err(|_| BrokerError::CorruptState)?;
        Ok(guard.jobs.get(key).cloned())
    }

    pub fn recover_claimed_on_restart(&self) -> Result<Vec<OutboxJob>, BrokerError> {
        let guard = self.inner.lock().map_err(|_| BrokerError::CorruptState)?;
        Ok(guard
            .jobs
            .values()
            .filter(|j| j.state == OutboxState::Claimed)
            .cloned()
            .collect())
    }
}
