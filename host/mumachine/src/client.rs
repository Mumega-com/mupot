use crate::*;
use reqwest::{
    blocking::{Body, Client},
    header::{AUTHORIZATION, HeaderValue},
    redirect::Policy,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    io::{Cursor, Read},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;

const BODY_LIMIT: u64 = 1_048_576;
struct HttpResponse {
    status: reqwest::StatusCode,
    bytes: Zeroizing<Vec<u8>>,
}
#[derive(Deserialize)]
struct DeviceCodeResponse<'a> {
    device_code: &'a str,
    user_code: &'a str,
    verification_uri: &'a str,
    expires_in: u64,
    interval: u64,
}
#[derive(Deserialize)]
struct DeviceTokenResponse<'a> {
    access_token: &'a str,
    token_type: &'a str,
    expires_in: u64,
    agent_id: &'a str,
    agent_slug: &'a str,
}
#[derive(Deserialize)]
struct DeviceErrorResponse<'a> {
    error: &'a str,
    interval: Option<u64>,
}
#[derive(Serialize)]
struct DeviceCodeBody<'a> {
    device_code: &'a str,
}
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
        let body = body.map(public_body).transpose()?;
        let response = self.request_wire(path, body, token, device_errors)?;
        serde_json::from_slice(&response.bytes).map_err(|_| Error::InvalidResponse)
    }
    fn request_wire(
        &self,
        path: &str,
        body: Option<Body>,
        token: Option<&Secret>,
        device_errors: bool,
    ) -> Result<HttpResponse> {
        let url = format!("{}{path}", self.origin.as_str());
        let mut request = if let Some(body) = body {
            self.http
                .post(url)
                .header("content-type", "application/json")
                .body(body)
        } else {
            self.http.get(url)
        };
        if let Some(token) = token {
            let mut bearer = Zeroizing::new(String::with_capacity(7 + token.expose().len()));
            bearer.push_str("Bearer ");
            bearer.push_str(token.expose());
            let mut header = HeaderValue::from_str(&bearer).map_err(|_| Error::InvalidInput)?;
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
        // Fixed capacity avoids releasing intermediate allocations containing
        // secret response fragments during Vec growth.
        let mut bytes = Zeroizing::new(vec![0; (BODY_LIMIT + 1) as usize]);
        let mut response = response;
        let mut length = 0;
        loop {
            let count = response
                .read(&mut bytes[length..])
                .map_err(|_| Error::Transport)?;
            if count == 0 {
                break;
            }
            length += count;
            if length as u64 > BODY_LIMIT {
                return Err(Error::ResponseTooLarge);
            }
        }
        bytes.truncate(length);
        Ok(HttpResponse { status, bytes })
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
        agent_uuid(desired_agent)?;
        let started = Instant::now();
        let started_unix = unix_now()?;
        let response = self.request_wire(
            "/device/code",
            Some(public_body(json!({"agent":desired_agent}))?),
            None,
            false,
        )?;
        let value: DeviceCodeResponse<'_> =
            serde_json::from_slice(&response.bytes).map_err(|_| Error::InvalidResponse)?;
        let device_code = borrowed_secret(value.device_code)?;
        let user_code = value.user_code.to_owned();
        if user_code.is_empty() {
            return Err(Error::InvalidResponse);
        }
        if user_code.len() > 32
            || !user_code
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
        {
            return Err(Error::InvalidResponse);
        }
        let uri = value.verification_uri;
        if uri != format!("{}/device", self.origin.as_str()) {
            return Err(Error::InvalidResponse);
        }
        let ttl = bounded_seconds(value.expires_in, 3600)?;
        let interval = bounded_seconds(value.interval, 300)?;
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
            origin: self.origin.clone(),
            desired_agent: desired_agent.to_owned(),
            started,
            started_unix,
        })
    }
    pub fn poll_device(&self, request: &PollRequest, expected_tenant: &str) -> Result<DevicePoll> {
        let code = &request.code;
        let desired_agent = request.desired_agent.as_str();
        agent_uuid(desired_agent)?;
        identifier(expected_tenant)?;
        if self.origin != request.origin {
            return Err(Error::IdentityMismatch);
        }
        if Instant::now() >= request.deadline {
            return Err(Error::Expired);
        }
        let response = self.request_wire("/device/token", Some(device_body(code)?), None, true)?;
        if response.status.as_u16() == 400 {
            let value: DeviceErrorResponse<'_> =
                serde_json::from_slice(&response.bytes).map_err(|_| Error::Refused)?;
            return match value.error {
                "authorization_pending" => Ok(DevicePoll::Pending(bounded_seconds(
                    value.interval.ok_or(Error::InvalidResponse)?,
                    300,
                )?)),
                "slow_down" => Ok(DevicePoll::SlowDown(bounded_seconds(
                    value.interval.ok_or(Error::InvalidResponse)?,
                    300,
                )?)),
                "access_denied" => Ok(DevicePoll::Denied),
                "expired_token" => Ok(DevicePoll::Expired),
                _ => Err(Error::Refused),
            };
        }
        let value: DeviceTokenResponse<'_> =
            serde_json::from_slice(&response.bytes).map_err(|_| Error::InvalidResponse)?;
        let token = borrowed_secret(value.access_token)?;
        if value.token_type != "Bearer" {
            return Err(Error::InvalidResponse);
        }
        let expiry = bounded_seconds(value.expires_in, 604800)?;
        let id = value.agent_id;
        let slug = value.agent_slug;
        if desired_agent != id || identifier(slug).is_err() {
            return Err(Error::IdentityMismatch);
        }
        let snapshot = self.boot(&token, id, expected_tenant)?;
        if snapshot.agent.id != id || snapshot.agent.slug != slug {
            return Err(Error::IdentityMismatch);
        }
        // Server lifetime starts at approval; its token endpoint returns a constant
        // lifetime even after delayed redemption. Challenge start is the earliest
        // possible approval, so this lower bound cannot extend server validity.
        let expires_at = request
            .started
            .checked_add(expiry)
            .ok_or(Error::InvalidResponse)?;
        if Instant::now() >= expires_at || Instant::now() >= request.deadline {
            return Err(Error::Expired);
        }
        let expires_unix = request
            .started_unix
            .checked_add(expiry.as_secs())
            .ok_or(Error::InvalidResponse)?;
        if expires_unix <= unix_now()? {
            return Err(Error::Expired);
        }
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
        agent_uuid(desired_agent)?;
        identifier(expected_tenant)?;
        let boot = self.action(
            "/actions/boot_context",
            token,
            json!({"source":"mumachine","seat":"mupot-connect"}),
        )?;
        let bound = string(&boot, "bound_agent_id").map_err(|_| Error::IdentityMismatch)?;
        if boot.get("identity_status").and_then(Value::as_str) != Some("minted")
            || boot.get("tenant").and_then(Value::as_str) != Some(expected_tenant)
            || desired_agent != bound
        {
            return Err(Error::IdentityMismatch);
        }
        let channel = string(&boot, "channel")?.to_owned();
        let mut orient = self.action("/actions/orient", token, json!({}))?;
        let agent: Agent = decode(orient["packet"]["agent"].take())?;
        if agent.id != bound || desired_agent != agent.id {
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
            || receipt.get("seat").and_then(Value::as_str) != Some("mupot-connect")
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
fn borrowed_secret(value: &str) -> Result<Secret> {
    if value.is_empty() || value.len() > 8192 || value.chars().any(char::is_control) {
        return Err(Error::InvalidResponse);
    }
    Ok(Secret::new(value))
}
fn bounded_seconds(value: u64, max: u64) -> Result<Duration> {
    if value == 0 || value > max {
        return Err(Error::InvalidResponse);
    }
    Ok(Duration::from_secs(value))
}
fn public_body(value: Value) -> Result<Body> {
    Ok(Body::from(
        serde_json::to_vec(&value).map_err(|_| Error::InvalidInput)?,
    ))
}
fn device_body(secret: &Secret) -> Result<Body> {
    // Borrow the secret into the serializer and retain the only app-owned JSON
    // staging allocation in a zeroizing reader. reqwest/TLS buffers are outside
    // our ownership; sensitive headers suppress formatting, not memory copies.
    // JSON escaping needs at most six bytes per input byte. Reserving once
    // prevents plaintext fragments surviving an intermediate reallocation.
    let mut bytes = Zeroizing::new(Vec::with_capacity(secret.expose().len() * 6 + 32));
    serde_json::to_writer(
        &mut *bytes,
        &DeviceCodeBody {
            device_code: secret.expose(),
        },
    )
    .map_err(|_| Error::InvalidInput)?;
    let len = bytes.len() as u64;
    Ok(Body::sized(Cursor::new(bytes), len))
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
pub(crate) fn agent_uuid(s: &str) -> Result<()> {
    let valid = s.len() == 36
        && s.chars().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == '-'
            } else {
                c.is_ascii_digit() || ('a'..='f').contains(&c)
            }
        });
    if valid {
        Ok(())
    } else {
        Err(Error::InvalidInput)
    }
}
pub(crate) fn unix_now() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| Error::Expired)?
        .as_secs())
}
