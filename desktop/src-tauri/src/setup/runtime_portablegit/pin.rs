use super::{require, Cancellation, Result};
use sha2::{Digest, Sha256};
use std::io::{Read, Seek, SeekFrom};

pub const SHA256: &str = "075e158ef8e1f0ab80b347e245405d3eca735c2dc88fd8e032e137d0ca61f61b";
pub const ARCHIVE_BYTES: usize = 60_027_568;
pub const OFFSET: usize = 251_392;
pub const CHUNK: usize = 65_536;
const HEADER_REGION: usize = 1024 * 1024;

pub fn authenticate(input: &mut dyn Read, cancel: &Cancellation) -> Result<Vec<u8>> {
    let mut data = Vec::with_capacity(ARCHIVE_BYTES + 1);
    let mut buffer = [0; CHUNK];
    loop {
        cancel.check()?;
        let allowed = buffer.len().min(ARCHIVE_BYTES + 1 - data.len());
        let n = input.read(&mut buffer[..allowed])?;
        if n == 0 {
            break;
        }
        data.extend_from_slice(&buffer[..n]);
        require(data.len() <= ARCHIVE_BYTES, "archive exceeds pinned size")?;
    }
    require(
        data.len() == ARCHIVE_BYTES,
        "archive size differs from pinned artifact",
    )?;
    require(
        format!("{:x}", Sha256::digest(&data)) == SHA256,
        "SHA-256 mismatch; use exact official pinned SFX",
    )?;
    cancel.check()?;
    Ok(data)
}

// Only called on the immutable, fully authenticated snapshot; never scan arbitrary SFX data.
pub fn payload(data: &[u8]) -> Result<&[u8]> {
    require(
        OFFSET + 32 <= HEADER_REGION,
        "signature outside bounded header region",
    )?;
    let header = data
        .get(OFFSET..OFFSET + 32)
        .ok_or_else(|| std::io::Error::other("short SFX"))?;
    require(
        &header[..8] == b"7z\xbc\xaf\x27\x1c\x00\x04",
        "pinned 7z signature/version mismatch",
    )?;
    require(
        crc32fast::hash(&header[12..32]) == u32le(&header[8..12]),
        "start-header CRC mismatch",
    )?;
    validate_next_header(data, header)?;
    Ok(&data[OFFSET..])
}

fn validate_next_header(data: &[u8], header: &[u8]) -> Result<()> {
    let offset = u64::from_le_bytes(header[12..20].try_into().unwrap());
    let size = u64::from_le_bytes(header[20..28].try_into().unwrap());
    require(size <= HEADER_REGION as u64, "next-header size limit")?;
    let start = offset
        .checked_add((OFFSET + 32) as u64)
        .ok_or_else(|| std::io::Error::other("header offset overflow"))?;
    let end = start
        .checked_add(size)
        .ok_or_else(|| std::io::Error::other("header size overflow"))?;
    require(end <= data.len() as u64, "next-header outside archive")?;
    require(
        crc32fast::hash(&data[start as usize..end as usize]) == u32le(&header[28..32]),
        "next-header CRC mismatch",
    )
}

fn u32le(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(bytes.try_into().unwrap())
}

pub struct CancelReader<R> {
    pub inner: R,
    pub cancel: Cancellation,
}

impl<R: Read> Read for CancelReader<R> {
    fn read(&mut self, bytes: &mut [u8]) -> Result<usize> {
        self.cancel.check()?;
        let limit = bytes.len().min(CHUNK);
        self.inner.read(&mut bytes[..limit])
    }
}

impl<R: Seek> Seek for CancelReader<R> {
    fn seek(&mut self, from: SeekFrom) -> Result<u64> {
        self.cancel.check()?;
        self.inner.seek(from)
    }
}
