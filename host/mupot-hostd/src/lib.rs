//! `mupot-hostd` — local memory freshness broker.
//!
//! Flight 2: read-only host. No SSE, no inbox consume/ACK, no Flight 3 writes.

pub mod adapters;
pub mod context;
pub mod contract;
pub mod freshness;
pub mod identity;
pub mod policy;
pub mod rpc;
pub mod secrets;
pub mod store;

pub use contract::*;
pub use policy::*;
