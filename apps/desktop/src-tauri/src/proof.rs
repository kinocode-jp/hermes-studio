use std::{
    io::Write,
    net::{SocketAddr, TcpStream},
    time::{Duration, Instant},
};

use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::constants::{
    DESKTOP_PROOF_DOMAIN, DESKTOP_PROOF_NONCE_BYTES, DESKTOP_PROOF_VERSION, MAX_HEALTH_RESPONSE,
    OFFICE_HOST, OFFICE_PORT,
};
use crate::hex_util::{decode_lower_hex_32, random_hex};
use crate::http::{
    http_status_is_ok, read_bounded_response, remaining_timeout, response_deadline,
    set_write_timeout_until, BoundedReadError,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DesktopProofOutcome {
    Valid,
    Invalid,
    TransientUnavailable,
}

pub(crate) fn desktop_readiness_proof_check(
    address: SocketAddr,
    desktop_capability: &str,
    startup_deadline: Instant,
) -> bool {
    desktop_readiness_proof_outcome(address, desktop_capability, startup_deadline)
        == DesktopProofOutcome::Valid
}

pub(crate) fn desktop_readiness_proof_outcome(
    address: SocketAddr,
    desktop_capability: &str,
    startup_deadline: Instant,
) -> DesktopProofOutcome {
    let nonce = random_hex::<DESKTOP_PROOF_NONCE_BYTES>();
    let deadline = response_deadline(startup_deadline);
    let Some(connect_timeout) = remaining_timeout(deadline, Duration::from_millis(200)) else {
        return DesktopProofOutcome::TransientUnavailable;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&address, connect_timeout) else {
        return DesktopProofOutcome::TransientUnavailable;
    };
    if set_write_timeout_until(&stream, deadline).is_err() {
        return DesktopProofOutcome::TransientUnavailable;
    }
    let request = format!(
        "GET /api/v1/health/desktop-proof?nonce={nonce}&domain={DESKTOP_PROOF_DOMAIN}&version={DESKTOP_PROOF_VERSION} HTTP/1.1\r\nHost: {OFFICE_HOST}:{OFFICE_PORT}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return DesktopProofOutcome::TransientUnavailable;
    }
    let response = match read_bounded_response(
        &mut stream,
        MAX_HEALTH_RESPONSE as usize,
        deadline,
        false,
    ) {
        Ok(response) => response,
        Err(BoundedReadError::LimitExceeded) => return DesktopProofOutcome::Invalid,
        Err(BoundedReadError::Timeout | BoundedReadError::Io) => {
            return DesktopProofOutcome::TransientUnavailable;
        }
    };
    let text = match String::from_utf8(response) {
        Ok(value) => value,
        Err(_) => return DesktopProofOutcome::Invalid,
    };
    if validate_desktop_proof_response(&text, desktop_capability, &nonce) {
        DesktopProofOutcome::Valid
    } else {
        DesktopProofOutcome::Invalid
    }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct DesktopProofResponse {
    proof: String,
}

pub(crate) fn validate_desktop_proof_response(response: &str, capability: &str, nonce: &str) -> bool {
    let Some((headers, body)) = response.split_once("\r\n\r\n") else {
        return false;
    };
    if !http_status_is_ok(headers) || !proof_headers_are_strict(headers) {
        return false;
    }
    let parsed: DesktopProofResponse = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(_) => return false,
    };
    let Some(proof) = decode_lower_hex_32(&parsed.proof) else {
        return false;
    };
    let mut mac = match Hmac::<Sha256>::new_from_slice(capability.as_bytes()) {
        Ok(value) => value,
        Err(_) => return false,
    };
    mac.update(desktop_proof_message(nonce).as_bytes());
    mac.verify_slice(&proof).is_ok()
}

pub(crate) fn proof_headers_are_strict(headers: &str) -> bool {
    let mut content_type = None;
    let mut cache_control = None;
    for line in headers.split("\r\n").skip(1) {
        let Some((name, value)) = line.split_once(':') else {
            return false;
        };
        if name.eq_ignore_ascii_case("content-type") {
            if content_type.replace(value.trim()).is_some() {
                return false;
            }
        }
        if name.eq_ignore_ascii_case("cache-control") {
            if cache_control.replace(value.trim()).is_some() {
                return false;
            }
        }
    }
    content_type.is_some_and(|value| value.eq_ignore_ascii_case("application/json; charset=utf-8"))
        && cache_control.is_some_and(|value| value.eq_ignore_ascii_case("no-store"))
}

pub(crate) fn desktop_proof_message(nonce: &str) -> String {
    format!("{DESKTOP_PROOF_DOMAIN}\n{DESKTOP_PROOF_VERSION}\n{nonce}")
}
