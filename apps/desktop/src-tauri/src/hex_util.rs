use std::fmt::Write as _;

pub(crate) fn generate_desktop_capability() -> String {
    random_desktop_capability()
}

pub(crate) fn random_desktop_capability() -> String {
    random_hex::<32>()
}

pub(crate) fn random_hex<const N: usize>() -> String {
    let mut bytes = [0_u8; N];
    getrandom::fill(&mut bytes).expect("operating system random source is unavailable");
    encode_lower_hex(&bytes)
}

pub(crate) fn encode_lower_hex(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    encoded
}

pub(crate) fn decode_lower_hex_32(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
        return None;
    }
    let mut decoded = [0_u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        decoded[index] = (hex_nibble(pair[0])? << 4) | hex_nibble(pair[1])?;
    }
    Some(decoded)
}

pub(crate) fn hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        _ => None,
    }
}
