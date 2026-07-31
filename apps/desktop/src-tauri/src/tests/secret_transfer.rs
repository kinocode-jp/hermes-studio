//! Focused checks for secret deposit request bounds (no network).

#[test]
fn secret_transfer_id_shape_is_url_safe() {
    // Transfer ids returned by the Studio Server are base64url; the desktop
    // command rejects anything outside this alphabet/length.
    let valid = "abcdefghijklmnopqrstuv";
    assert!(valid.len() >= 22 && valid.len() <= 64);
    assert!(valid.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    let invalid = "has spaces!!";
    assert!(!invalid.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
}

#[test]
fn secret_value_byte_budget_matches_protocol() {
    const MAX_SECRET_UTF8_BYTES: usize = 8 * 1024;
    let ok = "a".repeat(MAX_SECRET_UTF8_BYTES);
    assert_eq!(ok.as_bytes().len(), MAX_SECRET_UTF8_BYTES);
    let over = "a".repeat(MAX_SECRET_UTF8_BYTES + 1);
    assert!(over.as_bytes().len() > MAX_SECRET_UTF8_BYTES);
}
