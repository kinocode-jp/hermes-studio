use std::{
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpListener},
    thread,
    time::{Duration, Instant},
};

use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::capability::{monitor_outcome_requires_invalidation, OwnedCapabilityOutcome};
use crate::constants::DESKTOP_PROOF_NONCE_BYTES;
use crate::hex_util::{decode_lower_hex_32, encode_lower_hex};
use crate::proof::{
    desktop_proof_message, desktop_readiness_proof_check, desktop_readiness_proof_outcome,
    validate_desktop_proof_response, DesktopProofOutcome,
};

#[test]
fn desktop_readiness_proof_requires_exact_hmac_nonce_and_response_contract() {
    let capability = "desktop-proof-test-capability";
    let nonce = "ab".repeat(DESKTOP_PROOF_NONCE_BYTES);
    let mut mac = Hmac::<Sha256>::new_from_slice(capability.as_bytes()).expect("HMAC key");
    mac.update(desktop_proof_message(&nonce).as_bytes());
    let proof = mac.finalize().into_bytes();
    let proof_hex = encode_lower_hex(&proof);
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\n\r\n{{\"proof\":\"{proof_hex}\"}}"
    );

    assert!(validate_desktop_proof_response(&response, capability, &nonce));
    assert!(!validate_desktop_proof_response(&response, "wrong-capability", &nonce));
    assert!(!validate_desktop_proof_response(&response, capability, &"cd".repeat(32)));
    assert!(!validate_desktop_proof_response(
        &response.replace("Cache-Control: no-store\r\n", ""),
        capability,
        &nonce,
    ));
    assert!(!validate_desktop_proof_response(
        &response.replace("application/json; charset=utf-8", "text/plain"),
        capability,
        &nonce,
    ));
    assert!(!validate_desktop_proof_response(
        &response.replace("200 OK", "201 Created"),
        capability,
        &nonce,
    ));
    assert!(decode_lower_hex_32(&proof_hex).is_some());
    assert!(decode_lower_hex_32(&proof_hex.to_ascii_uppercase()).is_none());
    assert!(decode_lower_hex_32("00").is_none());
}

#[test]
fn readiness_challenge_never_transmits_capability_and_rejects_forged_listener_proof() {
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .expect("bind malicious temporary listener");
    let address = listener.local_addr().expect("temporary listener address");
    let capability = "capability-must-never-cross-the-readiness-socket".to_owned();
    let secret_for_assertion = capability.clone();
    let (sender, receiver) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept readiness challenge");
        let mut request = [0_u8; 2048];
        let read = stream.read(&mut request).expect("read readiness challenge");
        sender.send(request[..read].to_vec()).expect("send captured request");
        let forged = "0".repeat(64);
        let body = format!("{{\"proof\":\"{forged}\"}}");
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len(),
        );
        stream.write_all(response.as_bytes()).expect("write forged proof");
    });

    assert_eq!(
        desktop_readiness_proof_outcome(
            address,
            &capability,
            Instant::now() + Duration::from_secs(2),
        ),
        DesktopProofOutcome::Invalid,
    );
    let captured = receiver.recv_timeout(Duration::from_secs(1)).expect("captured request");
    let request = String::from_utf8(captured).expect("ASCII request");
    assert!(!request.contains(&secret_for_assertion));
    assert!(request.starts_with("GET /api/v1/health/desktop-proof?nonce="));
    assert!(request.contains("&domain=hermes-office-desktop-readiness&version=1 HTTP/1.1\r\n"));
    let nonce = request.split("nonce=").nth(1).and_then(|value| value.split('&').next()).expect("nonce");
    assert_eq!(nonce.len(), DESKTOP_PROOF_NONCE_BYTES * 2);
    assert!(nonce.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
}

#[test]
fn readiness_timeout_is_transient_but_monitor_grace_is_strictly_bounded() {
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .expect("bind stalling readiness listener");
    let address = listener.local_addr().expect("temporary listener address");
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept readiness challenge");
        let mut request = [0_u8; 2048];
        let _ = stream.read(&mut request);
        thread::sleep(Duration::from_millis(900));
    });
    assert_eq!(
        desktop_readiness_proof_outcome(
            address,
            "owned-listener-capability",
            Instant::now() + Duration::from_secs(2),
        ),
        DesktopProofOutcome::TransientUnavailable,
    );
    server.join().expect("stalling listener exits");

    let mut failures = 0;
    assert!(!monitor_outcome_requires_invalidation(
        &OwnedCapabilityOutcome::TransientUnavailable,
        &mut failures,
    ));
    assert!(!monitor_outcome_requires_invalidation(
        &OwnedCapabilityOutcome::TransientUnavailable,
        &mut failures,
    ));
    assert!(monitor_outcome_requires_invalidation(
        &OwnedCapabilityOutcome::TransientUnavailable,
        &mut failures,
    ));
    assert!(!monitor_outcome_requires_invalidation(
        &OwnedCapabilityOutcome::Valid("capability".to_owned()),
        &mut failures,
    ));
    assert_eq!(failures, 0);
    assert!(monitor_outcome_requires_invalidation(
        &OwnedCapabilityOutcome::Invalid,
        &mut failures,
    ));
}

#[test]
fn fresh_readiness_proof_rejects_an_exited_or_rebound_listener() {
    let capability = "owned-listener-capability".to_owned();
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .expect("bind owned temporary listener");
    let address = listener.local_addr().expect("temporary listener address");
    let owned_capability = capability.clone();
    let owned = thread::spawn(move || {
        serve_readiness_proof(listener, &owned_capability);
    });
    assert!(desktop_readiness_proof_check(
        address,
        &capability,
        Instant::now() + Duration::from_secs(2),
    ));
    owned.join().expect("owned listener exits");
    assert_eq!(
        desktop_readiness_proof_outcome(
            address,
            &capability,
            Instant::now() + Duration::from_millis(200),
        ),
        DesktopProofOutcome::TransientUnavailable,
    );

    let replacement = TcpListener::bind(address).expect("rebind replacement listener");
    let attacker = thread::spawn(move || {
        serve_readiness_proof(replacement, "attacker-does-not-have-capability");
    });
    assert_eq!(
        desktop_readiness_proof_outcome(
            address,
            &capability,
            Instant::now() + Duration::from_secs(2),
        ),
        DesktopProofOutcome::Invalid,
    );
    attacker.join().expect("replacement listener exits");
}

fn serve_readiness_proof(listener: TcpListener, capability: &str) {
    let (mut stream, _) = listener.accept().expect("accept readiness challenge");
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .expect("bound readiness request read");
    let mut request = Vec::new();
    while !request.windows(4).any(|window| window == b"\r\n\r\n") {
        let mut buffer = [0_u8; 512];
        let read = stream.read(&mut buffer).expect("read readiness challenge");
        assert!(read > 0 && request.len() + read <= 2048, "bounded readiness request");
        request.extend_from_slice(&buffer[..read]);
    }
    let request = String::from_utf8(request).expect("ASCII request");
    let nonce = request
        .split("nonce=")
        .nth(1)
        .and_then(|value| value.split('&').next())
        .expect("readiness nonce");
    let mut mac = Hmac::<Sha256>::new_from_slice(capability.as_bytes()).expect("HMAC key");
    mac.update(desktop_proof_message(nonce).as_bytes());
    let proof = encode_lower_hex(&mac.finalize().into_bytes());
    let body = format!("{{\"proof\":\"{proof}\"}}");
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len(),
    );
    stream.write_all(response.as_bytes()).expect("write readiness proof");
}
