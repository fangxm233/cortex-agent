use super::{require, Result};
use sevenz_rust2::{Archive, EncoderMethod};

pub const MAX_DICTIONARY: u64 = 256 * 1024 * 1024;
pub const MAX_BLOCK_DICTIONARIES: u64 = 512 * 1024 * 1024;

pub fn validate(archive: &Archive) -> Result<()> {
    require(
        archive.blocks.len() == 6 && archive.is_solid,
        "expected six solid blocks",
    )?;
    for block in &archive.blocks {
        require(block.coders.len() <= 8, "coder count limit")?;
        require(
            block.get_unpack_size() <= super::guard::MAX_TOTAL,
            "block output limit",
        )?;
        let mut dictionaries = 0;
        for coder in &block.coders {
            dictionaries += dictionary(
                coder.encoder_method_id(),
                block.get_unpack_size_for_coder(coder),
            )?;
        }
        require(
            dictionaries <= MAX_BLOCK_DICTIONARIES,
            "block dictionary memory limit",
        )?;
    }
    Ok(())
}

// lzma-rust2 0.16.5 LzmaReader::construct2 clips the dictionary to the
// uncompressed size (no preset dictionary), with a 4 KiB floor and 16-byte
// rounding. sevenz-rust2 passes this public per-coder size to that constructor.
// This bounds allocation, not the private declared dictionary property.
fn dictionary(id: &[u8], unpack_size: u64) -> Result<u64> {
    if id == EncoderMethod::ID_LZMA {
        require(unpack_size <= MAX_DICTIONARY, "LZMA dictionary limit")?;
        return Ok((unpack_size.max(4096) + 15) & !15);
    }
    require(
        [EncoderMethod::ID_DELTA, EncoderMethod::ID_BCJ2].contains(&id),
        "unexpected codec; only pinned LZMA/Delta/BCJ2 allowed",
    )?;
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dictionary_allocation_is_bounded_without_private_properties() {
        assert_eq!(dictionary(EncoderMethod::ID_LZMA, 0).unwrap(), 4096);
        assert_eq!(dictionary(EncoderMethod::ID_LZMA, 4097).unwrap(), 4112);
        assert_eq!(
            dictionary(EncoderMethod::ID_LZMA, MAX_DICTIONARY).unwrap(),
            MAX_DICTIONARY
        );
        assert!(dictionary(EncoderMethod::ID_LZMA, MAX_DICTIONARY + 1).is_err());
        assert!(dictionary(EncoderMethod::ID_LZMA, u64::MAX).is_err());
        assert!(dictionary(EncoderMethod::ID_LZMA2, 1).is_err());
        assert_eq!(dictionary(EncoderMethod::ID_BCJ2, 100).unwrap(), 0);
        assert!(validate(&Archive::default()).is_err());
    }
}
