//! Read only the qualified PortableGit 2.56.0.2 x64 SFX; never execute it.
//! Ported from qualified helper b0b7fdf9848cd73e0cf5e0b37037379daef04251.
//! No arm64 artifact/offset, post-install, promotion or external extractor is supported here.

#[path = "runtime_portablegit/blocks.rs"]
mod blocks;
#[path = "runtime_portablegit/cancel.rs"]
mod cancel;
#[path = "runtime_portablegit/guard.rs"]
mod guard;
#[path = "runtime_portablegit/output.rs"]
mod output;
#[path = "runtime_portablegit/pin.rs"]
mod pin;

#[cfg(test)]
#[path = "runtime_portablegit/cancel_tests.rs"]
mod cancel_tests;
#[cfg(test)]
#[path = "runtime_portablegit/guard_tests.rs"]
mod guard_tests;
#[cfg(test)]
#[path = "runtime_portablegit/reader_tests.rs"]
mod reader_tests;

pub use cancel::{Cancellation, ExtractionError};
use sevenz_rust2::{ArchiveReader, Password};
use std::io::{self, Cursor, Read, Seek};
use std::path::{Path, PathBuf};
type Result<T> = io::Result<T>;

#[derive(Debug)]
pub struct Summary {
    pub archive_sha256: &'static str,
    pub embedded_offset: usize,
    pub destination: PathBuf,
    pub file_count: usize,
    pub directory_count: usize,
    pub bytes: u64,
}

/// Blocking, full-payload extraction of the exact x64 pin (including all notices).
/// The destination must NOT exist and its existing parent must be trusted and not
/// writable by adversaries. On any error, partial output is left in place: the
/// caller owns cleanup and must use a fresh destination for retry. This does not
/// prepare Git for use; the native owner must still run the qualified post-install.
pub fn extract_x64(
    archive: &Path,
    destination: &Path,
    cancel: Cancellation,
) -> std::result::Result<Summary, ExtractionError> {
    decode(archive, destination, &cancel).map_err(|error| cancel.classify(error))
}

fn decode(archive: &Path, destination: &Path, cancel: &Cancellation) -> Result<Summary> {
    cancel.check()?;
    let data = pin::authenticate(&mut std::fs::File::open(archive)?, cancel)?;
    let source = pin::CancelReader {
        inner: Cursor::new(pin::payload(&data)?),
        cancel: cancel.clone(),
    };
    let mut reader = ArchiveReader::new(source, Password::empty()).map_err(io::Error::other)?;
    reader.set_thread_count(1);
    let mut summary = validate(reader.archive())?;
    cancel.check()?;
    summary.destination = output::fresh_root(destination)?;
    extract(&mut reader, &summary, cancel)?;
    cancel.check()?;
    Ok(summary)
}

fn validate(archive: &sevenz_rust2::Archive) -> Result<Summary> {
    let bytes = guard::entries(&archive.files)?;
    blocks::validate(archive)?;
    let directory_count = archive
        .files
        .iter()
        .filter(|entry| entry.is_directory)
        .count();
    Ok(Summary {
        archive_sha256: pin::SHA256,
        embedded_offset: pin::OFFSET,
        destination: PathBuf::new(),
        file_count: archive.files.len() - directory_count,
        directory_count,
        bytes,
    })
}

fn extract<R: Read + Seek>(
    reader: &mut ArchiveReader<R>,
    summary: &Summary,
    cancel: &Cancellation,
) -> Result<()> {
    let (mut files, mut bytes) = (0, 0);
    reader
        .for_each_entries(|entry, input| {
            if let Some(written) =
                output::extract_entry(&summary.destination, entry, input, cancel)?
            {
                files += 1;
                bytes += written;
            }
            Ok(true)
        })
        .map_err(io::Error::other)?;
    require(
        files == summary.file_count && bytes == summary.bytes,
        "incomplete extraction",
    )
}

fn require(ok: bool, message: &str) -> Result<()> {
    if !ok {
        return Err(io::Error::new(io::ErrorKind::InvalidData, message));
    }
    Ok(())
}
