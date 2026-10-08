#![allow(dead_code)]
#[path = "../../src/setup/runtime_cancel.rs"]
mod cancel;
use cancel::CancelToken;
#[path = "../../src/setup/runtime_windows_process_output.rs"]
mod output;
#[path = "../../src/setup/runtime_process.rs"]
mod process;

#[cfg(windows)]
#[path = "../../src/setup/runtime_probe.rs"]
mod probe;
#[cfg(windows)]
mod windows;

// Only selected_output's unrelated environment-selection boundary is stubbed.
// Process execution, probe output/deadline and cancellation use production source.
#[cfg(windows)]
struct Selection;
#[cfg(windows)]
impl Selection {
    fn command(&self, program: &std::ffi::OsStr) -> std::process::Command {
        std::process::Command::new(program)
    }
    fn apply(
        &self,
        _: &mut std::process::Command,
        _: &std::path::Path,
        _: &std::ffi::OsStr,
    ) -> Result<(), String> {
        Ok(())
    }
}

#[test]
fn capture_is_bounded_but_logging_continues() {
    let mut stream = output::Capture::default();
    let mut lines = Vec::new();
    stream.push(&vec![b'a'; output::LIMIT + 1], &mut |s| {
        lines.push(s.to_owned())
    });
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
