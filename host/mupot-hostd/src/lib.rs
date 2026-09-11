//! `mupot-hostd` — local memory freshness broker.
//!
//! Flight 3: approved private writes via exact-action Approval + durable outbox.
//! No SSE, no inbox consume/ACK, no mint/connect.

pub mod adapters;
pub mod approval;
pub mod commit;
pub mod context;
pub mod contract;
pub mod freshness;
pub mod identity;
pub mod outbox;
pub mod policy;
pub mod rpc;
pub mod secrets;
pub mod store;

pub use contract::*;
pub use policy::*;
