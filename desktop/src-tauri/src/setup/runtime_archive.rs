use super::{CancelToken, Selection};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    time::Duration,
};

#[derive(Debug)]
pub struct Release {
    pub archive: String,
    pub sha256: &'static str,
}

// Verified against https://nodejs.org/dist/v24.21.0/SHASUMS256.txt.
// Platform floors: https://github.com/nodejs/node/blob/v24.21.0/BUILDING.md.
const RELEASES: &[(&str, &str, &str, &str)] = &[
    (
        "macos",
        "x86_64",
        "darwin-x64",
        "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097",
    ),
    (
        "macos",
        "aarch64",
        "darwin-arm64",
        "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
    ),
    (
        "linux",
        "x86_64",
        "linux-x64",
        "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
    ),
    (
        "linux",
        "aarch64",
        "linux-arm64",
        "724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5",
    ),
];

pub fn release_for(os: &str, arch: &str) -> Result<Release, String> {
    let (_, _, target, sha256) = RELEASES
        .iter()
        .find(|r| (r.0, r.1) == (os, arch))
        .ok_or("RUNTIME_UNSUPPORTED: supported targets are macOS and glibc Linux x64/arm64")?;
    Ok(Release {
        archive: format!("node-v24.21.0-{target}.tar.gz"),
        sha256,
    })
}

pub fn safe_member(path: &Path, root: &str) -> Result<PathBuf, String> {
    if path
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(integrity("unsafe archive path"));
    }
    path.strip_prefix(root)
        .map(Path::to_path_buf)
        .map_err(|_| integrity("unexpected archive root"))
}

pub fn safe_link(member: &Path, target: &Path) -> Result<(), String> {
    let mut depth = member
        .parent()
        .unwrap_or(Path::new(""))
        .components()
        .count();
    for part in target.components().filter(|c| *c != Component::CurDir) {
        match part {
            Component::Normal(_) => depth += 1,
            Component::ParentDir if depth > 0 => depth -= 1,
            _ => return Err(integrity("unsafe archive link")),
        }
    }
    Ok(())
}

fn integrity(detail: impl std::fmt::Display) -> String {
    format!("RUNTIME_INTEGRITY_FAILED: {detail}")
}
fn download_error(_: impl std::fmt::Display) -> String {
    // HTTP errors may contain proxy credentials. Do not forward their raw Display output.
    "RUNTIME_DOWNLOAD_FAILED: official runtime download failed; check connection and retry".into()
}

pub(super) fn bootstrap(
    home: &Path,
    path: &OsStr,
    floor: &str,
    token: &CancelToken,
    log: &impl Fn(&str),
) -> Result<Selection, String> {
    supported_host()?;
    let release = release_for(std::env::consts::OS, std::env::consts::ARCH)?;
    let root = release.archive.trim_end_matches(".tar.gz");
    let dir = home.join("runtime");
    std::fs::create_dir_all(&dir).map_err(super::storage_error)?;
    let destination = dir.join(root);
    let selected = Selection::new(
        destination.join("bin/node"),
        destination.join("bin/npm"),
        dir.join("prefix"),
    );
    if !destination.exists() {
        install_archive(&release, &dir, &destination, token, log)?;
    }
    if !super::qualified(&selected, home, path, floor) {
        return Err("RUNTIME_UNSUPPORTED: selected Node/npm cannot run on this system".into());
    }
    Ok(selected)
}

fn supported_host() -> Result<(), String> {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        let version =
            unsafe { std::ffi::CStr::from_ptr(libc::gnu_get_libc_version()) }.to_string_lossy();
        let kernel = super::output(std::process::Command::new("/usr/bin/uname"), &["-r"])
            .unwrap_or_default();
        if super::version_at_least(&version, "2.28") && super::version_at_least(&kernel, "4.18") {
            return Ok(());
        }
    }
    #[cfg(target_os = "macos")]
    {
        let version = super::output(
            std::process::Command::new("/usr/bin/sw_vers"),
            &["-productVersion"],
        )
        .unwrap_or_default();
        if super::version_at_least(&version, "13.5") {
            return Ok(());
        }
    }
    Err("RUNTIME_UNSUPPORTED: requires macOS 13.5+ or glibc 2.28+ Linux kernel 4.18+".into())
}

fn install_archive(
    release: &Release,
    dir: &Path,
    destination: &Path,
    token: &CancelToken,
    log: &impl Fn(&str),
) -> Result<(), String> {
    log(&format!("Downloading official {}", release.archive));
    let mut archive = tempfile::tempfile_in(dir).map_err(super::storage_error)?;
    download(release, &mut archive, token)?;
    token.check()?;
    use std::io::{Seek, SeekFrom};
    archive.seek(SeekFrom::Start(0)).map_err(integrity)?;
    let stage = tempfile::tempdir_in(dir).map_err(super::storage_error)?;
    extract(
        archive,
        stage.path(),
        release.archive.trim_end_matches(".tar.gz"),
        token,
    )?;
    token.check()?;
    std::fs::rename(
        stage
            .path()
            .join(release.archive.trim_end_matches(".tar.gz")),
        destination,
    )
    .map_err(integrity)?;
    log("Official runtime checksum verified and staged installation completed");
    Ok(())
}

fn download(
    release: &Release,
    file: &mut std::fs::File,
    token: &CancelToken,
) -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(download_error)?;
    runtime.block_on(async {
        tokio::select! {
            result = download_chunks(release, file) => result,
            _ = wait_cancel(token) => Err("SETUP_CANCELLED".into()),
        }
    })
}

