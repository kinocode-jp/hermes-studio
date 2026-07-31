use std::{
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpListener},
    thread,
    time::{Duration, Instant},
};

use crate::constants::MAX_WEB_UI_RESPONSE;
use crate::server::classify_studio_server_startup;
use crate::startup::{StudioServerStartup, StartupProbeError};

#[test]
fn classify_free_port_allows_startup() {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, 0));
    let listener = TcpListener::bind(address).expect("bind temporary port");
    let actual = listener.local_addr().expect("local address");
    drop(listener);

    assert_eq!(
        classify_studio_server_startup(actual).expect("free port should classify"),
        StudioServerStartup::PortFree
    );
}

#[test]
fn classify_compatible_existing_server_as_unauthenticated_candidate() {
    let address = bind_studio_server(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true,\"protocolVersion\":1,\"runtime\":\"ready\"}",
        "HTTP/1.1 200 OK\r\ncontent-type: Text/HTML; charset=utf-8\r\n\r\n<!doctype html><html><head><title>Hermes Studio</title></head><body><div id=\"app\"></div></body></html>",
    );
    assert_eq!(
        classify_studio_server_startup(address).expect("compatible candidate should classify"),
        StudioServerStartup::CompatibleCandidate
    );
}

#[test]
fn classify_compatible_health_without_root_web_ui_rejects() {
    let address = bind_studio_server(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true,\"protocolVersion\":1,\"runtime\":\"ready\"}",
        "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\n\r\nnot found",
    );
    let error = classify_studio_server_startup(address)
        .expect_err("a health-only server must not be treated as attachable");
    assert!(error.to_string().contains("not the expected Hermes Studio Web UI shape"));
}

#[test]
fn classify_compatible_health_with_non_html_root_rejects() {
    let address = bind_studio_server(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true,\"protocolVersion\":1,\"runtime\":\"ready\"}",
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"title\":\"Hermes Studio\",\"id\":\"app\"}",
    );
    let error = classify_studio_server_startup(address)
        .expect_err("a non-HTML root must not be treated as attachable");
    assert!(error.to_string().contains("not the expected Hermes Studio Web UI shape"));
}

#[test]
fn classify_compatible_health_with_unrelated_html_rejects() {
    let address = bind_studio_server(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true,\"protocolVersion\":1,\"runtime\":\"ready\"}",
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<!doctype html><html><head><title>Other App</title></head><body><div id=\"app\"></div></body></html>",
    );
    let error = classify_studio_server_startup(address)
        .expect_err("unrelated HTML must not be treated as Hermes Studio");
    assert!(error.to_string().contains("not the expected Hermes Studio Web UI shape"));
}

#[test]
fn classify_compatible_health_with_malformed_root_rejects() {
    let address = bind_studio_server(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true,\"protocolVersion\":1,\"runtime\":\"ready\"}",
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n<!doctype html><title>Hermes Studio</title><div id=\"app\"></div>",
    );
    let error = classify_studio_server_startup(address)
        .expect_err("a malformed root response must not be attachable");
    assert!(error.to_string().contains("not the expected Hermes Studio Web UI shape"));
}

#[test]
fn classify_listener_with_only_protocol_version_rejects() {
    let address = bind_health_server(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"protocolVersion\":1}",
    );
    let error = classify_studio_server_startup(address)
        .expect_err("an incomplete health contract must not be treated as Studio Server");
    assert!(error.to_string().contains("malformed"));
}

#[test]
fn classify_incompatible_existing_server_rejects() {
    let address = bind_health_server(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true,\"protocolVersion\":2,\"runtime\":\"ready\"}",
    );
    let error = classify_studio_server_startup(address).expect_err("incompatible server should error");
    assert!(error.to_string().contains("incompatible protocol version"));
}

#[test]
fn classify_malformed_health_response_rejects() {
    let address =
        bind_health_server("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nnot-json");
    let error = classify_studio_server_startup(address).expect_err("malformed health should error");
    assert!(error.to_string().contains("malformed"));
}

#[test]
fn classify_nonnumeric_protocol_version_rejects_malformed() {
    let address = bind_health_server(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true,\"protocolVersion\":\"1\",\"runtime\":\"ready\"}",
    );
    let error = classify_studio_server_startup(address).expect_err("nonnumeric version should error");
    assert!(error.to_string().contains("malformed"));
}

