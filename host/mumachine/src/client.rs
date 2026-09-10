use crate::*;
use reqwest::{
    blocking::Client,
    header::{AUTHORIZATION, HeaderValue},
    redirect::Policy,
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::{
    io::Read,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;

const BODY_LIMIT: u64 = 1_048_576;
#[derive(Clone)]
pub struct MupotClient {
    origin: PotOrigin,
    http: Client,
}
impl MupotClient {
    pub fn new(origin: PotOrigin) -> Result<Self> {
        let http = Client::builder()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .no_proxy()
            .user_agent("Mupot-Connect/0.1")
            .build()
            .map_err(|_| Error::Transport)?;
        Ok(Self { origin, http })
    }
    pub fn origin(&self) -> &PotOrigin {
        &self.origin
    }
    fn request(
        &self,
        path: &str,
        body: Option<Value>,
        token: Option<&Secret>,
        device_errors: bool,
    ) -> Result<Value> {
        let url = format!("{}{path}", self.origin.as_str());
        let mut request = if let Some(body) = body {
            self.http.post(url).json(&body)
        } else {
            self.http.get(url)
        };
        if let Some(token) = token {
            let mut header = HeaderValue::from_str(&format!("Bearer {}", token.expose()))
                .map_err(|_| Error::InvalidInput)?;
            header.set_sensitive(true);
            request = request
                .header(AUTHORIZATION, header)
                .header("x-mupot-source", "mumachine")
                .header("x-mupot-seat", "mupot-connect");
        }
        let response = request.send().map_err(|_| Error::Transport)?;
        let status = response.status();
        if !status.is_success() && !(device_errors && status.as_u16() == 400) {
            return Err(Error::Refused);
        }
        if response.content_length().is_some_and(|n| n > BODY_LIMIT) {
            return Err(Error::ResponseTooLarge);
        }
        let mut bytes = Zeroizing::new(Vec::new());
        response
            .take(BODY_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::Transport)?;
        if bytes.len() as u64 > BODY_LIMIT {
            return Err(Error::ResponseTooLarge);
        }
        serde_json::from_slice(&bytes).map_err(|_| Error::InvalidResponse)
    }
    fn action(&self, path: &str, token: &Secret, args: Value) -> Result<Value> {
        let mut value = self.request(path, Some(args), Some(token), false)?;
        if value.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(Error::Refused);
        }
        if value.get("result").is_none() {
            return Err(Error::InvalidResponse);
        }
        Ok(value["result"].take())
    }
    pub fn health(&self) -> Result<Health> {
        let health: Health = decode(self.request("/health", None, None, false)?)?;
        if !health.ok || health.service != "mupot" || health.tenant.is_empty() {
            return Err(Error::InvalidResponse);
        }
        Ok(health)
    }
    pub fn start_device(&self, desired_agent: &str) -> Result<DeviceChallenge> {
        identifier(desired_agent)?;
        let started = Instant::now();
        let mut value = self.request(
            "/device/code",
            Some(json!({"agent":desired_agent})),
            None,
            false,
        )?;
        let device_code = secret_field(&mut value, "device_code")?;
        let user_code = string(&value, "user_code")?.to_owned();
        if user_code.len() > 32
            || !user_code
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
        {
            return Err(Error::InvalidResponse);
        }
        let uri = string(&value, "verification_uri")?;
        if uri != format!("{}/device", self.origin.as_str()) {
            return Err(Error::InvalidResponse);
        }
        let ttl = seconds(&value, "expires_in", 3600)?;
        let interval = seconds(&value, "interval", 300)?;
        let remaining = ttl
            .checked_sub(started.elapsed())
            .filter(|d| !d.is_zero())
            .ok_or(Error::Expired)?;
        Ok(DeviceChallenge {
            device_code,
            user_code,
            verification_uri: uri.to_owned(),
            expires_in: remaining,
            interval,
            deadline: started + ttl,
        })
    }
    pub fn poll_device(
        &self,
        code: &Secret,
        desired_agent: &str,
        expected_tenant: &str,
    ) -> Result<DevicePoll> {
        identifier(desired_agent)?;
        identifier(expected_tenant)?;
        let started = Instant::now();
        let mut value = self.request(
            "/device/token",
            Some(json!({"device_code":code.expose()})),
            None,
            true,
        )?;
        if let Some(error) = value.get("error").and_then(Value::as_str) {
            return match error {
                "authorization_pending" => {
                    Ok(DevicePoll::Pending(seconds(&value, "interval", 300)?))
                }
                "slow_down" => Ok(DevicePoll::SlowDown(seconds(&value, "interval", 300)?)),
                "access_denied" => Ok(DevicePoll::Denied),
                "expired_token" => Ok(DevicePoll::Expired),
                _ => Err(Error::Refused),
            };
        }
        let token = secret_field(&mut value, "access_token")?;
        if string(&value, "token_type")? != "Bearer" {
            return Err(Error::InvalidResponse);
        }
        let expiry = seconds(&value, "expires_in", 604800)?;
        let id = string(&value, "agent_id")?;
        let slug = string(&value, "agent_slug")?;
        if if is_uuid(desired_agent) {
            desired_agent != id
        } else {
            desired_agent != id && desired_agent != slug
        } {
            return Err(Error::IdentityMismatch);
        }
        let snapshot = self.boot(&token, id, expected_tenant)?;
        if snapshot.agent.id != id || snapshot.agent.slug != slug {
            return Err(Error::IdentityMismatch);
        }
        let expires_at = started.checked_add(expiry).ok_or(Error::InvalidResponse)?;
        if Instant::now() >= expires_at {
            return Err(Error::Expired);
        }
        let expires_unix = unix_now()?
            + expires_at
                .saturating_duration_since(Instant::now())
                .as_secs();
        Ok(DevicePoll::Verified(Box::new(VerifiedConnection {
            token,
            origin: self.origin.clone(),
            snapshot,
            expires_at,
            expires_unix,
        })))
    }
    pub fn boot(
        &self,
        token: &Secret,
        desired_agent: &str,
        expected_tenant: &str,
    ) -> Result<BootSnapshot> {
        identifier(desired_agent)?;
        identifier(expected_tenant)?;
        let boot = self.action(
            "/actions/boot_context",
            token,
            json!({"source":"mumachine","seat":"mupot-connect"}),
        )?;
        let bound = string(&boot, "bound_agent_id").map_err(|_| Error::IdentityMismatch)?;
        if boot.get("identity_status").and_then(Value::as_str) != Some("minted")
            || boot.get("tenant").and_then(Value::as_str) != Some(expected_tenant)
            || (is_uuid(desired_agent) && desired_agent != bound)
        {
            return Err(Error::IdentityMismatch);
        }
        let channel = string(&boot, "channel")?.to_owned();
        let mut orient = self.action("/actions/orient", token, json!({}))?;
        let agent: Agent = decode(orient["packet"]["agent"].take())?;
        if agent.id != bound || (desired_agent != agent.id && desired_agent != agent.slug) {
            return Err(Error::IdentityMismatch);
        }
        let squad: Squad = decode(orient["packet"]["squad"].take())?;
        let roster: Vec<RosterMember> = decode(orient["packet"]["squadmates"].take())?;
        if squad.id.is_empty() || squad.name.is_empty() {
            return Err(Error::InvalidResponse);
        }
        Ok(BootSnapshot {
            agent,
            squad,
            tenant: expected_tenant.to_owned(),
            channel,
            brief: string(&orient, "brief")?.to_owned(),
            roster,
            verification: Verification::BoundIdentityVerified,
        })
    }
    pub fn refresh(&self, connection: &VerifiedConnection) -> Result<BootSnapshot> {
        self.validate_connection(connection)?;
        let snapshot = self.boot(
            &connection.token,
            &connection.snapshot.agent.id,
            &connection.snapshot.tenant,
        )?;
        if snapshot.agent.slug != connection.snapshot.agent.slug {
            return Err(Error::IdentityMismatch);
        }
        Ok(snapshot)
    }
    pub fn restore(&self, profile: &Profile, token: Secret) -> Result<VerifiedConnection> {
        if self.origin.as_str() != profile.origin {
            return Err(Error::IdentityMismatch);
        }
        let remaining = profile
            .expires_unix
            .checked_sub(unix_now()?)
            .filter(|n| *n > 0 && *n <= 604800)
            .ok_or(Error::Expired)?;
        let expires_at = Instant::now() + Duration::from_secs(remaining);
        let snapshot = self.boot(&token, &profile.agent_id, &profile.tenant)?;
        if snapshot.agent.slug != profile.agent_slug || Instant::now() >= expires_at {
            return Err(Error::IdentityMismatch);
        }
        Ok(VerifiedConnection {
            token,
            origin: self.origin.clone(),
            snapshot,
            expires_at,
            expires_unix: profile.expires_unix,
        })
    }
    fn validate_connection(&self, connection: &VerifiedConnection) -> Result<()> {
        if self.origin != connection.origin {
            return Err(Error::IdentityMismatch);
        }
        if connection.is_expired() {
            return Err(Error::Expired);
        }
        Ok(())
    }
    pub fn check_in(&self, connection: &VerifiedConnection) -> Result<CheckInReceipt> {
        self.refresh(connection)?;
        self.validate_connection(connection)?;
        let receipt = self.action(
            "/actions/check_in",
            &connection.token,
            json!({"source":"mumachine","seat":"mupot-connect","harness":"unknown"}),
        )?;
        if receipt.get("ok").and_then(Value::as_bool) != Some(true)
            || receipt.get("agent_id").and_then(Value::as_str)
                != Some(&connection.snapshot.agent.id)
        {
            return Err(Error::IdentityMismatch);
        }
        Ok(CheckInReceipt {
            agent_id: connection.snapshot.agent.id.clone(),
            seat: string(&receipt, "seat")?.to_owned(),
        })
    }
}
fn decode<T: DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|_| Error::InvalidResponse)
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or(Error::InvalidResponse)
}
fn secret_field(value: &mut Value, key: &str) -> Result<Secret> {
    match value[key].take() {
        Value::String(s)
            if !s.is_empty() && s.len() <= 8192 && !s.chars().any(char::is_control) =>
        {
            Ok(Secret::new(s))
        }
        _ => Err(Error::InvalidResponse),
    }
}
fn seconds(value: &Value, key: &str, max: u64) -> Result<Duration> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .filter(|n| *n > 0 && *n <= max)
        .map(Duration::from_secs)
        .ok_or(Error::InvalidResponse)
}
pub(crate) fn identifier(s: &str) -> Result<()> {
    if s.is_empty()
        || s.len() > 128
        || !s
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        Err(Error::InvalidInput)
    } else {
        Ok(())
    }
}
fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.chars().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}
pub(crate) fn unix_now() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| Error::Expired)?
        .as_secs())
}
