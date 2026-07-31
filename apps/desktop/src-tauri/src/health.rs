use std::{
    io::Write,
    net::{SocketAddr, TcpStream},
    time::Instant,
};

use crate::constants::{HEALTH_RESPONSE_TIMEOUT, MAX_HEALTH_RESPONSE, STUDIO_SERVER_PROTOCOL_VERSION};
use crate::http::{
    http_status_is_ok, read_bounded_response, remaining_timeout, response_deadline,
    set_write_timeout_until, BoundedReadError,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HealthCompatibility {
    Compatible,
    Incompatible,
    Malformed,
}

pub(crate) fn health_body_is_compatible(body: &str) -> bool {
    classify_health_body(body) == HealthCompatibility::Compatible
}

pub(crate) fn classify_health_body(body: &str) -> HealthCompatibility {
    let value: serde_json::Value = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(_) => return HealthCompatibility::Malformed,
    };
    if value.get("ok").and_then(|ok| ok.as_bool()) != Some(true) {
        return HealthCompatibility::Malformed;
    }
    let runtime_is_valid = matches!(
        value.get("runtime").and_then(|runtime| runtime.as_str()),
        Some(
            "unconfigured"
                | "starting"
                | "ready"
                | "stopping"
                | "stopped"
                | "unreachable"
                | "incompatible"
                | "error"
        )
    );
    if !runtime_is_valid {
        return HealthCompatibility::Malformed;
    }
    let version = match value.get("protocolVersion") {
        Some(version) => version,
        None => return HealthCompatibility::Malformed,
    };
    match version.as_i64() {
        Some(v) if v == STUDIO_SERVER_PROTOCOL_VERSION => HealthCompatibility::Compatible,
        Some(_) => HealthCompatibility::Incompatible,
        None => HealthCompatibility::Malformed,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProbeOutcome {
    Compatible,
    Incompatible,
    Malformed,
    Timeout,
    OtherService,
}

pub(crate) fn probe_existing_health(address: SocketAddr) -> ProbeOutcome {
    let deadline = Instant::now() + HEALTH_RESPONSE_TIMEOUT;
    let mut stream = match TcpStream::connect_timeout(&address, std::time::Duration::from_millis(200)) {
        Ok(stream) => stream,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            ) =>
        {
            return ProbeOutcome::Timeout;
        }
        Err(_) => return ProbeOutcome::OtherService,
    };
    if set_write_timeout_until(&stream, deadline).is_err() {
        return ProbeOutcome::Timeout;
    }
    let host = format!("{address}");
    let request =
        format!("GET /api/v1/health HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
    if let Err(error) = stream.write_all(request.as_bytes()) {
        return if matches!(
            error.kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
        ) {
            ProbeOutcome::Timeout
        } else {
            ProbeOutcome::OtherService
        };
    }
    let response =
        match read_bounded_response(&mut stream, MAX_HEALTH_RESPONSE as usize, deadline, false) {
            Ok(response) => response,
            Err(BoundedReadError::Timeout) => return ProbeOutcome::Timeout,
            Err(BoundedReadError::LimitExceeded | BoundedReadError::Io) => {
                return ProbeOutcome::Malformed;
            }
        };
    let text = match String::from_utf8(response) {
        Ok(value) => value,
        Err(_) => return ProbeOutcome::Malformed,
    };
    let Some((headers, body)) = text.split_once("\r\n\r\n") else {
        return ProbeOutcome::Malformed;
    };
    if !http_status_is_ok(headers) {
        return ProbeOutcome::OtherService;
    }
    match classify_health_body(body) {
        HealthCompatibility::Compatible => ProbeOutcome::Compatible,
        HealthCompatibility::Incompatible => ProbeOutcome::Incompatible,
        HealthCompatibility::Malformed => ProbeOutcome::Malformed,
    }
}

pub(crate) fn health_check(address: SocketAddr, startup_deadline: Instant) -> bool {
    let deadline = response_deadline(startup_deadline);
    let Some(connect_timeout) = remaining_timeout(deadline, std::time::Duration::from_millis(200)) else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&address, connect_timeout) else {
        return false;
    };
    if set_write_timeout_until(&stream, deadline).is_err() {
        return false;
    }
    if stream
        .write_all(
            b"GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1:4317\r\nConnection: close\r\n\r\n",
        )
        .is_err()
    {
        return false;
    }
    let Ok(response) = read_bounded_response(
        &mut stream,
        MAX_HEALTH_RESPONSE as usize,
        deadline,
        false,
    ) else {
        return false;
    };
    let text = match String::from_utf8(response) {
        Ok(value) => value,
        Err(_) => return false,
    };
    let Some((headers, body)) = text.split_once("\r\n\r\n") else {
        return false;
    };
    http_status_is_ok(headers) && health_body_is_compatible(body)
}