#[test]
fn classify_other_service_rejects() {
    let address = bind_health_server(
        "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\n\r\nnot found",
    );
    let error = classify_studio_server_startup(address).expect_err("other service should error");
    assert!(error.to_string().contains("not recognized as Hermes Studio"));
}

fn bind_health_server(response: &'static str) -> SocketAddr {
    bind_http_server(vec![response])
}

fn bind_studio_server(health_response: &'static str, root_response: &'static str) -> SocketAddr {
    bind_http_server(vec![health_response, root_response])
}

fn bind_http_server(responses: Vec<&'static str>) -> SocketAddr {
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .expect("bind temporary health server");
    let address = listener.local_addr().expect("local address");
    thread::spawn(move || {
        for response in responses {
            serve_one_response(&listener, response.as_bytes());
        }
    });
    address
}

fn serve_one_response(listener: &TcpListener, response: &[u8]) {
    let (mut stream, _) = listener.accept().expect("accept HTTP connection");
    let mut request = [0_u8; 512];
    let _ = stream.read(&mut request);
    let _ = stream.write_all(response);
    let _ = stream.shutdown(std::net::Shutdown::Both);
}

#[test]
fn classify_compatible_health_with_oversized_root_rejects() {
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .expect("bind temporary Studio Server");
    let address = listener.local_addr().expect("local address");
    thread::spawn(move || {
        let health = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true,\"protocolVersion\":1,\"runtime\":\"ready\"}";
        serve_one_response(&listener, health.as_bytes());
        let oversized = vec![b'x'; MAX_WEB_UI_RESPONSE + 1];
        serve_one_response(&listener, &oversized);
    });
    let error = classify_studio_server_startup(address)
        .expect_err("an oversized root response must not be attachable");
    assert!(error.to_string().contains("not the expected Hermes Studio Web UI shape"));
}

#[test]
fn classify_stalling_health_response_is_timeout() {
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .expect("bind temporary health server");
    let address = listener.local_addr().expect("local address");
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept health connection");
        // Read the request so the client finishes writing, then remain silent
        // long enough for the absolute health-response deadline to fire.
        let mut buffer = [0_u8; 512];
        let _ = stream.read(&mut buffer);
        thread::sleep(Duration::from_millis(800));
    });
    let error = classify_studio_server_startup(address).expect_err("stalling server should error");
    assert_eq!(error, StartupProbeError::Timeout);
}

#[test]
fn classify_slow_drip_health_response_obeys_absolute_deadline() {
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .expect("bind temporary health server");
    let address = listener.local_addr().expect("local address");
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept health connection");
        let mut request = [0_u8; 512];
        let _ = stream.read(&mut request);
        for byte in b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true,\"protocolVersion\":1,\"runtime\":\"ready\"}" {
            if stream.write_all(std::slice::from_ref(byte)).is_err() {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
    });

    let started = Instant::now();
    let error = classify_studio_server_startup(address)
        .expect_err("a slow-drip response must not extend the probe indefinitely");
    let elapsed = started.elapsed();

    assert_eq!(error, StartupProbeError::Timeout);
    assert!(
        elapsed < Duration::from_secs(2),
        "absolute health deadline was exceeded: {elapsed:?}"
    );
}

#[test]
fn classify_stalling_root_response_is_web_ui_timeout() {
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .expect("bind temporary Studio Server");
    let address = listener.local_addr().expect("local address");
    thread::spawn(move || {
        let health = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true,\"protocolVersion\":1,\"runtime\":\"ready\"}";
        serve_one_response(&listener, health.as_bytes());
        let (mut stream, _) = listener.accept().expect("accept root connection");
        let mut request = [0_u8; 512];
        let _ = stream.read(&mut request);
        thread::sleep(Duration::from_millis(800));
    });

    let started = Instant::now();
    let error = classify_studio_server_startup(address)
        .expect_err("a stalling Web UI must not extend the probe indefinitely");
    let elapsed = started.elapsed();

    assert!(error.to_string().contains("Web UI probe timed out"));
    assert!(
        elapsed < Duration::from_secs(2),
        "absolute Web UI deadline was exceeded: {elapsed:?}"
    );
}
