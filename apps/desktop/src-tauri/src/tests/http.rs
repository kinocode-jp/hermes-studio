use crate::http::http_status_is_ok;

#[test]
fn http_status_is_ok_only_for_exact_200() {
    assert!(http_status_is_ok("HTTP/1.1 200 OK"));
    assert!(http_status_is_ok("HTTP/1.0 200"));
    assert!(!http_status_is_ok("HTTP/1.1 2000"));
    assert!(!http_status_is_ok("HTTP/1.1 403 Forbidden"));
    assert!(!http_status_is_ok("malformed"));
}
