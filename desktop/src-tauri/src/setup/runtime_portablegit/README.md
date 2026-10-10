# Qualified PortableGit x64 reader

The native Windows setup uses this bounded reader to extract the pinned official
PortableGit package without running its self-extracting executable. The headless
harness compiles `../runtime_portablegit.rs` directly. Source provenance:
qualified helper `b0b7fdf9848cd73e0cf5e0b37037379daef04251`, registry decoder unchanged.

## Contract

```rust,ignore
let token = native_cancel_token.clone();
let cancellation = Cancellation::new(move || token.check().is_err());
let summary = extract_x64(archive_path, fresh_destination_path, cancellation)?;
```

- Blocking, in-process reader of **PortableGit-2.56.0.2-64-bit.7z.exe only**.
  Artifact size: 60,027,568 bytes; embedded 7z offset: 251,392 bytes;
  SHA-256: `075e158ef8e1f0ab80b347e245405d3eca735c2dc88fd8e032e137d0ca61f61b`.
  No architecture auto-detection or arm64 qualification is implied.
- Authenticate an immutable full snapshot before parsing. Retain start/next-header
  CRC and bounds checks, path/case/alias/link/reparse guards, fresh-root/create-new
  semantics, entry/file/total limits, six-solid-block and LZMA/Delta/BCJ2 guards,
  qualified dictionary allocation bounds, decoded sizes/CRCs and final totals.
- Extract every entry, including all licenses, notices, package records and the
  unchanged upstream post-install. **Nothing is executed**, filtered or patched.
- Destination must not exist; its existing parent/ancestors must be trusted and
  not writable by adversaries. Ancestor checks do not promise race resistance in
  an attacker-writable directory. No automatic deletion, reuse or promotion.
- `Summary`: authenticated hash, offset, absolute destination, file/directory
  counts, total bytes. No per-file hash inventory, CLI or audit report.
- `Cancellation`: cloneable, `Send + Sync`, callback `Fn() -> bool + Send + Sync +
  'static`. Callback must be fast/nonblocking and must not panic. Observed true is
  latched across clones. Checked before archive open, during authentication and
  decoder read/seek, before entries and between output chunks, and before success.
  Cooperative cancellation does not interrupt a pending OS call or CPU operation.
- `ExtractionError::Cancelled` displays `SETUP_CANCELLED`; `Failed(io::Error)`
  retains I/O or decoder/validation context through `Display`/`Error::source`.
  Any failure may leave partial output, owned by the caller. Retry needs a fresh
  destination and fresh cancellation callback/token.

## Dependencies and attribution

Both native and harness manifests require Rust **1.90**; no MSRV override, vendor
patch or rejected sevenz-rust2 0.23 is used. Added decoder dependencies are
Windows-only in the native manifest (headless harness has its own dependencies).

- [`sevenz-rust2` 0.20.2](https://crates.io/crates/sevenz-rust2/0.20.2):
  Apache-2.0, maintained fork of sevenz-rust. `default-features = false`:
  no encoder, utility extractor, AES or optional codecs.
- [`lzma-rust2` 0.16.5](https://crates.io/crates/lzma-rust2/0.16.5):
  Apache-2.0, maintained fork of lzma-rust, ported from Tukaani XZ for Java.
  Only `std` and `optimization`, as enabled by the qualified sevenz dependency.
  The direct exact pin keeps the allocation-bound assumption from floating.
- The identical Apache-2.0 license supplied by both decoder crates is retained
  in [`LICENSE-APACHE`](LICENSE-APACHE); include it with native redistribution.
- Existing `sha2` 0.10.9 (MIT OR Apache-2.0) authenticates the complete SFX;
  `crc32fast` 1.5.0 (MIT OR Apache-2.0) verifies headers and decoded files.
  Native already locked CRC 1.5.0; harness CRC is aligned from 1.5.2 to 1.5.0.
  Other existing lockfile versions are preserved. No dependency audit is rerun.

## Native integration

Windows setup downloads the pinned archive into a fresh user-local attempt,
passes its cancellation token to the reader, then runs the unchanged hidden
upstream post-install separately. Readiness and functional probes must succeed
before the selected identities are published. Failed attempts clean only their
own staging directories; existing installations are not overwritten.

The native app bundles this attribution and `LICENSE-APACHE` under
`licenses/portablegit-reader/`. Node and Git retain their own complete payload
licenses and notices. Extraction alone is not evidence of an initialized Git/Bash
installation; full native application acceptance is tracked separately.
