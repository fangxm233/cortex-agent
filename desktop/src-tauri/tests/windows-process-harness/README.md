# Owned Windows install/probe execution — bounded unit handoff

Status: implemented, **not Windows-compiled or Windows-runtime-verified**. Product entry
activation remains with the parent. No PortableGit preparation/audit, post-install
exit exception, ordinary process runner change, product build, deployment, or remote
execution is part of this unit.

Implementation commits: `b112a4b0d` (bounded diagnostics, executed RED → GREEN),
`0e7eda9bd` (owned execution and Windows fixtures). Base: `823bae7ca`;
branch: `cortex/win-owned-process`. Not merged into main or integration.

## Files / integration contract

All paths below are relative to `desktop/src-tauri/`:

- `src/setup/runtime_process.rs`: existing `run_install(Command, &CancelToken, log)`
  remains strict: **every nonzero exit fails**. POSIX behavior remains unchanged
  (cfg separation and a function extraction only).
- `src/setup/runtime_probe.rs`: existing `output` / `selected_output` APIs remain;
  Windows uses the owned executor. Ten-second qualification deadline, 64-KiB stdout
  limit, only successful nonempty trimmed stdout qualifies, cancellation propagates.
- `src/setup/runtime_windows_process.rs`: internal executor, nonblocking pipe polling,
  root-exit descendant termination, bounded raw `Outcome`.
- `src/setup/runtime_windows_process_job.rs`: suspended process, Job assignment /
  membership verification / resume, fail-closed RAII settlement.
- `src/setup/runtime_windows_process_output.rs`: bounded retention / line framing.
- `tests/windows-process-harness/{Cargo.toml,Cargo.lock,owned.rs,windows.rs,fixture.rs,README.md}`:
  standalone focused crate; includes production execution/cancellation/probe sources.
  Only the unused `Selection` integration boundary is stubbed. No edits to the
  existing `tests/runtime-harness` or product Cargo files.

Windows-only internal API (accessible to sibling runtime modules):

```rust
runtime::process::run_install_outcome(command, token, log)
    -> Result<runtime::process::windows::Outcome, String>
```

`Outcome` fields: `exit_code: u32`, `stdout/stderr: Vec<u8>`,
`stdout_truncated/stderr_truncated: bool`. Each byte vector retains the first 64 KiB.
The caller sees it only after the owned tree is empty and pipe readers are settled.
Raw bytes are **not redacted**; never forward them directly to logs/UI. Live callbacks
are line-redacted; lines longer than 64 KiB are omitted whole, never split into
potentially secret-bearing fragments. This API implements **no nonzero exception**.

### Required windows-sys 0.61 features

Parent must add exactly these missing features to the product dependency:

- `Win32_System_JobObjects`
- `Win32_Security`
- `Win32_System_Pipes`

Also used, already present: `Win32_Foundation`, `Win32_System_Threading`,
`Win32_System_Diagnostics_ToolHelp`. The standalone crate declares all six.

### Ownership / settlement details

`Command::spawn` uses documented `CREATE_SUSPENDED | CREATE_NO_WINDOW`, preserving
Rust's own Windows executable/.cmd quoting, raw arguments, current directory,
`env_clear`, removal, and case-insensitive Path handling. No custom serialization.
The unnamed non-inheritable Job has `KILL_ON_JOB_CLOSE` and **no breakaway flags**.
Assignment and `IsProcessInJob` verification happen while the primary thread is
suspended. Since stable `Child` exposes no primary-thread handle, documented ToolHelp
enumeration requires exactly one root thread; `OpenThread` + `GetProcessIdOfThread`
verify identity before `ResumeThread`. No child code or unowned fallback runs if
assignment, enumeration, membership, or resume fails.

