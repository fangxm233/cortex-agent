// Focused regression cases adapted from the qualified helper; no real SFX fixture.
use super::{output, pin, Cancellation};
use sevenz_rust2::ArchiveEntry;
use std::io::{Cursor, Read};

#[test]
fn destination_must_be_fresh_and_no_overwrite() {
    let root = tempfile::tempdir().unwrap();
    assert!(output::fresh_root(root.path()).is_err());
    let dest = output::fresh_root(&root.path().join("fresh")).unwrap();
    let entry = ArchiveEntry {
        name: "x".into(),
        ..Default::default()
    };
    let cancel = Cancellation::new(|| false);
    output::extract_entry(&dest, &entry, &mut Cursor::new([]), &cancel).unwrap();
    assert!(output::extract_entry(&dest, &entry, &mut Cursor::new([]), &cancel).is_err());
    assert!(output::fresh_root(&root.path().join("../escape")).is_err());
}

#[cfg(unix)]
#[test]
fn symlink_ancestors_and_injected_parent_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(root.path(), root.path().join("link")).unwrap();
    assert!(output::fresh_root(&root.path().join("link/new")).is_err());
    let entry = ArchiveEntry {
        name: "link/escape".into(),
        ..Default::default()
    };
    let cancel = Cancellation::new(|| false);
    assert!(output::extract_entry(root.path(), &entry, &mut Cursor::new([]), &cancel).is_err());
    assert!(!root.path().join("escape").exists());
}

#[test]
fn cancellation_before_read_and_write() {
    let cancel = Cancellation::new(|| true);
    assert!(pin::authenticate(&mut Cursor::new([]), &cancel).is_err());
    let entry = ArchiveEntry::default();
    assert!(output::copy_checked(&entry, &mut Cursor::new([]), &mut Vec::new(), &cancel).is_err());
}

#[test]
fn stream_size_and_crc_fail_closed() {
    let entry = ArchiveEntry {
        size: 3,
        has_crc: true,
        crc: crc32fast::hash(b"abc") as u64,
        ..Default::default()
    };
    let cancel = Cancellation::new(|| false);
    for data in [b"ab".as_slice(), b"abcd", b"abd"] {
        let mut output = Vec::new();
        assert!(
            output::copy_checked(&entry, &mut Cursor::new(data), &mut output, &cancel).is_err()
        );
        assert!(output.len() <= 3);
    }
    let mut output = Vec::new();
    let bytes =
        output::copy_checked(&entry, &mut Cursor::new(b"abc"), &mut output, &cancel).unwrap();
    assert_eq!(bytes, 3);
    assert_eq!(output, b"abc");
}

fn synthetic_sfx() -> Vec<u8> {
    let mut data = vec![0; pin::OFFSET + 33];
    let header = &mut data[pin::OFFSET..pin::OFFSET + 32];
    header[..8].copy_from_slice(b"7z\xbc\xaf\x27\x1c\x00\x04");
    header[20..28].copy_from_slice(&1u64.to_le_bytes());
    header[28..32].copy_from_slice(&crc32fast::hash(&[0]).to_le_bytes());
    let crc = crc32fast::hash(&header[12..]);
    header[8..12].copy_from_slice(&crc.to_le_bytes());
    data
}

#[test]
fn bounded_signature_and_both_header_crcs() {
    let data = synthetic_sfx();
    pin::payload(&data).unwrap();
    for position in [
        pin::OFFSET,
        pin::OFFSET + 8,
        pin::OFFSET + 12,
        pin::OFFSET + 32,
    ] {
        let mut damaged = data.clone();
        damaged[position] ^= 1;
        assert!(pin::payload(&damaged).is_err());
    }
    assert!(pin::payload(&[]).is_err());
}

#[test]
fn next_header_bounds_are_rejected_even_with_valid_start_crc() {
    for (offset, size) in [(u64::MAX, 1u64), (0, 1024 * 1024 + 1), (1, 1)] {
        let mut data = synthetic_sfx();
        let header = &mut data[pin::OFFSET..pin::OFFSET + 32];
        header[12..20].copy_from_slice(&offset.to_le_bytes());
        header[20..28].copy_from_slice(&size.to_le_bytes());
        let crc = crc32fast::hash(&header[12..32]);
        header[8..12].copy_from_slice(&crc.to_le_bytes());
        assert!(pin::payload(&data).is_err());
    }
}

#[test]
fn full_hash_gate_rejects_synthetic_correct_length_extra_and_short_data() {
    let cancel = Cancellation::new(|| false);
    let mut zeros = std::io::repeat(0).take(pin::ARCHIVE_BYTES as u64);
    assert!(pin::authenticate(&mut zeros, &cancel)
        .unwrap_err()
        .to_string()
        .contains("SHA-256"));
    let mut extra = std::io::repeat(0).take(pin::ARCHIVE_BYTES as u64 + 1);
    assert!(pin::authenticate(&mut extra, &cancel)
        .unwrap_err()
        .to_string()
        .contains("exceeds"));
    assert!(pin::authenticate(&mut Cursor::new([]), &cancel).is_err());
}
