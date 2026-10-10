# Native onboarding runtime tests (no Tauri window)

This crate compiles the **same** `src/setup/runtime*.rs` used by the desktop command.
It needs Rust/Cargo, not GTK, WebKit, a display, Node, npm, Git, or system archive tools.
The normal suite uses disposable shell fixtures and does not download/install a real server.

```sh
cargo test --manifest-path desktop/src-tauri/tests/runtime-harness/Cargo.toml --locked
```

## PortableGit source-port status and focused verification

The bounded x64 reader port is complete, **not yet wired into native setup**.
`tests/portablegit.rs` imports the exact production `runtime_portablegit.rs` and
existing `runtime_cancel.rs`; it does not substitute a test extractor. API,
trusted-staging assumptions, pin, licenses and remaining native work:
[`runtime_portablegit/README.md`](../../src/setup/runtime_portablegit/README.md).

Verified with Rust 1.90.0 (no toolchain/system install):

```sh
cargo test --manifest-path desktop/src-tauri/tests/runtime-harness/Cargo.toml \
  --locked --offline --test portablegit
cargo tree --manifest-path desktop/src-tauri/tests/runtime-harness/Cargo.toml \
  --locked --offline -p sevenz-rust2 -e features
cargo metadata --manifest-path desktop/src-tauri/Cargo.toml \
  --locked --offline --no-deps --format-version 1 >/dev/null
```

Results: **21 passed, 0 failed**. The four new cancellation tests first failed with
callback polling disabled (native adapter, read/seek latch, mid-authentication,
mid-output), then passed when implemented. Additional cases cover fresh paths,
no overwrite, symlink parents, header CRC/bounds, synthetic wrong hash/size,
unsafe raw names, decoded size/CRC, limits, notice retention, aggregate counts
and cancellation through decoder error wrapping. No real PortableGit archive,
extracted executable/script, post-install or full inventory audit is run.

Focused feature output: sevenz-rust2 0.20.2 → crc32fast 1.5.0 and lzma-rust2
0.16.5 (`std`, `optimization`); no optional sevenz features. Native manifest
metadata passes. A **non-build** native Windows feature-tree check was blocked by
uncached pre-existing `webview2-com 0.39.1` under `--offline`:

```sh
cargo tree --manifest-path desktop/src-tauri/Cargo.toml --locked --offline \
  --target x86_64-pc-windows-msvc -p sevenz-rust2 -e features
```

No native build, extra download or dependency workaround was attempted. Parent
still owns Windows wiring/build/fresh Sandbox acceptance; Linux focused tests do
not requalify Windows reparse behavior or claim arm64 support.

## Explicit isolated integration run

Only the ignored test performs a real download and initial npm install. Build a thin server
`.tgz` separately; do not carry Linux native dependencies into a macOS package.
Choose an absolute **nonexistent** test home, never the production Cortex home:

```sh
CORTEX_RUNTIME_TEST_HOME=/absolute/new-isolated-home \
CORTEX_RUNTIME_TEST_PACKAGE=/absolute/server.tgz \
cargo test --manifest-path desktop/src-tauri/tests/runtime-harness/Cargo.toml --locked \
  isolated_real_bootstrap_and_install -- --ignored --nocapture
```

The explicitly filtered test runs alone in its test process, sets HOME to a new login-home
subdirectory, and clears inherited npm configuration variables (without modifying the caller's
environment). This avoids reading production `.npmrc` or writing production npm caches.
It first bootstraps with an empty discovery PATH, forcing official Node. Then it invokes
the shared installer with `/usr/bin:/bin` for npm lifecycle tools. It checks a second install
call reuses the saved selection with a changed PATH. It retains the isolated directory for
inspection. It does **not** init configuration, start a daemon, register a service, or alter
shell profiles/global npm settings. A supported Cortex in `/usr/bin:/bin` is intentionally
reused by production logic; use an isolated host without such an installation for this test.

Saved selection: `<test-home>/runtime/selection.json` (node, npm, private prefix, exact server
entry point). Managed server launch is the saved node executable followed by the saved server
entry point and CLI arguments. Missing selected node/npm raises `RUNTIME_MISSING`, not a PATH
fallback. Selected environment sets `CORTEX_HOME`, `PATH`, `CORTEX_NPM_PREFIX`,
`NPM_CONFIG_PREFIX`, and `npm_config_prefix`.

## Native compile boundary

The integrated checkout must include `src/setup/service.rs` from the service worker.
Without bundled frontend artifacts, library **checking** can suppress bundle resources:

