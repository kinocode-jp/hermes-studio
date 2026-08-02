use std::{
    io::Read,
    net::TcpStream,
    time::{Duration, Instant},
};

use crate::constants::{HEALTH_RESPONSE_TIMEOUT, HTTP_READ_SLICE};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BoundedReadError {
    Timeout,
    LimitExceeded,
    Io,
}

pub(crate) fn response_deadline(outer_deadline: Instant) -> Instant {
    std::cmp::min(outer_deadline, Instant::now() + HEALTH_RESPONSE_TIMEOUT)
}

pub(crate) fn remaining_timeout(deadline: Instant, maximum: Duration) -> Option<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .map(|remaining| std::cmp::min(remaining, maximum))
}

pub(crate) fn set_write_timeout_until(stream: &TcpStream, deadline: Instant) -> std::io::Result<()> {
    let timeout = remaining_timeout(deadline, HTTP_READ_SLICE)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::TimedOut, "HTTP deadline elapsed"))?;
    stream.set_write_timeout(Some(timeout))
}

pub(crate) fn read_bounded_response(
    stream: &mut TcpStream,
    maximum: usize,
    deadline: Instant,
    stop_after_headers: bool,
) -> Result<Vec<u8>, BoundedReadError> {
    let mut response = Vec::new();
    let mut buffer = [0_u8; 512];
    loop {
        let Some(timeout) = remaining_timeout(deadline, HTTP_READ_SLICE) else {
            return Err(BoundedReadError::Timeout);
        };
        stream
            .set_read_timeout(Some(timeout))
            .map_err(|_| BoundedReadError::Io)?;
        let capped_length = maximum
            .saturating_add(1)
            .saturating_sub(response.len())
            .min(buffer.len());
        match stream.read(&mut buffer[..capped_length]) {
            Ok(0) => {
                return if Instant::now() < deadline {
                    Ok(response)
                } else {
                    Err(BoundedReadError::Timeout)
                };
            }
            Ok(size) => {
                response.extend_from_slice(&buffer[..size]);
                if response.len() > maximum {
                    return Err(BoundedReadError::LimitExceeded);
                }
                if Instant::now() >= deadline {
                    return Err(BoundedReadError::Timeout);
                }
                if stop_after_headers
                    && response.windows(4).any(|window| window == b"\r\n\r\n")
                {
                    return Ok(response);
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                if Instant::now() >= deadline {
                    return Err(BoundedReadError::Timeout);
                }
            }
            Err(_) => return Err(BoundedReadError::Io),
        }
    }
}

pub(crate) fn http_status_is_ok(headers: &str) -> bool {
    let mut tokens = headers.split_whitespace();
    let Some(version) = tokens.next() else {
        return false;
    };
    if version != "HTTP/1.1" && version != "HTTP/1.0" {
        return false;
    }
    let Some(status) = tokens.next() else {
        return false;
    };
    status == "200"
}
