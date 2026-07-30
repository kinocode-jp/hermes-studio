//! Desktop-native one-shot secret deposit.
//!
//! The packaged WebView never places secret bytes on ordinary browser fetch
//! JSON. Instead it invokes this command; Rust POSTs the value to the owned
//! loopback Office Server with the desktop capability header. The response
//! carries only a short-lived transfer id.

use std::{
    io::Write,
    net::{Ipv4Addr, SocketAddr, TcpStream},
    time::{Duration, Instant},
};

use crate::capability::{
    authenticated_owned_capability, close_owned_desktop_window, OwnedCapabilityOutcome,
};
use crate::constants::{OFFICE_HOST, OFFICE_PORT};
use crate::http::{
    http_status_is_ok, read_bounded_response, remaining_timeout, response_deadline,
    set_write_timeout_until, BoundedReadError,
};

const MAX_SECRET_UTF8_BYTES: usize = 8 * 1024;
const MAX_DEPOSIT_RESPONSE: usize = 4_096;
const DEPOSIT_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct DepositResponse {
    #[serde(rename = "transferId")]
    transfer_id: String,
    #[serde(rename = "expiresAt")]
    #[allow(dead_code)]
    expires_at: String,
}

/// Deposit a secret into the Office Server transfer store via native loopback HTTP.
/// Returns the one-shot transfer id (never echoes the secret).
#[tauri::command]
pub(crate) async fn deposit_secret_transfer(
    app: tauri::AppHandle,
    value: String,
) -> Result<String, String> {
    if value.contains('\0') {
        return Err("Secret value is invalid.".into());
    }
    if value.as_bytes().len() > MAX_SECRET_UTF8_BYTES {
        return Err("Secret value is too large.".into());
    }
    // Capture length for capacity checks; avoid retaining the secret in the
    // async task beyond the blocking deposit.
    let worker_app = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        deposit_secret_blocking(&worker_app, value)
    })
    .await
    .map_err(|_| "Secret transfer was interrupted.".to_string())?;
    outcome
}

fn deposit_secret_blocking(app: &tauri::AppHandle, value: String) -> Result<String, String> {
    let capability = match authenticated_owned_capability(app) {
        OwnedCapabilityOutcome::Valid(capability) => capability,
        OwnedCapabilityOutcome::Invalid => {
            close_owned_desktop_window(app);
            return Err("Hermes Studio desktop session is no longer valid.".into());
        }
        OwnedCapabilityOutcome::NotOwned | OwnedCapabilityOutcome::TransientUnavailable => {
            return Err("Secret transfer requires an owned local desktop session.".into());
        }
    };

    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, OFFICE_PORT));
    let deadline = Instant::now() + DEPOSIT_TIMEOUT;
    let body = match serde_json::to_vec(&serde_json::json!({ "value": value })) {
        Ok(bytes) => bytes,
        Err(_) => return Err("Secret transfer payload is invalid.".into()),
    };
    // Drop the plaintext string as soon as the JSON body is built.
    drop(value);

    let Some(connect_timeout) = remaining_timeout(deadline, Duration::from_millis(500)) else {
        return Err("Secret transfer timed out.".into());
    };
    let mut stream = TcpStream::connect_timeout(&address, connect_timeout)
        .map_err(|_| "Secret transfer could not reach the Office Server.".to_string())?;
    if set_write_timeout_until(&stream, deadline).is_err() {
        return Err("Secret transfer timed out.".into());
    }

    let request = format!(
        "POST /api/v1/secret-transfers HTTP/1.1\r\n\
         Host: {OFFICE_HOST}:{OFFICE_PORT}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         X-Hermes-Office-Desktop-Capability: {capability}\r\n\
         Connection: close\r\n\
         Origin: tauri://localhost\r\n\
         \r\n",
        body.len()
    );
    if stream.write_all(request.as_bytes()).is_err() || stream.write_all(&body).is_err() {
        return Err("Secret transfer failed to send.".into());
    }

    let response = match read_bounded_response(
        &mut stream,
        MAX_DEPOSIT_RESPONSE,
        response_deadline(deadline),
        false,
    ) {
        Ok(bytes) => bytes,
        Err(BoundedReadError::LimitExceeded) => {
            return Err("Secret transfer response was too large.".into());
        }
        Err(BoundedReadError::Timeout | BoundedReadError::Io) => {
            return Err("Secret transfer timed out.".into());
        }
    };
    let text = String::from_utf8(response).map_err(|_| "Secret transfer response was invalid.".to_string())?;
    let Some((headers, body_text)) = text.split_once("\r\n\r\n") else {
        return Err("Secret transfer response was invalid.".into());
    };
    if !http_status_is_ok(headers) {
        // Never include response body (may contain error detail).
        return Err("Secret transfer was rejected by the Office Server.".into());
    }
    let parsed: DepositResponse = serde_json::from_str(body_text.trim())
        .map_err(|_| "Secret transfer response was invalid.".to_string())?;
    if parsed.transfer_id.len() < 22
        || parsed.transfer_id.len() > 64
        || !parsed
            .transfer_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Secret transfer id is invalid.".into());
    }
    Ok(parsed.transfer_id)
}
