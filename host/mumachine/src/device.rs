use crate::*;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OperationId(u64);
/// Frozen device context cannot be serialized, including through its container.
/// ```compile_fail
/// fn encode(request: &mumachine::PollRequest) {
///     let _ = serde_json::to_string(request);
/// }
/// ```
#[derive(Debug)]
pub struct PollRequest {
    pub operation: OperationId,
    pub(crate) code: Secret,
    pub(crate) origin: PotOrigin,
    pub(crate) desired_agent: String,
    pub(crate) started: Instant,
    pub(crate) started_unix: u64,
    pub(crate) deadline: Instant,
}
struct Pending {
    challenge: DeviceChallenge,
    expires: Instant,
    next: Instant,
    in_flight: bool,
}
#[derive(Default)]
pub struct DeviceFlow {
    generation: u64,
    pending: Option<Pending>,
    awaiting_challenge: bool,
}
impl DeviceFlow {
    pub fn begin(&mut self) -> OperationId {
        self.generation = self
            .generation
            .checked_add(1)
            .expect("device generation exhausted");
        self.pending = None;
        self.awaiting_challenge = true;
        OperationId(self.generation)
    }
    pub fn cancel(&mut self) {
        self.begin();
        self.awaiting_challenge = false;
    }
    pub fn is_current(&self, op: OperationId) -> bool {
        op.0 == self.generation
    }
    pub fn accept_challenge(
        &mut self,
        op: OperationId,
        challenge: DeviceChallenge,
        now: Instant,
    ) -> Result<()> {
        if !self.is_current(op) || !self.awaiting_challenge {
            return Err(Error::StaleOperation);
        }
        if challenge.expires_in.is_zero()
            || challenge.expires_in > Duration::from_secs(3600)
            || challenge.interval.is_zero()
            || challenge.interval > Duration::from_secs(300)
        {
            return Err(Error::InvalidResponse);
        }
        if now >= challenge.deadline {
            self.cancel();
            return Err(Error::Expired);
        }
        self.pending = Some(Pending {
            expires: challenge.deadline.min(now + challenge.expires_in),
            next: now + challenge.interval,
            challenge,
            in_flight: false,
        });
        self.awaiting_challenge = false;
        Ok(())
    }
    pub fn challenge(&self) -> Option<&DeviceChallenge> {
        self.pending.as_ref().map(|p| &p.challenge)
    }
    pub fn remaining(&self, now: Instant) -> Option<Duration> {
        self.pending
            .as_ref()
            .map(|p| p.expires.saturating_duration_since(now))
    }
    pub fn poll_request(&mut self, now: Instant) -> Result<Option<PollRequest>> {
        if self.pending.as_ref().is_some_and(|p| now >= p.expires) {
            self.cancel();
            return Err(Error::Expired);
        }
        let Some(p) = &mut self.pending else {
            return Ok(None);
        };
        if p.in_flight || now < p.next {
            return Ok(None);
        }
        p.in_flight = true;
        Ok(Some(PollRequest {
            operation: OperationId(self.generation),
            code: p.challenge.device_code.clone(),
            origin: p.challenge.origin.clone(),
            desired_agent: p.challenge.desired_agent.clone(),
            started: p.challenge.started,
            started_unix: p.challenge.started_unix,
            deadline: p.challenge.deadline,
        }))
    }
    pub fn complete_poll(
        &mut self,
        op: OperationId,
        poll: DevicePoll,
        now: Instant,
    ) -> Result<Option<VerifiedConnection>> {
        if !self.is_current(op) || !self.pending.as_ref().is_some_and(|p| p.in_flight) {
            return Err(Error::StaleOperation);
        }
        if now >= self.pending.as_ref().unwrap().expires {
            self.cancel();
            return Err(Error::Expired);
        }
        match poll {
            DevicePoll::Pending(interval) | DevicePoll::SlowDown(interval) => {
                let slow = matches!(poll, DevicePoll::SlowDown(_));
                let p = self.pending.as_mut().unwrap();
                if interval.is_zero() || interval > Duration::from_secs(300) {
                    self.cancel();
                    return Err(Error::InvalidResponse);
                }
                p.challenge.interval = interval.max(
                    p.challenge.interval
                        + if slow {
                            Duration::from_secs(5)
                        } else {
                            Duration::ZERO
                        },
                );
                p.next = now + p.challenge.interval;
                p.in_flight = false;
                Ok(None)
            }
            DevicePoll::Verified(connection) => {
                self.cancel();
                if connection.is_expired() {
                    Err(Error::Expired)
                } else {
                    Ok(Some(*connection))
                }
            }
            DevicePoll::Denied => {
                self.cancel();
                Err(Error::Refused)
            }
            DevicePoll::Expired => {
                self.cancel();
                Err(Error::Expired)
            }
        }
    }
    pub fn fail(&mut self, op: OperationId) -> Result<()> {
        if !self.is_current(op) {
            return Err(Error::StaleOperation);
        }
        self.cancel();
        Ok(())
    }
}
