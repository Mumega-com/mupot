//! `mupot-hostd` — local memory freshness broker.
//!
//! Flight 1 Task 1: contracts and dual-consumer fence only.
//! No daemon listen, no SSE, no inbox consume/ACK.

pub mod contract;
pub mod policy;

pub use contract::*;
pub use policy::*;
