use super::Result;
use std::io;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

/// Cloneable in-memory cancellation. The callback must be fast, nonblocking and
/// must not panic. Cancellation is latched and shared by all clones.
/// Native adapter: `Cancellation::new(move || token.check().is_err())`.
#[derive(Clone)]
pub struct Cancellation(Arc<State>);

struct State {
    requested: Box<dyn Fn() -> bool + Send + Sync>,
    cancelled: AtomicBool,
}

impl Cancellation {
    pub fn new(requested: impl Fn() -> bool + Send + Sync + 'static) -> Self {
        Self(Arc::new(State {
            requested: Box::new(requested),
            cancelled: AtomicBool::new(false),
        }))
    }

    pub(super) fn check(&self) -> Result<()> {
        if self.0.cancelled.load(Ordering::SeqCst) || (self.0.requested)() {
            self.0.cancelled.store(true, Ordering::SeqCst);
            // Not Interrupted: decoders/read_exact may retry that kind indefinitely.
            return Err(io::Error::other("SETUP_CANCELLED"));
        }
        Ok(())
    }

    pub(super) fn classify(&self, error: io::Error) -> ExtractionError {
        if self.0.cancelled.load(Ordering::SeqCst) {
            ExtractionError::Cancelled
        } else {
            ExtractionError::Failed(error)
        }
    }
}

#[derive(Debug)]
pub enum ExtractionError {
    Cancelled,
    /// I/O or archive validation/decoder failure; partial output may remain.
    Failed(io::Error),
}

impl std::fmt::Display for ExtractionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled => formatter.write_str("SETUP_CANCELLED"),
            Self::Failed(error) => write!(formatter, "PortableGit x64 extraction failed: {error}"),
        }
    }
}

impl std::error::Error for ExtractionError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Cancelled => None,
            Self::Failed(error) => Some(error),
        }
    }
}
