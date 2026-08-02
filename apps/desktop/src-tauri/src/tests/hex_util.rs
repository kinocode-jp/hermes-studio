use crate::hex_util::{generate_desktop_capability, random_desktop_capability};

#[test]
fn desktop_capabilities_are_url_safe_and_launch_scoped() {
    let first = random_desktop_capability();
    let second = random_desktop_capability();
    assert_eq!(first.len(), 64);
    assert!(first.chars().all(|value| value.is_ascii_hexdigit()));
    assert_ne!(first, second);
}

#[test]
fn generate_desktop_capability_is_random_in_all_builds() {
    let first = generate_desktop_capability();
    let second = generate_desktop_capability();
    assert_eq!(first.len(), 64);
    assert!(first.chars().all(|value| value.is_ascii_hexdigit()));
    assert_ne!(first, second);
}
