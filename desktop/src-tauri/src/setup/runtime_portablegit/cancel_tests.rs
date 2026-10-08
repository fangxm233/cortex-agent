use super::{output, pin, Cancellation, ExtractionError};
use sevenz_rust2::ArchiveEntry;
use std::io::{Cursor, Read, Seek, Write};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};

fn signal() -> (Arc<AtomicBool>, Cancellation) {
    let flag = Arc::new(AtomicBool::new(false));
    let clone = flag.clone();
    (
        flag,
        Cancellation::new(move || clone.load(Ordering::SeqCst)),
    )
}

#[test]
fn cancellation_is_shared_latched_and_blocks_decoder_reads_and_seeks() {
    let (flag, cancel) = signal();
    let mut reader = pin::CancelReader {
        inner: Cursor::new(b"abc"),
        cancel: cancel.clone(),
    };
    assert_eq!(reader.read(&mut [0]).unwrap(), 1);
    flag.store(true, Ordering::SeqCst);
    let error = reader.read(&mut [0]).unwrap_err();
    assert!(matches!(cancel.classify(error), ExtractionError::Cancelled));
    flag.store(false, Ordering::SeqCst);
    assert!(reader.rewind().is_err());
    assert_eq!(reader.inner.position(), 1);
}

#[test]
fn authentication_polls_in_memory_cancellation_between_chunks() {
    let polls = Arc::new(AtomicUsize::new(0));
    let clone = polls.clone();
    let cancel = Cancellation::new(move || clone.fetch_add(1, Ordering::SeqCst) > 0);
    let mut input = Cursor::new(vec![0; pin::CHUNK * 2]);
    let error = pin::authenticate(&mut input, &cancel).unwrap_err();
    assert!(matches!(cancel.classify(error), ExtractionError::Cancelled));
    assert_eq!(input.position(), pin::CHUNK as u64);
}

struct CancelOnWrite {
    flag: Arc<AtomicBool>,
    bytes: Vec<u8>,
}

impl Write for CancelOnWrite {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.bytes.extend_from_slice(bytes);
        self.flag.store(true, Ordering::SeqCst);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[test]
fn cancellation_stops_output_between_chunks_without_claiming_success() {
    let (flag, cancel) = signal();
    let data = vec![42; pin::CHUNK * 2];
    let entry = ArchiveEntry {
        size: data.len() as u64,
        ..Default::default()
    };
    let mut output = CancelOnWrite {
        flag,
        bytes: Vec::new(),
    };
    let error =
        output::copy_checked(&entry, &mut Cursor::new(data), &mut output, &cancel).unwrap_err();
    assert!(matches!(cancel.classify(error), ExtractionError::Cancelled));
    assert_eq!(output.bytes.len(), pin::CHUNK);
}