```sh
TAURI_CONFIG='{"bundle":{"resources":[]}}' \
cargo check --manifest-path desktop/src-tauri/Cargo.toml --lib --locked
```

`cargo test --lib setup::` also compiles the existing `seed.rs` tests, which require `web/dist`.
The headless crate deliberately avoids that unrelated frontend prerequisite. Linux native
checking requires the existing GTK3/WebKit2GTK development libraries; no system packages
are installed by this implementation.

## Windows selection unit handoff (2026-10-08)

Status: bounded selection unit complete on `cortex/win-selection`, worktree
`/home/fangxin/Cortex-wt-win-selection`; **not Windows execution/build acceptance**.
Resumed the existing work, retaining `95065ccc995ea17f58b8d5baf3c8f51066412806`
(persistence/identities) and the pending Windows layout tests. Follow-up commits:

- `3dc293aa37b87f4c63e855c20962b7158d0d2c02`: preserved layout tests, Windows suffix
  discovery, flat prefix, child environment, POSIX-only split-runtime symlinks.
- `1928c09f4778848db1f7d27227893f7e369b8206`: bounded same-install Git qualification,
  npm binding/validation, repair APIs and focused tests.

Production files are `src/setup/runtime.rs`, `runtime_selection.rs`,
`runtime_selection_environment.rs`, `runtime_selection_discovery.rs`, and
`runtime_git_selection.rs` (relative to `desktop/src-tauri/`). Tests are the adjacent
`runtime_selection_tests.rs`, preserved `runtime_selection_windows_tests.rs`, and
`runtime_git_selection_tests.rs`. No process/probe, archive/installer, product
manifest/lock, decoder, server/client, web, main, remote, build or deployment changes.

### Public API for the bootstrap/installer owner

All types/methods are exposed through the existing `runtime` module:

- `Selection::read_saved(home: &Path) -> Result<Option<Selection>, String>` reads
  identities/ownership even with missing tools. `load` remains strict; old
  Node-only records still deserialize/load with optional fields absent.
- `Selection::windows_repair_needs(&self) -> RepairNeeds` returns public `node`
  and `git` booleans (presence/layout only, not executable/version health).
  Missing Git is repair-needed. A legacy record with valid npm layout can bind
  its CLI without reinstalling. These flags do **not** authorize external writes.
- `Selection::qualify_windows_npm(&mut self) -> bool` binds `npm_cli` only for
  colocated Node/npm with actual CLI/package metadata and matching npm.cmd/npm
  package templates. This is **layout** qualification; then call
  `qualify_node(&self, home: &Path, path: &OsStr, floor: &str, token: &CancelToken)
  -> Result<bool, String>` for bounded version probes. Node qualification ignores
  the saved Git identity so Git repair cannot prevent checking Node.
- `Selection::validate_windows_npm(&self) -> Result<(), String>` checks a bound
  identity against current layout. Windows `apply` requires this validation.
- `Selection::npm_command(&self) -> Command` and `command("npm"/"npm.cmd"/saved npm)`
  execute selected Node + literal saved CLI argument, not cmd.exe or PATH Node.
  Unbound Windows npm fails closed (empty program); normal `apply` gives the
  explicit missing/unqualified error. POSIX legacy npm launch is unchanged.
- `GitSelection::from_root(root: PathBuf, managed: bool) -> Option<GitSelection>`
  requires root/cmd/git.exe and root/usr/bin/{bash,sh,grep}.exe. The preferred
  usr/bin Bash is authoritative; unrelated bin/bash, bare Git, WSL and incomplete
  MinGit do not qualify. `validate(&self) -> Result<(), String>` checks presence.
- `GitSelection::qualify(&self, token: &CancelToken) -> Result<bool, String>` uses
  the existing bounded probe API for Git and no-profile/no-rc Bash plus sh/grep.
  Its PATH contains only that installation's cmd/usr/bin. Startup injection
  variables/exported Bash functions are sanitized **only for these probes**.
- `GitSelection::discover(path: &OsStr, roots: &[PathBuf], token: &CancelToken)
  -> Result<Option<GitSelection>, String>` checks PATH-derived candidates, then
  caller-supplied known roots. Results are external (`managed=false`). Caller
  supplies conventional install roots if desired; no registry/global edits.
- `Selection::prefix_bin()` returns flat Windows prefix, POSIX prefix/bin.
  Existing `path`/`apply` prepend selected Node, prefix and same-root Git tools;
  Windows does not create symlinks. `apply` sets child-only PATH, CORTEX_HOME,
  npm prefix, CORTEX_GIT_BASH_PATH, MSYS2_PATH_TYPE=inherit and removes stale
  ORIGINAL_PATH. Windows environment keys are matched case-insensitively.
  Normal shell arguments/profile startup variables remain untouched.

