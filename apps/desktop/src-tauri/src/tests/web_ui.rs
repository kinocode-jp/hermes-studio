use crate::web_ui::{body_is_studio_web_ui, content_type_is_html};

#[test]
fn web_ui_contract_matches_the_bundled_index_and_requires_html_content_type() {
    assert!(body_is_studio_web_ui(include_str!(
        "../../resources/web/index.html"
    )));
    assert!(content_type_is_html(
        "HTTP/1.1 200 OK\r\ncOnTeNt-TyPe: Text/HTML; charset=utf-8"
    ));
    assert!(!content_type_is_html(
        "HTTP/1.1 200 OK\r\nX-Content-Type-Options: text/html"
    ));
    assert!(!content_type_is_html(
        "HTTP/1.1 200 OK\r\nContent-Type: application/xhtml+xml"
    ));
}
