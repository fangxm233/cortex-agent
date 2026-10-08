use super::{require, Result};
use sevenz_rust2::ArchiveEntry;
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_ENTRIES: usize = 20_000;
pub const MAX_FILE: u64 = 256 * 1024 * 1024;
pub const MAX_TOTAL: u64 = 1024 * 1024 * 1024;

pub fn path(name: &str) -> Result<()> {
    require(
        !name.is_empty() && name.len() <= 240 && name.is_ascii(),
        "invalid path length/encoding",
    )?;
    require(
        !name
            .bytes()
            .any(|b| b < 32 || b == 127 || b"\\\\:<>\"|?*~".contains(&b)),
        "unsafe path character",
    )?;
    for part in name.split('/') {
        component(part)?;
    }
    Ok(())
}

fn component(part: &str) -> Result<()> {
    require(
        !part.is_empty() && !part.ends_with(['.', ' ']),
        "empty/dot/trailing-dot-or-space component",
    )?;
    let stem = part
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_uppercase();
    let numbered = stem.len() == 4
        && (stem.starts_with("COM") || stem.starts_with("LPT"))
        && matches!(stem.as_bytes()[3], b'1'..=b'9');
    require(
        !numbered && !["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&stem.as_str()),
        "Windows reserved name",
    )
}

pub fn entries(entries: &[ArchiveEntry]) -> Result<u64> {
    require(entries.len() <= MAX_ENTRIES, "entry count limit")?;
    let mut seen = BTreeSet::new();
    let mut tree = BTreeMap::new();
    let mut total = 0;
    for entry in entries {
        path(&entry.name)?;
        attributes(entry)?;
        require(
            seen.insert(entry.name.to_ascii_lowercase()),
            "duplicate/case-alias entry",
        )?;
        insert_path(&mut tree, &entry.name, entry.is_directory)?;
        total += entry.size;
        require(total <= MAX_TOTAL, "total output limit")?;
    }
    Ok(total)
}

fn attributes(entry: &ArchiveEntry) -> Result<()> {
    let attr = entry.windows_attributes;
    let kind = (attr >> 16) & 0xf000;
    let expected = if entry.is_directory { 0x4000 } else { 0x8000 };
    require(
        !entry.is_anti_item && attr & 0x440 == 0,
        "anti-item/device/reparse entry",
    )?;
    require(kind == 0 || kind == expected, "Unix link/special entry")?;
    require(entry.size <= MAX_FILE, "per-file output limit")?;
    require(
        entry.size == 0 || (entry.has_stream && entry.has_crc),
        "missing stream or CRC",
    )?;
    require(
        !entry.is_directory || (!entry.has_stream && entry.size == 0),
        "directory has data",
    )
}

fn insert_path(
    tree: &mut BTreeMap<String, (String, bool)>,
    name: &str,
    directory: bool,
) -> Result<()> {
    let parts: Vec<_> = name.split('/').collect();
    for end in 1..=parts.len() {
        let prefix = parts[..end].join("/");
        let kind = end != parts.len() || directory;
        let value = (prefix.clone(), kind);
        require(
            tree.len() < MAX_ENTRIES || tree.contains_key(&prefix.to_ascii_lowercase()),
            "implicit directory count limit",
        )?;
        if let Some(previous) = tree.insert(prefix.to_ascii_lowercase(), value.clone()) {
            require(previous == value, "parent file conflict or case alias")?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_names_without_sanitizing() {
        for name in [
            "", "/etc/x", "../x", "a/../b", "a//b", "a/./b", "C:/x", "a\\b", "x:ads", "CON",
            "con.txt", "Lpt9.txt", "COM1", "NUL", "aux", "aux .txt", "foo~1", "a.", "a ", "a\0b",
            "a\nb", "x?y", "COM¹", "a/PRN/x",
        ] {
            assert!(path(name).is_err(), "accepted {name:?}");
        }
    }

    #[test]
    fn accepts_verbatim_official_style_names() {
        for name in [
            "post-install.bat",
            "README.portable",
            "usr/share/licenses/GPL-3.0",
        ] {
            path(name).unwrap();
        }
    }

    fn file(name: &str) -> ArchiveEntry {
        ArchiveEntry {
            name: name.into(),
            has_crc: true,
            has_stream: true,
            size: 1,
            ..Default::default()
        }
    }

    #[test]
    fn rejects_aliases_and_parent_file_conflicts() {
        for names in [["a", "A"], ["a", "a/b"], ["Foo/x", "foo/y"]] {
            assert!(entries(&names.map(file)).is_err(), "accepted {names:?}");
        }
    }

    #[test]
    fn rejects_links_anti_items_missing_crc_and_sizes() {
        let mut variants = vec![file("x"); 5];
        variants[0].windows_attributes = 0x400;
        variants[1].windows_attributes = 0xa000_8000;
        variants[2].is_anti_item = true;
        variants[3].has_crc = false;
        variants[4].size = MAX_FILE + 1;
        for entry in variants {
            assert!(entries(&[entry]).is_err());
        }
    }

    #[test]
    fn rejects_total_and_count_overflow() {
        let huge: Vec<_> = (0..5)
            .map(|n| ArchiveEntry {
                size: MAX_FILE,
                ..file(&format!("f{n}"))
            })
            .collect();
        assert!(entries(&huge).is_err());
        assert!(entries(&vec![file("x"); MAX_ENTRIES + 1]).is_err());
    }
}
