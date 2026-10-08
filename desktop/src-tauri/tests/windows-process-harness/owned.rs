#![allow(dead_code)]
#[path = "../../src/setup/runtime_cancel.rs"]
mod cancel;
use cancel::{CancelToken, InstallGuard};
#[path = "../../src/setup/runtime_process.rs"]
mod process;
#[path = "../../src/setup/runtime_windows_process_output.rs"]
mod output;

#[test]
fn capture_is_bounded_but_logging_continues() {
    let mut stream = output::Capture::default();
    let mut lines = Vec::new();
    stream.push(&vec![b'a'; output::LIMIT + 1], &mut |s| lines.push(s.to_owned()));
    stream.push(b"\nafter\n", &mut |s| lines.push(s.to_owned()));
    assert_eq!(stream.bytes.len(), output::LIMIT);
    assert!(stream.truncated);
    assert_eq!(lines, ["[overlong output line omitted]", "after"]);
}

#[test]
fn exact_limit_and_final_unterminated_line() {
    let mut stream = output::Capture::default();
    stream.push(&vec![b'x'; output::LIMIT], &mut |_| {});
    assert!(!stream.truncated);
    let mut lines = Vec::new();
    stream.finish(&mut |s| lines.push(s.to_owned()));
    assert_eq!(lines[0].len(), output::LIMIT);
    stream.finish(&mut |_| panic!("duplicate EOF output"));
}

#[test]
fn redaction_occurs_after_reassembling_split_lines() {
    let mut stream = output::Capture::default();
    let mut lines = Vec::new();
    let mut log = |s: &str| lines.push(process::redact_line(s));
    stream.push(b"autho", &mut log);
    stream.push(b"rization: private\n", &mut log);
    assert_eq!(lines, ["[credential-bearing output redacted]"]);
}
