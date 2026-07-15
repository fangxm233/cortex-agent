// Embedded frontend seed (Android only).
//
// Desktop resolves its first-run / offline frontend from `resource_dir/frontend-seed` — real files
// staged by `bundle.resources`. Android can't: its bundled assets live inside the read-only APK and
// are NOT std::fs-readable regular files, which is exactly what the `cortexui://` disk resolver
// (frontend.rs) needs. So on Android we compile the built SPA into the binary with `include_dir!`
// and materialize it onto disk (`<appDataDir>/ui/current`) on first run, giving the resolver a
// single stable on-disk origin for the app's whole life (seed → OTA-updated versions alike).
//
// The embedded path is `web/dist`, so `pnpm --filter web build` must run before the Android build
// (already required by the documented build order in desktop/CORTEX.md).

use include_dir::{include_dir, Dir};
use std::io;
use std::path::Path;

static SEED: Dir = include_dir!("$CARGO_MANIFEST_DIR/../../web/dist");

/// Materialize the embedded SPA seed into `dest` when it lacks an index.html (first run / after a
/// wipe). Returns Ok(true) when the seed was written, Ok(false) when `dest` already had a frontend.
/// Deliberately does not write a `current.version` sentinel: the seed's version is unknown, so the
/// first online OTA check always stages the server's version, which then promotes on next launch.
pub fn ensure_seed(dest: &Path) -> io::Result<bool> {
    if dest.join("index.html").is_file() {
        return Ok(false);
    }
    std::fs::create_dir_all(dest)?;
    SEED.extract(dest)?;
    Ok(true)
}