### Exact scoped verification

Reused the existing harness target/cache with the already-installed local toolchain:

```sh
cd /home/fangxin/Cortex-wt-win-selection
export PATH=/home/fangxin/.cortex/data/windows-managed-runtime/decoder-gate/.rustup/toolchains/1.90.0-x86_64-unknown-linux-gnu/bin:$PATH
cargo test --manifest-path desktop/src-tauri/tests/runtime-harness/Cargo.toml --locked --offline --lib selection
for filter in \
  split_runtime_pins_both_tools_despite_competing_npm_and_changed_login_path \
  selected_node_and_private_prefix_precede_changing_login_path \
  private_install_is_direct_persisted_and_idempotent_without_external_overwrite \
  saved_runtime_executable_or_version_loss_is_missing_without_fallback \
  failed_initial_npm_install_can_retry_without_reselecting_runtime
do
  cargo test --manifest-path desktop/src-tauri/tests/runtime-harness/Cargo.toml --locked --offline --lib "$filter"
done
git diff --check
```

Results: **21 + 5 passed**, no ignored integration/download test or broad suite run.
Initial RED commands used the same cargo options with filters
`selection_windows_tests`, `git_selection_tests`, and `windows_npm_binding`;
these failed to compile on the missing helper APIs before implementation. Their
logs are `/tmp/win-selection-{layout,git,npm}-red.log`. Final selection log:
`/tmp/win-selection-policy-green.log`; each extra regression log is
`/tmp/win-selection-<filter>.log`. One added literal-argument test initially had
an incorrectly escaped expected newline; correcting that fixture expectation
is **not** claimed as a production RED regression. Owned Rust files were formatted
with `rustfmt --edition 2021 --config skip_children=true`; whitespace and focused
function/file length checks passed (functions <=30 lines, files <=800).

The Linux tests exercise actual shared source and local shell fixtures, including
selected-Node literal npm CLI arguments and the Git probe script. Linux-only
adapters model .exe lookup for the latter. They are **not** Windows npm/Bash,
profile PATH, Unicode process, no-window, cancellation or arm64 acceptance.

### Remaining parent wiring (outside this unit)

1. Bootstrap still uses strict `Selection::load`/Node-only selection. Use
   `read_saved` plus the repair/binding/probe APIs to upgrade old selections,
   discover/prepare full Git, set managed ownership explicitly, save only after
   qualification/cancellation checks, and reuse healthy saved identities. Repair
   missing external tools into a separate private installation, never overwrite
   their saved external paths. Managed Node ZIP/Git preparation is installer-owned.
2. `src/setup/runtime_install.rs:107` still contains the pre-existing
   `Command::new(&selected.npm)` prefix-discovery bypass. **Replace it with
   `selected.npm_command()` before Windows integration** (retain that query's
   intentional lack of private-prefix override). Also wire flat Windows server
   prefix/package CLI discovery. This file was explicitly out of ownership; no
   end-to-end no-bypass claim is made for the unfinished installer.
3. Integrate the other owner's Windows process/probe port and wire setup/process/
   optional Claude launchers to the selected environment. This worktree's existing
   Unix probe implementation was not ported or duplicated here. Parent owns actual
   Windows compilation/execution and normal-login-shell PATH verification.
4. No server/client/web/decoder duplication or main merge. Existing integrated
   base `6adc9ca58` and concurrent main `d9dee3a2d` were left untouched. Stop here;
   do not interpret these selection tests as a gate rerun or a new acceptance harness.

## Windows bootstrap/installer unit handoff (2026-10-08)

Status: **source implementation + focused Linux tests complete; Windows compilation,
execution and final shell entry wiring remain parent-owned**. Worktree
`/home/fangxin/Cortex-wt-win-bootstrap`, branch `cortex/win-bootstrap`, base
`1c43ac3e7915fd2bb7899237822c0d897ead413a`. Implementation commits:

- `fd892fb9c`: authenticated download/ZIP staging, Node pins, Windows tempfile.
- `c3cdbadb8`: repair-aware bootstrap and unchanged upstream post-install policy.
- `152de2a6d`: ZIP central-directory count/duplicate guard and bounded helper cleanup.
- `abdfbf89c`: selected npm prefix discovery, flat Windows server layout/Node binding.
- `7b4c50e33`: qualify existing private packages before reuse; native-safe test glue.

### Sources and contracts

Paths below are relative to `desktop/src-tauri/src/setup/`:

