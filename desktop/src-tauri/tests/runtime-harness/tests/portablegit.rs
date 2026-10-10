// Compile the production module verbatim without wiring the product entry point.
#[path = "../../../src/setup/runtime_cancel.rs"]
mod runtime_cancel;
#[path = "../../../src/setup/runtime_portablegit.rs"]
mod runtime_portablegit;

use runtime_portablegit::{extract_x64, Cancellation, ExtractionError};

#[test]
fn native_cancel_token_adapter_cancels_before_archive_open_or_destination_creation() {
    let root = tempfile::tempdir().unwrap();
    let install = runtime_cancel::InstallGuard::begin().unwrap();
    let token = install.token().clone();
    let cancel = Cancellation::new(move || token.check().is_err());
    let clone = cancel.clone();
    runtime_cancel::cancel_install();
    let destination = root.path().join("fresh");
    let error = extract_x64(&root.path().join("absent.exe"), &destination, clone).unwrap_err();
    assert!(matches!(error, ExtractionError::Cancelled), "{error}");
    assert_eq!(error.to_string(), "SETUP_CANCELLED");
    assert!(!destination.exists());
    assert!(matches!(
        extract_x64(root.path(), &destination, cancel),
        Err(ExtractionError::Cancelled)
    ));
}

#[test]
fn invalid_archive_returns_failure_without_creating_destination() {
    let root = tempfile::tempdir().unwrap();
    let archive = root.path().join("not-the-qualified-x64.exe");
    std::fs::write(&archive, b"not an SFX").unwrap();
    let destination = root.path().join("fresh");
    let error = extract_x64(&archive, &destination, Cancellation::new(|| false)).unwrap_err();
    assert!(matches!(error, ExtractionError::Failed(_)));
    assert!(error.to_string().contains("pinned artifact"));
    assert!(!destination.exists());
}
