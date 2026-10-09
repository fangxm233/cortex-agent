//! Bounded Node ZIP staging. Caller supplies an attempt-private, trusted parent.
use super::CancelToken;
use std::{
    collections::HashSet,
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
};

const MAX_ARCHIVE: usize = 150 * 1024 * 1024;
const MAX_EXPANDED: u64 = 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 40_000;

fn invalid(error: impl std::fmt::Display) -> String {
    format!("RUNTIME_INTEGRITY_FAILED: {error}")
}

pub(super) fn read_zip(mut file: impl Read, token: &CancelToken) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut chunk = [0; 65536];
    loop {
        token.check()?;
        let count = file.read(&mut chunk).map_err(invalid)?;
        if count == 0 {
            return Ok(bytes);
        }
        if bytes.len() + count > MAX_ARCHIVE {
            return Err(invalid("ZIP too large"));
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
}

pub(super) fn extract_zip(
    bytes: &[u8],
    destination: &Path,
    root: &str,
    token: &CancelToken,
) -> Result<(), String> {
    token.check()?;
    if bytes.len() > MAX_ARCHIVE {
        return Err(invalid("ZIP too large"));
    }
    let count = zip_count(bytes)?;
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(invalid)?;
    if archive.len() != count {
        return Err(invalid("ZIP duplicate or inconsistent directory"));
    }
    validate_zip(&mut archive, bytes, root, token)?;
    plain_parents(destination.parent().ok_or_else(|| invalid("missing parent"))?)?;
    std::fs::create_dir(destination).map_err(invalid)?;
    for index in 0..archive.len() {
        token.check()?;
        let mut entry = archive.by_index(index).map_err(invalid)?;
        let member = zip_member(entry.name(), root)?;
        unpack_entry(&mut entry, &destination.join(member), token)?;
    }
    token.check()
}

// Node's pin is a conventional single-disk ZIP, not ZIP64. Bound metadata before
// ZipArchive allocates its index (which would otherwise hide exact duplicates).
fn zip_count(bytes: &[u8]) -> Result<usize, String> {
    let start = bytes.len().saturating_sub(65557);
    let offset = (start..bytes.len().saturating_sub(21))
        .rev()
        .find(|&i| {
            bytes[i..].starts_with(b"PK\x05\x06")
                && i + 22 + u16::from_le_bytes([bytes[i + 20], bytes[i + 21]]) as usize == bytes.len()
        })
        .ok_or_else(|| invalid("missing ZIP end record"))?;
    let end = &bytes[offset..offset + 22];
    let count = u16::from_le_bytes([end[10], end[11]]) as usize;
    let size = u32::from_le_bytes(end[12..16].try_into().unwrap()) as u64;
    let central = u32::from_le_bytes(end[16..20].try_into().unwrap()) as u64;
    if end[4..8] != [0; 4] || end[8..10] != end[10..12] || count == 0 || count > MAX_ENTRIES {
        return Err(invalid("ZIP entry/disk limit"));
    }
    if central + size != offset as u64 {
        return Err(invalid("ZIP central directory bounds/ZIP64"));
    }
    Ok(count)
}

fn validate_zip(
    archive: &mut zip::ZipArchive<Cursor<&[u8]>>,
    bytes: &[u8],
    root: &str,
    token: &CancelToken,
) -> Result<(), String> {
    if archive.len() > MAX_ENTRIES {
        return Err(invalid("ZIP entry limit"));
    }
    let mut names = HashSet::new();
    let mut size = 0u64;
    for index in 0..archive.len() {
        token.check()?;
        let entry = archive.by_index(index).map_err(invalid)?;
        let member = zip_member(entry.name(), root)?;
        if !names.insert(member.to_string_lossy().to_ascii_lowercase()) {
            return Err(invalid("ZIP duplicate path"));
        }
        validate_kind(&entry, bytes)?;
        size = size
            .checked_add(entry.size())
            .ok_or_else(|| invalid("ZIP size overflow"))?;
        if size > MAX_EXPANDED {
            return Err(invalid("ZIP expansion limit"));
        }
    }
    Ok(())
}

fn validate_kind(entry: &zip::read::ZipFile<'_>, bytes: &[u8]) -> Result<(), String> {
    let offset = usize::try_from(entry.central_header_start()).map_err(invalid)?;
    let raw = bytes
        .get(offset..offset.saturating_add(46))
        .ok_or_else(|| invalid("ZIP header"))?;
    let attrs = u32::from_le_bytes(raw[38..42].try_into().unwrap());
    let kind = (attrs >> 16) & 0o170000;
    if attrs & 0x400 != 0 || !matches!(kind, 0 | 0o100000 | 0o040000) {
        return Err(invalid("ZIP link/reparse/special file"));
    }
    if entry.encrypted() || entry.is_symlink() || (entry.is_dir() && entry.size() != 0) {
        return Err(invalid("unsupported ZIP entry"));
    }
    if entry.name_raw() != entry.name().as_bytes() {
        return Err(invalid("ZIP filename encoding"));
    }
    Ok(())
}

fn zip_member(name: &str, root: &str) -> Result<PathBuf, String> {
    let name = name.strip_suffix('/').unwrap_or(name);
    let mut parts = name.split('/');
    if parts.next() != Some(root) {
        return Err(invalid("unexpected ZIP root"));
    }
    let mut result = PathBuf::new();
    for part in parts {
        if !safe_component(part) {
            return Err(invalid("unsafe ZIP path"));
        }
        result.push(part);
    }
    Ok(result)
}

fn safe_component(part: &str) -> bool {
    let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|n| {
            matches!(
                n,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    });
    !part.is_empty()
        && !part.ends_with(['.', ' '])
        && !reserved
        && !part.chars().any(|c| c.is_control() || "\\:<>\"|?*".contains(c))
}

fn unpack_entry(
    entry: &mut zip::read::ZipFile<'_>,
    target: &Path,
    token: &CancelToken,
) -> Result<(), String> {
    if entry.is_dir() {
        std::fs::create_dir_all(target).map_err(invalid)?;
        return plain_parents(target);
    }
    let parent = target.parent().ok_or_else(|| invalid("missing ZIP parent"))?;
    std::fs::create_dir_all(parent).map_err(invalid)?;
    plain_parents(parent)?;
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(invalid)?;
    copy_entry(entry, &mut output, token)
}

fn copy_entry(
    entry: &mut zip::read::ZipFile<'_>,
    output: &mut impl Write,
    token: &CancelToken,
) -> Result<(), String> {
    let mut bytes = [0; 65536];
    let mut written = 0u64;
    loop {
        token.check()?;
        let count = entry.read(&mut bytes).map_err(invalid)?; // zip verifies CRC at EOF
        if count == 0 {
            break;
        }
        written += count as u64;
        if written > entry.size() {
            return Err(invalid("ZIP size mismatch"));
        }
        output.write_all(&bytes[..count]).map_err(invalid)?;
    }
    if written != entry.size() {
        return Err(invalid("ZIP short entry"));
    }
    Ok(())
}

pub(super) fn plain_parents(path: &Path) -> Result<(), String> {
    for parent in path.ancestors().filter(|p| !p.as_os_str().is_empty()) {
        let metadata = std::fs::symlink_metadata(parent).map_err(invalid)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() || reparse(&metadata) {
            return Err(invalid("staging parent is not a plain directory"));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn reparse(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}
#[cfg(not(windows))]
fn reparse(_: &std::fs::Metadata) -> bool {
    false
}

#[cfg(test)]
use super::windows_download::{git_redirect_allowed, GIT_URL};
#[cfg(test)]
#[path = "runtime_windows_archive_tests.rs"]
mod tests;
