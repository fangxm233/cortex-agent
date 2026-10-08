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