On root exit, surviving owned descendants are terminated, then both streams drain
and the Job must be empty. Cancellation, I/O/wait/deadline errors, and unwinding also
terminate and reap the root and confirm zero active Job processes before returning.
An unassigned suspended root is explicitly killed/reaped on assignment failure.
No reader threads exist: each poll reads at most `PeekNamedPipe`'s available bytes.
Cleanup retries kernel errors rather than returning an unconfirmed settlement;
required OS teardown can extend the probe's execution deadline (it has no unsafe
"cleanup timed out, abandon children" escape). Only this invocation's handles/tree
are signaled. Existing daemon/app/client/server processes are never discovered or killed.

## Verification performed locally

Working directory: `/home/fangxin/Cortex-wt-win-owned-process`.
Toolchain: existing `rustc 1.96.1`; no toolchains/targets/system packages installed.
Only isolated Cargo target caches under `/tmp/cortex-win-owned-{target,posix}` changed
outside the worktree. No product build or whole-suite run.

```sh
CARGO_TARGET_DIR=/tmp/cortex-win-owned-target cargo test \
  --manifest-path desktop/src-tauri/tests/windows-process-harness/Cargo.toml \
  --test owned --locked --offline
# GREEN: 3/3 portable production capture/redaction tests.
# Prior RED with the unbounded/no-framing implementation: 3/3 failed
# (65544 != 65536, missing EOF line, missing reassembled/redacted line).

CARGO_TARGET_DIR=/tmp/cortex-win-owned-target cargo clippy \
  --manifest-path desktop/src-tauri/tests/windows-process-harness/Cargo.toml \
  --test owned --locked --offline -- -D warnings
# PASS on Linux; does NOT compile the cfg(windows) code.

CARGO_TARGET_DIR=/tmp/cortex-win-owned-posix cargo test \
  --manifest-path desktop/src-tauri/tests/runtime-harness/Cargo.toml \
  --locked --offline runtime::probe::tests -- --test-threads=1
# PASS: 3/3 production POSIX probe tests.

for test in \
  npm_cancellation_kills_only_the_owned_process_group \
  failed_initial_npm_install_can_retry_without_reselecting_runtime \
  credentials_never_reach_install_events \
  cancellation_is_owned_and_does_not_poison_next_install \
  private_install_is_direct_persisted_and_idempotent_without_external_overwrite
do
  CARGO_TARGET_DIR=/tmp/cortex-win-owned-posix cargo test \
    --manifest-path desktop/src-tauri/tests/runtime-harness/Cargo.toml \
    --locked --offline "$test" -- --exact --test-threads=1
done
# PASS: 5/5 focused POSIX cancellation/install/retry/redaction boundary tests.
```

An earlier `npm_` filter also passed five matching existing tests (including archive
and split-runtime fixtures); the final evidence above uses exact relevant names.
Scoped rustfmt, function/file length checks (<=30 / <=800), and `git diff --check`
passed. No existing runtime harness files were modified.

## Windows verification outstanding — parent owns execution

```sh
CARGO_TARGET_DIR=/tmp/cortex-win-owned-target cargo check \
  --manifest-path desktop/src-tauri/tests/windows-process-harness/Cargo.toml \
  --tests --target x86_64-pc-windows-msvc --locked --offline
```

**Blocked before our Windows source was checked**: E0463, missing Windows `core` /
standard-library target. This is not a Windows compile pass. All 12 Windows-specific
tests are unexecuted; their names in `windows.rs` enumerate assignment-before-resume,
pre-resume unwind/resume failure, non-breakaway, fast descendants, root-exit held
pipes, cancellation/outsider/retry, deadlines/limits, nonzero outcome versus strict
install, probe qualification, quoting/environment, and `.cmd` compatibility.

On the parent's approved Windows test environment, run this focused crate (no product
build required):

```sh
cargo test --manifest-path desktop/src-tauri/tests/windows-process-harness/Cargo.toml \
  --test owned --locked -- --test-threads=1
```

Expected: 15 tests (3 portable + 12 Windows). Windows compile/runtime, actual nested
Job compatibility, and x64/arm64 platform acceptance remain unclaimed. Parent must
supply product features and integrate the runtime entry point separately. Stop here;
no preparation/audit or wider validation loop is delegated by this handoff.
