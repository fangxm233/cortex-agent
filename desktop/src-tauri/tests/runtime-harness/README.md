# Native onboarding runtime tests (no Tauri window)

This crate compiles the **same** `src/setup/runtime*.rs` the desktop install command uses, without
Tauri, GTK, WebKit, or a display. Fixtures build small bundle directories (a `manifest.json` plus a
Node-layout `.tar.gz` whose `node` and `npm-cli.js` are shell scripts), so the normal suite needs no
network, Node, npm, or Git.

```sh
cargo test --manifest-path desktop/src-tauri/tests/runtime-harness/Cargo.toml --locked
```

`tests/shell_wiring.rs` checks how the Tauri commands call into the runtime;
`tests/windows_runtime.rs` compiles the runtime with Windows `cfg` (useful as
`cargo check --target x86_64-pc-windows-msvc --test windows_runtime` from Linux).

## What the runtime does

- **Bundle**: `<resources>/runtime` holds `manifest.json`, the official Node archive, and on
  Windows a repacked PortableGit `.7z`, staged at build time by
  `desktop/scripts/fetch-bundled-runtime.mjs --target <triple>`.
- **Unpack**: `ensure_runtime` extracts each archive into a private stage under
  `<home>/runtime`, runs PortableGit's post-install there on Windows (result ignored), and moves
  it to `<home>/runtime/<root>`. A directory that still runs (`node --version`; git and bash for
  Git) is reused; a missing or broken one is unpacked again.
- **Record**: `<home>/runtime/selection.json` always points at the bundled tools; any older
  record is rewritten, keeping only its server.
- **Server**: `ensure_server` keeps a saved server that reports a supported version; otherwise it
  runs the bundled npm `install -g --prefix <home>/runtime/prefix` and checks again.

## Opt-in real runs

Unpack a real staged bundle on this host (a Windows bundle works on Linux too):

```sh
CORTEX_BUNDLE_TEST_DIR=/abs/staged/bundled-runtime \
cargo test --manifest-path desktop/src-tauri/tests/runtime-harness/Cargo.toml --release \
  real_bundle_archives_unpack_in_process -- --ignored --nocapture
```

Unpack a staged bundle for this host and install a server package for real (registry access
required for its dependencies; HOME and npm config are isolated inside the test process):

```sh
CORTEX_RUNTIME_TEST_HOME=/abs/new-isolated-home \
CORTEX_RUNTIME_TEST_BUNDLE=/abs/staged/bundled-runtime \
CORTEX_RUNTIME_TEST_PACKAGE=/abs/server.tgz \
cargo test --manifest-path desktop/src-tauri/tests/runtime-harness/Cargo.toml \
  isolated_real_bundle_and_install -- --ignored --nocapture
```