- `runtime.rs`: dispatches Windows bootstrap; existing `bootstrap`/`ensure_server`
  signatures unchanged. Adds backward-compatible optional `Server.node_entry`.
  `Server.bin` and `managed` retain original external identity/ownership;
  `Selection::command(server.bin)` launches selected Node + qualified package JS
  when `node_entry` is present. Consumers must use this command API, not construct
  a process directly from `server.bin` or infer launch mode solely from `managed`.
- `runtime_windows_bootstrap.rs`: reads saved identities with `read_saved`, uses
  `windows_repair_needs`, npm binding, `qualify_node`, and Git discover/qualify.
  Old Node-only selections gain Git. Healthy tools are reused; damaged saved tools
  get new private installations, never writes to their previous locations.
  Node repair preserves prefix/server/Git identities. Absent Git can be discovered
  externally; a damaged saved Git is repaired privately, not silently reselected.
- `runtime_windows_archive.rs`, `runtime_windows_download.rs`, `runtime_archive.rs`:
  exact Node v24.21.0 x64 ZIP pin/root, SHA verification, no Node redirects;
  150 MiB compressed / 1 GiB expanded / 40,000 ZIP entry bounds, pre-index count
  checks, no duplicate/unsafe/link/reparse members, create-new files and CRC checks.
  Git uses the specified full 60,027,568-byte official asset/hash, at most three
  HTTPS redirects from the exact asset to the two approved release CDN hosts.
  Shared tar/GZip functions and Unix permission tests are Unix-cfg-only; their
  behavior is retained. ARM64 Node data is metadata only: managed preparation
  explicitly requires x64. No arm64 Git support was invented.
- `runtime_windows_postinstall.rs`: only called after the existing
  `runtime_portablegit::extract_x64` authenticates/extracts the complete payload.
  Uses its in-memory cancellation callback unchanged. Runs the unchanged upstream
  batch via `git-bash.exe --no-needs-console --hide --no-cd
  --command=post-install.bat`, stage cwd, owned Windows `run` with 180s deadline.
  Only this child's environment is sanitized; HOME/XDG are attempt-private.
  Raw bounded stdout/stderr are inspected internally, never sent to the UI.
  Readiness checks cleanup, four network-file copies, DLL copies and real
  `dlls-copied.exe`, MSYS markers/mtab, plus absolute same-install Git/Bash probes.
  This is not a payload inventory/manifest rehash.
- `runtime_install.rs`, `runtime_windows_server.rs`: prefix discovery now uses
  `selected.npm_command()` **without** applying the private prefix override.
  Managed Windows CLI is `<prefix>/node_modules/@cortex-agent/server/dist/entry/cortex-cli.js`.
  Existing healthy private packages are reused; incomplete unselected packages
  can retry installation. Existing saved server identities are not replaced.
  Qualified external standard npm `.cmd` wrappers bind the actual package JS;
  arbitrary/custom `.cmd` or opaque `.exe` wrappers return
  `SERVER_EXTERNAL_AMBIGUOUS`, never falsely claim selected-Node identity or get
  overwritten. Legacy suffix discovery is retained; `process.rs` is untouched.

Attempt directories are fresh `runtime/node-v24.21.0-win-x64-*` and
`runtime/git-2.56.0.2-x64-*` directories. Fresh attempt guards remain armed through tool qualification and
selection persistence, retaining the exact tested paths (no rename onto an
existing install). Pre-publication failures/cancellation clean only these new
stages. Successful publication immediately disarms all guards before any further
cancellation check. Saved or external installations never receive cleanup guards;
subsequent server-install retries reuse the published tools.

**Locale handling — correction `104bc7b32`:** only a real upstream exit 1 can
trigger a 10-second owned calibration through the same authenticated
`stage/git-bash.exe`, hidden flags and sanitized child environment. A fresh
TempDir beneath private preparation HOME (canonicalized outside the payload)
contains a create-new `post-install.bat` with only `@DEL post-install.bat\r\n`.
The official batch/stage is never written or replayed. Calibration must exit 1,
produce empty stdout and 1–1024 nontruncated raw stderr bytes, and actually delete
its synthetic batch before those bytes can qualify the real stderr byte-for-byte.
Exact upstream stdout, cleanup/network/DLL/MSYS readiness and Git/Bash qualification
remain mandatory. Exit 0 requires clean diagnostics/readiness and never calibrates;
other exits, mismatches, timeouts, cancellation and truncation fail. Ordinary
`run_install` still rejects *every* nonzero exit. The mechanism derives current-system
diagnostics; **only the Chinese system has prior runtime evidence**, not empirical
coverage of other languages. Integrated Windows compilation/execution remains
parent-owned; original gate/evidence is unchanged and does not imply runtime PASS.

