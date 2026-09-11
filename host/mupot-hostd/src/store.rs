//! Restart-safe SQLite WAL store.

use crate::contract::{BrokerError, Observation, Receipt};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const SCHEMA_VERSION: i64 = 1;
const MIGRATION_SQL: &str = include_str!("../migrations/001_initial.sql");

pub struct Store {
    conn: Connection,
    path: PathBuf,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, BrokerError> {
        let conn = Connection::open(path).map_err(|_| BrokerError::CorruptState)?;
        conn
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|_| BrokerError::CorruptState)?;
        conn
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(|_| BrokerError::CorruptState)?;
        let mut store = Self {
            conn,
            path: path.to_path_buf(),
        };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&mut self) -> Result<(), BrokerError> {
        self.conn
            .execute_batch(MIGRATION_SQL)
            .map_err(|_| BrokerError::CorruptState)?;
        let applied: Option<i64> = self
            .conn
            .query_row(
                "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| BrokerError::CorruptState)?;
        if let Some(v) = applied {
            if v > SCHEMA_VERSION {
                return Err(BrokerError::CorruptState);
            }
            if v == SCHEMA_VERSION {
                return Ok(());
            }
        }
        self.conn
            .execute(
                "INSERT OR REPLACE INTO schema_migrations(version, applied_at) VALUES (?1, datetime('now'))",
                params![SCHEMA_VERSION],
            )
            .map_err(|_| BrokerError::CorruptState)?;
        Ok(())
    }

    pub fn record_cursor(
        &mut self,
        source: &str,
        tenant: &str,
        cursor: &str,
    ) -> Result<(), BrokerError> {
        let tx = self.conn.transaction().map_err(|_| BrokerError::CorruptState)?;
        tx.execute(
            "INSERT INTO source_cursors(source, tenant, cursor_value, updated_at)
             VALUES (?1, ?2, ?3, datetime('now'))
             ON CONFLICT(source, tenant) DO UPDATE SET cursor_value=excluded.cursor_value, updated_at=excluded.updated_at",
            params![source, tenant, cursor],
        )
        .map_err(|_| BrokerError::CorruptState)?;
        Self::append_audit_tx(&tx, "cursor", source, tenant, cursor)?;
        tx.commit().map_err(|_| BrokerError::CorruptState)?;
        Ok(())
    }

    pub fn cursor(&self, source: &str, tenant: &str) -> Result<Option<String>, BrokerError> {
        self.conn
            .query_row(
                "SELECT cursor_value FROM source_cursors WHERE source=?1 AND tenant=?2",
                params![source, tenant],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| BrokerError::CorruptState)
    }

    pub fn record_observation(&mut self, obs: &Observation) -> Result<(), BrokerError> {
        let tenant = &obs.scope.tenant;
        let object_id = obs.source_id.as_deref().unwrap_or(&obs.fact_key);
        let payload = serde_json::to_string(obs).map_err(|_| BrokerError::InvalidInput)?;
        let tx = self.conn.transaction().map_err(|_| BrokerError::CorruptState)?;
        tx.execute(
            "INSERT INTO observations(tenant, source, object_id, fact_key, payload_json, observed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                tenant,
                obs.source_system,
                object_id,
                obs.fact_key,
                payload,
                obs.observed_at
            ],
        )
        .map_err(|e| {
            if e.to_string().contains("UNIQUE") {
                BrokerError::Conflict
            } else {
                BrokerError::CorruptState
            }
        })?;
        Self::append_audit_tx(&tx, "observation", &obs.source_system, tenant, &obs.fact_key)?;
        tx.commit().map_err(|_| BrokerError::CorruptState)?;
        Ok(())
    }

    pub fn record_receipt(&mut self, receipt: &Receipt) -> Result<(), BrokerError> {
        let tenant = receipt
            .target
            .as_ref()
            .map(|t| t.id.as_str())
            .unwrap_or("local");
        let source = receipt
            .target
            .as_ref()
            .map(|t| t.system.as_str())
            .unwrap_or("hostd");
        let native = receipt
            .native_ref
            .clone()
            .unwrap_or_else(|| receipt.correlation_id.clone());
        let payload = serde_json::to_string(receipt).map_err(|_| BrokerError::InvalidInput)?;
        let tx = self.conn.transaction().map_err(|_| BrokerError::CorruptState)?;
        tx.execute(
            "INSERT INTO receipts(source, tenant, native_receipt_id, payload_json, created_at)
             VALUES (?1, ?2, ?3, ?4, datetime('now'))",
            params![source, tenant, native, payload],
        )
        .map_err(|e| {
            if e.to_string().contains("UNIQUE") {
                BrokerError::Conflict
            } else {
                BrokerError::CorruptState
            }
        })?;
        Self::append_audit_tx(&tx, "receipt", source, tenant, &receipt.correlation_id)?;
        tx.commit().map_err(|_| BrokerError::CorruptState)?;
        Ok(())
    }

    pub fn receipt_by_correlation(&self, correlation_id: &str) -> Result<Option<Receipt>, BrokerError> {
        let row: Option<String> = self
            .conn
            .query_row(
                "SELECT payload_json FROM receipts WHERE payload_json LIKE ?1 LIMIT 1",
                params![format!("%\"correlation_id\":\"{correlation_id}\"%")],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| BrokerError::CorruptState)?;
        match row {
            Some(j) => Ok(Some(
                serde_json::from_str(&j).map_err(|_| BrokerError::CorruptState)?,
            )),
            None => Ok(None),
        }
    }

    pub fn last_audit_hash(&self) -> Result<String, BrokerError> {
        let hash: Option<String> = self
            .conn
            .query_row(
                "SELECT event_hash FROM audit_events ORDER BY id DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| BrokerError::CorruptState)?;
        Ok(hash.unwrap_or_else(|| "genesis".into()))
    }

    pub fn verify_audit_chain(&self) -> Result<(), BrokerError> {
        let mut stmt = self
            .conn
            .prepare("SELECT previous_hash, event_hash, payload_json FROM audit_events ORDER BY id")
            .map_err(|_| BrokerError::CorruptState)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|_| BrokerError::CorruptState)?;
        let mut prev = "genesis".to_string();
        for row in rows {
            let (previous, event_hash, payload) = row.map_err(|_| BrokerError::CorruptState)?;
            if previous != prev {
                return Err(BrokerError::CorruptState);
            }
            let expected = hash_event(&prev, &payload);
            if expected != event_hash {
                return Err(BrokerError::CorruptState);
            }
            prev = event_hash;
        }
        Ok(())
    }

    pub fn backup_to(&self, dest: &Path) -> Result<(), BrokerError> {
        // Flush WAL then copy the database file. Avoids depending on rusqlite "backup" feature quirks.
        self.conn
            .execute_batch("PRAGMA wal_checkpoint(FULL);")
            .map_err(|_| BrokerError::CorruptState)?;
        std::fs::copy(&self.path, dest).map_err(|_| BrokerError::CorruptState)?;
        Ok(())
    }

    fn append_audit_tx(
        tx: &rusqlite::Transaction<'_>,
        kind: &str,
        source: &str,
        tenant: &str,
        key: &str,
    ) -> Result<(), BrokerError> {
        let previous: String = tx
            .query_row(
                "SELECT event_hash FROM audit_events ORDER BY id DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| BrokerError::CorruptState)?
            .unwrap_or_else(|| "genesis".into());
        let payload = serde_json::json!({
            "kind": kind,
            "source": source,
            "tenant": tenant,
            "key": key,
        })
        .to_string();
        let event_hash = hash_event(&previous, &payload);
        tx.execute(
            "INSERT INTO audit_events(previous_hash, event_hash, payload_json, created_at)
             VALUES (?1, ?2, ?3, datetime('now'))",
            params![previous, event_hash, payload],
        )
        .map_err(|_| BrokerError::CorruptState)?;
        Ok(())
    }
}

fn hash_event(previous: &str, payload: &str) -> String {
    let mut h = Sha256::new();
    h.update(previous.as_bytes());
    h.update(payload.as_bytes());
    hex::encode(h.finalize())
}
