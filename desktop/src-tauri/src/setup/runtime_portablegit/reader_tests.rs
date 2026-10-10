use super::{extract, guard, output, pin, validate, Cancellation, ExtractionError, Summary};
use sevenz_rust2::{ArchiveReader, Password};
use std::io::Cursor;

// One empty file, plain 7z header, no encoder or copied binary fixture needed.
fn with_name(name: &str) -> Vec<u8> {
    let name_bytes: Vec<_> = name
        .encode_utf16()
        .chain([0])
        .flat_map(u16::to_le_bytes)
        .collect();
    // Header, FilesInfo, count, EmptyStream, EmptyFile, Name property.
    let mut next = vec![1, 5, 1, 14, 1, 128, 15, 1, 128, 17];
    next.extend([(name_bytes.len() + 1) as u8, 0]);
    next.extend(name_bytes);
    next.extend([0, 0]);
    let mut data = vec![0; 32];
    data[..8].copy_from_slice(b"7z\xbc\xaf\x27\x1c\x00\x04");
    data[20..28].copy_from_slice(&(next.len() as u64).to_le_bytes());
    data[28..32].copy_from_slice(&crc32fast::hash(&next).to_le_bytes());
    let crc = crc32fast::hash(&data[12..32]);
    data[8..12].copy_from_slice(&crc.to_le_bytes());
    data.extend(next);
    data
}

#[test]
fn decoder_preserves_unsafe_names_and_our_guard_rejects_them() {
    for name in ["../bad.tx", "..\\bad.tx", "c:ads.txt", "CON.x.txt"] {
        let reader = ArchiveReader::new(Cursor::new(with_name(name)), Password::empty()).unwrap();
        assert_eq!(
            reader.archive().files[0].name,
            name,
            "library silently sanitized name"
        );
        assert!(guard::entries(&reader.archive().files).is_err());
    }
}

fn empty_summary(destination: std::path::PathBuf) -> Summary {
    Summary {
        archive_sha256: pin::SHA256,
        embedded_offset: pin::OFFSET,
        destination,
        file_count: 1,
        directory_count: 0,
        bytes: 0,
    }
}

#[test]
fn extraction_boundary_retains_notice_and_requires_complete_counts() {
    let root = tempfile::tempdir().unwrap();
    let dest = output::fresh_root(&root.path().join("fresh")).unwrap();
    let mut reader =
        ArchiveReader::new(Cursor::new(with_name("LICENSE.txt")), Password::empty()).unwrap();
    // This tiny fixture must NEVER qualify through the six-solid-block production gate.
    assert!(validate(reader.archive()).is_err());
    let summary = empty_summary(dest.clone());
    extract(&mut reader, &summary, &Cancellation::new(|| false)).unwrap();
    assert_eq!(std::fs::read(dest.join("LICENSE.txt")).unwrap(), b"");
    assert_eq!(summary.archive_sha256, pin::SHA256);
    assert_eq!(summary.embedded_offset, 251_392);
    assert_eq!(summary.directory_count, 0);
    let mut reader =
        ArchiveReader::new(Cursor::new(with_name("README.portable")), Password::empty()).unwrap();
    let incomplete = Summary {
        file_count: 2,
        ..summary
    };
    assert!(extract(&mut reader, &incomplete, &Cancellation::new(|| false)).is_err());
}

#[test]
fn cancellation_survives_decoder_error_wrapping_and_leaves_owned_partial_stage() {
    let root = tempfile::tempdir().unwrap();
    let dest = output::fresh_root(&root.path().join("fresh")).unwrap();
    let mut reader =
        ArchiveReader::new(Cursor::new(with_name("LICENSE.txt")), Password::empty()).unwrap();
    let cancel = Cancellation::new(|| true);
    let error = extract(&mut reader, &empty_summary(dest.clone()), &cancel).unwrap_err();
    assert!(matches!(cancel.classify(error), ExtractionError::Cancelled));
    assert!(dest.is_dir());
    assert!(!dest.join("LICENSE.txt").exists());
}