Correction status: source and **16 focused Linux fixture tests PASS**, no package
execution. `windows_postinstall::run(stage, home, token)` is unchanged; calibration
and validated opaque bytes are private to this module. RED: the English fixture
failed against the fixed allowlist (`/tmp/win-post-diagnostic-red.log`); construction
API tests then failed before implementation (`/tmp/win-post-diagnostic-api-red.log`).
GREEN log: `/tmp/win-post-diagnostic-green.log`. Tests cover raw mismatch, bounds,
stdout, deletion, cancellation/error propagation, exit-only calibration, private
artifacts, launcher/environment parity and retained readiness. Verification:

```sh
cd /home/fangxin/Cortex-wt-win-post-diagnostic
export PATH=/home/fangxin/.cortex/data/windows-managed-runtime/decoder-gate/.rustup/toolchains/1.90.0-x86_64-unknown-linux-gnu/bin:$PATH
cargo test --manifest-path desktop/src-tauri/tests/runtime-harness/Cargo.toml --locked --offline --lib windows_postinstall
git diff --check
```

Rust 1.90.0; owned files/functions remain <=800/<=30 lines. No remote action,
package rerun, full audit, dependency change or merge was performed.

### Exact scoped verification

```sh
cd /home/fangxin/Cortex-wt-win-bootstrap
export PATH=/home/fangxin/.cortex/data/windows-managed-runtime/decoder-gate/.rustup/toolchains/1.90.0-x86_64-unknown-linux-gnu/bin:$PATH
for filter in \
  windows_archive windows_postinstall windows_bootstrap windows_server \
  external_prefix_query reuse_private_windows \
  private_install_is_direct qualified_external_server failed_initial_npm \
  split_runtime saved_runtime_executable selected_node_and_private_prefix \
  runtime::archive release_targets cancelled_saved_runtime \
  cancellation_after_discovery cancelled_final_managed
do
  cargo test --manifest-path desktop/src-tauri/tests/runtime-harness/Cargo.toml \
    --locked --offline --lib "$filter"
done
cargo metadata --manifest-path desktop/src-tauri/Cargo.toml \
  --locked --offline --no-deps --format-version 1 >/dev/null
git diff --check
```

Results: **35 distinct tests passed, 0 failed** (22 installer/Windows policy and
13 nearest POSIX/archive/cancellation checks); metadata and whitespace passed.
Log: `desktop/src-tauri/tests/runtime-harness/target/bootstrap-verification.log`.
Important API tests initially failed before implementation; npm prefix binding
and raw ZIP duplicate-name regression additionally demonstrated assertion REDs.
RED logs: `/tmp/win-bootstrap-{archive,post,repair,server,prefix,zip-duplicate,reuse}-red.log`.
Tests use synthetic archives/files and disposable local shell fixtures, not real
packages or Windows emulation. Owned/new Rust functions are <=30 lines; files
are <=800. No full suite, product build/deploy, package execution, payload re-audit,
remote action, integration/main merge or prohibited-source change was performed.

### Parent-owned next steps (not performed here)

1. On actual Windows/MSVC, compile the exact shared runtime without Tauri using
   the five-line `tests/runtime-harness/tests/windows_bootstrap.rs` import target:
   `cargo check --manifest-path desktop/src-tauri/tests/runtime-harness/Cargo.toml --locked --test windows_bootstrap`.
   This Linux host has only the Linux Rust target; **Windows source compile/run
   acceptance remains unverified here**. New tar cfg guards and Windows tempfile
   dependency are in place. Product lock already contained tempfile, so no product
   lock change was necessary; unrelated harness lock versions are preserved.
2. Wire Windows setup/process/optional Claude entry points to `bootstrap`,
   `ensure_server`, `Selection::command` and `apply`. Respect `Server.node_entry`
   for external packages. Those shell-entry files and all selection/decoder/
   owned-process internals were deliberately left untouched.
3. Perform the planned native installer/cancellation/retry and fresh App checks;
   verify the actual pinned post-install stdout/SystemRoot spelling and locale.
   No broader exit-1 signature is authorized by these tests.
4. Preserve reader attribution at `src/setup/runtime_portablegit.rs` and
   `src/setup/runtime_portablegit/README.md`. The packaging owner must include
   `src/setup/runtime_portablegit/LICENSE-APACHE` with the native app, e.g. map it
   and the companion README to `licenses/portablegit-reader/` in Tauri bundle
   resources. Bundle/resource configuration is outside this unit's ownership.
   All Node/Git payload licenses/notices remain in the prepared installations.
