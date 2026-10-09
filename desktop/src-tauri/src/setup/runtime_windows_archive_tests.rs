use super::*;
use std::io::{Cursor, Write};

fn fixture(names: &[&str]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for name in names {
        writer
            .start_file(
                *name,
                zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored),
            )
            .unwrap();
        writer.write_all(b"payload").unwrap();
    }
    writer.finish().unwrap().into_inner()
}

#[test]
fn zip_fresh_root_and_crc() {
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("fresh");
    let mut bytes = fixture(&["node/node.exe", "node/LICENSE"]);
    extract_zip(&bytes, &dest, "node", &CancelToken::default()).unwrap();
    assert_eq!(std::fs::read(dest.join("node.exe")).unwrap(), b"payload");
    assert!(extract_zip(&bytes, &dest, "node", &CancelToken::default()).is_err());
    let pos = bytes.windows(7).position(|b| b == b"payload").unwrap();
    bytes[pos] ^= 1;
    assert!(extract_zip(&bytes, &dir.path().join("crc"), "node", &CancelToken::default()).is_err());
}

#[test]
fn zip_rejects_unsafe_paths_and_aliases() {
    for name in [
        "node/../escape",
        "node/a:stream",
        "node/CON.txt",
        "node/a.",
        "node/a\\b",
        "other/file",
        "/node/file",
        "node//file",
    ] {
        let dir = tempfile::tempdir().unwrap();
        assert!(
            extract_zip(
                &fixture(&[name]),
                &dir.path().join("stage"),
                "node",
                &CancelToken::default()
            )
            .is_err(),
            "{name}"
        );
    }
    let dir = tempfile::tempdir().unwrap();
    assert!(extract_zip(
        &fixture(&["node/A", "node/a"]),
        &dir.path().join("stage"),
        "node",
        &CancelToken::default()
    )
    .is_err());
}

#[test]
fn zip_rejects_reparse_and_links_and_size() {
    for attrs in [0x400u32, 0xa1ff0000] {
        let mut bytes = fixture(&["node/link"]);
        let pos = bytes.windows(4).position(|b| b == b"PK\x01\x02").unwrap();
        bytes[pos + 38..pos + 42].copy_from_slice(&attrs.to_le_bytes());
        let dir = tempfile::tempdir().unwrap();
        assert!(extract_zip(&bytes, &dir.path().join("stage"), "node", &CancelToken::default()).is_err());
    }
    let mut bytes = fixture(&["node/huge"]);
    let pos = bytes.windows(4).position(|b| b == b"PK\x01\x02").unwrap();
    bytes[pos + 24..pos + 28].copy_from_slice(&u32::MAX.to_le_bytes());
    let dir = tempfile::tempdir().unwrap();
    assert!(extract_zip(&bytes, &dir.path().join("stage"), "node", &CancelToken::default()).is_err());
}

#[test]
fn zip_cancel_before_writes_and_entry_count_limit() {
    let _lock = crate::CANCEL_TEST.lock().unwrap();
    let guard = super::super::InstallGuard::begin().unwrap();
    super::super::cancel_install();
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("stage");
    assert_eq!(
        extract_zip(&fixture(&["node/a"]), &dest, "node", guard.token()),
        Err("SETUP_CANCELLED".into())
    );
    assert!(!dest.exists());
    assert_eq!(
        read_zip(Cursor::new(vec![0; 100]), guard.token()),
        Err("SETUP_CANCELLED".into())
    );
    drop(guard);
    let names: Vec<_> = (0..=MAX_ENTRIES).map(|i| format!("node/{i}")).collect();
    let refs: Vec<_> = names.iter().map(String::as_str).collect();
    assert!(extract_zip(&fixture(&refs), &dest, "node", &CancelToken::default()).is_err());
    assert!(!dest.exists());
}

#[cfg(unix)]
#[test]
fn zip_rejects_symlink_parent() {
    let dir = tempfile::tempdir().unwrap();
    let link = dir.path().join("link");
    std::os::unix::fs::symlink(dir.path(), &link).unwrap();
    assert!(extract_zip(
        &fixture(&["node/a"]),
        &link.join("stage"),
        "node",
        &CancelToken::default()
    )
    .is_err());
    assert!(!dir.path().join("stage").exists());
}

#[test]
fn git_redirects_are_exact_bounded_https_only() {
    let asset = reqwest::Url::parse(GIT_URL).unwrap();
    for url in [
        "https://release-assets.githubusercontent.com/a?sig=b",
        "https://objects.githubusercontent.com/a",
    ] {
        assert!(git_redirect_allowed(
            &asset,
            &reqwest::Url::parse(url).unwrap(),
            1
        ));
    }
    for url in [
        "http://release-assets.githubusercontent.com/a",
        "https://evil.test/a",
        "https://release-assets.githubusercontent.com.evil.test/a",
        "https://github.com/other",
        "https://user@objects.githubusercontent.com/a",
        "https://objects.githubusercontent.com:444/a",
    ] {
        assert!(!git_redirect_allowed(
            &asset,
            &reqwest::Url::parse(url).unwrap(),
            1
        ));
    }
    assert!(!git_redirect_allowed(&asset, &asset, 4));
    assert!(!git_redirect_allowed(
        &reqwest::Url::parse("https://github.com/other").unwrap(),
        &reqwest::Url::parse("https://objects.githubusercontent.com/a").unwrap(),
        1
    ));
}
