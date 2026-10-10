use super::{require, Cancellation, Result};
use sevenz_rust2::ArchiveEntry;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

pub fn fresh_root(destination: &Path) -> Result<PathBuf> {
    let absolute = std::path::absolute(destination)?;
    require(
        absolute
            .components()
            .all(|c| !matches!(c, Component::ParentDir)),
        "destination contains parent traversal",
    )?;
    let parent = absolute
        .parent()
        .ok_or_else(|| std::io::Error::other("destination needs a parent"))?;
    check_ancestors(parent)?;
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&absolute)?;
    Ok(absolute)
}

fn check_ancestors(path: &Path) -> Result<()> {
    for ancestor in path.ancestors() {
        check_directory(ancestor)?;
    }
    Ok(())
}

fn check_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    require(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "destination ancestor is not a plain directory",
    )?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        require(
            metadata.file_attributes() & 0x400 == 0,
            "destination ancestor is a reparse point",
        )?;
    }
    Ok(())
}

fn directories(root: &Path, relative: &Path) -> Result<()> {
    check_directory(root)?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        match fs::create_dir(&current) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => check_directory(&current)?,
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

pub fn extract_entry(
    root: &Path,
    entry: &ArchiveEntry,
    input: &mut dyn Read,
    cancel: &Cancellation,
) -> Result<Option<u64>> {
    cancel.check()?;
    super::guard::path(&entry.name)?;
    let relative = Path::new(&entry.name);
    if entry.is_directory {
        directories(root, relative)?;
        return Ok(None);
    }
    directories(root, relative.parent().unwrap_or(Path::new("")))?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(root.join(relative))?;
    let record = copy_checked(entry, input, &mut file, cancel)?;
    file.sync_all()?;
    Ok(Some(record))
}

pub fn copy_checked(
    entry: &ArchiveEntry,
    input: &mut dyn Read,
    output: &mut dyn Write,
    cancel: &Cancellation,
) -> Result<u64> {
    let mut crc = crc32fast::Hasher::new();
    let mut written = 0;
    let mut buffer = [0; super::pin::CHUNK];
    loop {
        cancel.check()?;
        let n = input.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        require(
            written + n as u64 <= entry.size,
            "decoded file exceeds declared size",
        )?;
        output.write_all(&buffer[..n])?;
        crc.update(&buffer[..n]);
        written += n as u64;
    }
    finish(entry, written, crc.finalize())
}

fn finish(entry: &ArchiveEntry, written: u64, crc: u32) -> Result<u64> {
    require(written == entry.size, "decoded file truncated")?;
    require(
        !entry.has_crc || crc as u64 == entry.crc,
        "decoded file CRC mismatch",
    )?;
    Ok(written)
}