async fn wait_cancel(token: &CancelToken) {
    while token.check().is_ok() {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn download_chunks(release: &Release, file: &mut std::fs::File) -> Result<(), String> {
    let client = http_client()?;
    let mut response = client
        .get(format!(
            "https://nodejs.org/dist/v24.21.0/{}",
            release.archive
        ))
        .send()
        .await
        .map_err(download_error)?
        .error_for_status()
        .map_err(download_error)?;
    let mut hash = Sha256::new();
    let mut size = 0;
    while let Some(chunk) = response.chunk().await.map_err(download_error)? {
        size += chunk.len();
        if size > 150 * 1024 * 1024 {
            return Err(integrity("archive too large"));
        }
        hash.update(&chunk);
        file.write_all(&chunk).map_err(download_error)?;
    }
    verify_digest(&format!("{:x}", hash.finalize()), release.sha256)
}

pub(super) fn verify_digest(actual: &str, expected: &str) -> Result<(), String> {
    if actual != expected {
        return Err(integrity("SHA-256 mismatch"));
    }
    Ok(())
}

fn http_client() -> Result<reqwest::Client, String> {
    let roots = rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let tls = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(download_error)?
    .with_root_certificates(roots)
    .with_no_client_auth();
    reqwest::Client::builder()
        .use_preconfigured_tls(tls)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(download_error)
}

pub(super) fn extract(
    reader: impl Read,
    stage: &Path,
    root: &str,
    token: &CancelToken,
) -> Result<(), String> {
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(reader));
    archive.set_preserve_permissions(false); // keeps executable bits, strips privileged mode bits
    let mut size = 0u64;
    let mut links = Vec::new();
    for entry in archive.entries().map_err(integrity)? {
        token.check()?;
        let mut entry = entry.map_err(integrity)?;
        validate_entry(&entry, root)?;
        if entry.header().entry_type().is_symlink() {
            links.push(stage.join(entry.path().map_err(integrity)?));
        }
        size += entry.size();
        if size > 1024 * 1024 * 1024 {
            return Err(integrity("expanded archive too large"));
        }
        if !entry.unpack_in(stage).map_err(integrity)? {
            return Err(integrity("archive escaped staging directory"));
        }
    }
    validate_extracted_links(&stage.join(root), &links)
}

fn validate_extracted_links(root: &Path, links: &[PathBuf]) -> Result<(), String> {
    let root = root.canonicalize().map_err(integrity)?;
    for link in links {
        if !link.canonicalize().map_err(integrity)?.starts_with(&root) {
            return Err(integrity("archive link escapes runtime root"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(entries: &[(&str, &str, u32, u8)]) -> Vec<u8> {
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        let mut builder = tar::Builder::new(encoder);
        for (name, contents, mode, kind) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::new(*kind));
            header.set_mode(*mode);
            header.set_size(if *kind == b'0' {
                contents.len() as u64
            } else {
                0
            });
            if *kind == b'2' {
                header.set_link_name(contents).unwrap();
            }
            header.set_cksum();
            let bytes = if *kind == b'0' {
                contents.as_bytes()
            } else {
                &[]
            };
            builder.append_data(&mut header, name, bytes).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn extraction_preserves_relative_npm_link_and_executable_not_setuid() {
        use std::os::unix::fs::PermissionsExt;
        let bytes = fixture(&[
            ("node/lib/npm.js", "npm fixture", 0o4755, b'0'),
            ("node/bin/npm", "../lib/npm.js", 0o777, b'2'),
        ]);
        let stage = tempfile::tempdir().unwrap();
        extract(
            bytes.as_slice(),
            stage.path(),
            "node",
            &CancelToken::default(),
        )
        .unwrap();
        let npm = stage.path().join("node/bin/npm");
        assert_eq!(std::fs::read_to_string(&npm).unwrap(), "npm fixture");
        assert_eq!(
            std::fs::read_link(&npm).unwrap(),
            Path::new("../lib/npm.js")
        );
        assert_eq!(npm.metadata().unwrap().permissions().mode() & 0o4777, 0o755);
    }

    #[test]
    fn chained_relative_links_cannot_escape_promoted_runtime() {
        let bytes = fixture(&[
            ("node/a", ".", 0o777, b'2'),
            ("node/bin/npm", "../a/../outside", 0o777, b'2'),
        ]);
        let stage = tempfile::tempdir().unwrap();
        std::fs::write(stage.path().join("outside"), "not part of node").unwrap();
        assert!(extract(
            bytes.as_slice(),
            stage.path(),
            "node",
            &CancelToken::default()
        )
        .is_err());
    }

    #[test]
    fn checksum_failure_never_reaches_extraction() {
        assert!(verify_digest("corrupt", "official")
            .unwrap_err()
            .starts_with("RUNTIME_INTEGRITY_FAILED"));
        assert!(verify_digest("same", "same").is_ok());
    }
}

fn validate_entry<R: Read>(entry: &tar::Entry<'_, R>, root: &str) -> Result<(), String> {
    let member = safe_member(&entry.path().map_err(integrity)?, root)?;
    let kind = entry.header().entry_type();
    if member.as_os_str().is_empty() && !kind.is_dir() {
        return Err(integrity("runtime root must be a directory"));
    }
    if kind.is_symlink() {
        let target = entry
            .link_name()
            .map_err(integrity)?
            .ok_or_else(|| integrity("missing link target"))?;
        return safe_link(&member, &target);
    }
    if !kind.is_file() && !kind.is_dir() {
        return Err(integrity("unsupported archive entry"));
    }
    Ok(())
}
