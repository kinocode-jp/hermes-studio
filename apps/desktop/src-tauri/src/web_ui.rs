use std::{
    io::Write,
    net::{SocketAddr, TcpStream},
    time::{Duration, Instant},
};

use crate::constants::{HEALTH_RESPONSE_TIMEOUT, MAX_WEB_UI_RESPONSE};
use crate::http::{
    http_status_is_ok, read_bounded_response, remaining_timeout, set_write_timeout_until,
    BoundedReadError,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WebUiProbeOutcome {
    Compatible,
    Unavailable,
    Timeout,
}

pub(crate) fn probe_existing_web_ui(address: SocketAddr) -> WebUiProbeOutcome {
    let deadline = Instant::now() + HEALTH_RESPONSE_TIMEOUT;
    let Some(connect_timeout) = remaining_timeout(deadline, Duration::from_millis(200)) else {
        return WebUiProbeOutcome::Timeout;
    };
    let mut stream = match TcpStream::connect_timeout(&address, connect_timeout) {
        Ok(stream) => stream,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            ) =>
        {
            return WebUiProbeOutcome::Timeout;
        }
        Err(_) => return WebUiProbeOutcome::Unavailable,
    };
    if set_write_timeout_until(&stream, deadline).is_err() {
        return WebUiProbeOutcome::Timeout;
    }
    let request = format!(
        "GET / HTTP/1.1\r\nHost: {address}\r\nAccept: text/html\r\nConnection: close\r\n\r\n"
    );
    if let Err(error) = stream.write_all(request.as_bytes()) {
        return if matches!(
            error.kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
        ) {
            WebUiProbeOutcome::Timeout
        } else {
            WebUiProbeOutcome::Unavailable
        };
    }
    let response = match read_bounded_response(&mut stream, MAX_WEB_UI_RESPONSE, deadline, false) {
        Ok(response) => response,
        Err(BoundedReadError::Timeout) => return WebUiProbeOutcome::Timeout,
        Err(BoundedReadError::LimitExceeded | BoundedReadError::Io) => {
            return WebUiProbeOutcome::Unavailable;
        }
    };
    let text = match String::from_utf8(response) {
        Ok(value) => value,
        Err(_) => return WebUiProbeOutcome::Unavailable,
    };
    let Some((headers, body)) = text.split_once("\r\n\r\n") else {
        return WebUiProbeOutcome::Unavailable;
    };
    if !http_status_is_ok(headers) || !content_type_is_html(headers) || !body_is_studio_web_ui(body)
    {
        return WebUiProbeOutcome::Unavailable;
    }
    WebUiProbeOutcome::Compatible
}

pub(crate) fn content_type_is_html(headers: &str) -> bool {
    let mut content_type = None;
    for line in headers.lines().skip(1) {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.trim().eq_ignore_ascii_case("content-type") {
            if content_type.is_some() {
                return false;
            }
            content_type = value.split(';').next().map(str::trim);
        }
    }
    content_type.is_some_and(|media_type| media_type.eq_ignore_ascii_case("text/html"))
}

pub(crate) fn body_is_studio_web_ui(body: &str) -> bool {
    let normalized = body.to_ascii_lowercase();
    normalized.contains("<!doctype html>")
        && normalized.contains("<title>hermes studio</title>")
        && normalized.contains("id=\"app\"")
}
