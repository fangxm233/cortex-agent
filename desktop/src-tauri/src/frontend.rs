// Frontend asset resolver for the OTA custom protocol (cortexui://).
//
// Pure, dependency-free logic that maps a custom-scheme request URL to a file under a frontend
// root directory, mirroring the server's serveSpaStub: percent-decode, path-traversal guard, MIME
// by extension, and SPA fallback to index.html for unknown routes. The Tauri scheme handler in
// lib.rs is a thin wrapper over resolve_asset; keeping the decision logic here makes it unit-testable
// without a running webview.

use std::path::Path;

const INDEX: &str = "index.html";

/// Binary-embedded local pages. These are desktop/mobile-shell artifacts — they are NOT part of the
/// server-delivered OTA bundle (the server only builds the SPA), so resolving them from the active
/// frontend dir fails whenever an OTA frontend is active. That left the connection screen unreachable
/// (it SPA-fell-back to index.html → a workbench with no server config → blank "can't connect"), and
/// bricked the app after a disconnect. Serving them from an embedded copy makes them reachable
/// regardless of seed/OTA state, on both platforms — and the setup wizard, which by definition runs
/// before any server exists, could not work any other way.
///
/// Source of truth is `desktop/ui/*.html` (also staged into web/dist by `copy-connect` for dev/OTA
/// parity).
const EMBEDDED_PAGES: &[(&str, &str)] = &[
    ("connect.html", include_str!("../../ui/connect.html")),
    ("setup.html", include_str!("../../ui/setup.html")),
];

/// Serve a binary-embedded local page, bypassing the on-disk frontend dir entirely. Returns `Some`
/// when the request targets such a page, `None` otherwise (the normal on-disk `resolve_asset` path
/// then applies).
pub fn resolve_embedded(raw_url: &str) -> Option<ResolvedAsset> {
    let rel = sanitize_request_path(raw_url)?;
    let (path, html) = EMBEDDED_PAGES.iter().find(|(name, _)| *name == rel)?;
    Some(ResolvedAsset {
        status: 200,
        mime: content_type(path),
        body: html.as_bytes().to_vec(),
    })
}

/// The outcome of resolving one asset request: an HTTP-like status, a MIME type, and the body bytes.
pub struct ResolvedAsset {
    pub status: u16,
    pub mime: &'static str,
    pub body: Vec<u8>,
}

/// Map a file extension (taken from `path`) to a Content-Type. Unknown → octet-stream.
pub fn content_type(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Percent-decode a path string. Returns None on malformed escapes or non-UTF-8 output.
fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let h = hex_val(bytes[i + 1])?;
            let l = hex_val(bytes[i + 2])?;
            out.push((h << 4) | l);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Extract and normalize the path component of a custom-scheme request URL into a clean
/// root-relative path (e.g. "index.html", "assets/app.js"). "/" maps to index.html.
/// Returns None on malformed percent-encoding or any path-traversal attempt.
pub fn sanitize_request_path(raw_url: &str) -> Option<String> {
    // Strip an optional "scheme://host" prefix, keeping the leading '/path'.
    let after_authority = match raw_url.find("://") {
        Some(i) => {
            let rest = &raw_url[i + 3..];
            match rest.find('/') {
                Some(j) => &rest[j..],
                None => "/",
            }
        }
        None => raw_url,
    };
    // Drop query string and fragment.
    let path_only = after_authority.split(['?', '#']).next().unwrap_or("/");
    let decoded = percent_decode(path_only)?;

    let mut parts: Vec<&str> = Vec::new();
    for seg in decoded.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return None; // traversal
        }
        if seg.contains('\\') || seg.contains('\0') {
            return None; // backslash separators / NUL are rejected
        }
        parts.push(seg);
    }
    if parts.is_empty() {
        return Some(INDEX.to_string());
    }
    Some(parts.join("/"))
}

/// Resolve an asset request against `root`, with SPA fallback to index.html for unknown routes.
/// - malformed / traversal  → 400
/// - existing file          → 200 + its bytes + MIME
/// - unknown route          → 200 + index.html (SPA client-side routing)
/// - index.html also absent → 404
pub fn resolve_asset(root: &Path, raw_url: &str) -> ResolvedAsset {
    let rel = match sanitize_request_path(raw_url) {
        Some(r) => r,
        None => {
            return ResolvedAsset {
                status: 400,
                mime: "text/plain; charset=utf-8",
                body: b"Bad request".to_vec(),
            }
        }
    };

    let target = root.join(&rel);
    if let Ok(meta) = std::fs::metadata(&target) {
        if meta.is_file() {
            if let Ok(bytes) = std::fs::read(&target) {
                return ResolvedAsset {
                    status: 200,
                    mime: content_type(&rel),
                    body: bytes,
                };
            }
        }
    }

    match std::fs::read(root.join(INDEX)) {
        Ok(bytes) => ResolvedAsset {
            status: 200,
            mime: content_type(INDEX),
            body: bytes,
        },
        Err(_) => ResolvedAsset {
            status: 404,
            mime: "text/plain; charset=utf-8",
            body: b"Not found".to_vec(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// Create a unique temp dir, run `body`, then clean it up.
    fn with_tmp(body: impl FnOnce(&Path)) {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir: PathBuf = std::env::temp_dir().join(format!("cortex-fe-{}-{}", std::process::id(), n));
        fs::create_dir_all(&dir).unwrap();
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| body(&dir)));
        let _ = fs::remove_dir_all(&dir);
        if let Err(e) = res {
            std::panic::resume_unwind(e);
        }
    }

    #[test]
    fn content_type_maps_common_extensions() {
        assert_eq!(content_type("index.html"), "text/html; charset=utf-8");
        assert_eq!(content_type("assets/app.js"), "text/javascript; charset=utf-8");
        assert_eq!(content_type("style.css"), "text/css; charset=utf-8");
        assert_eq!(content_type("data.json"), "application/json; charset=utf-8");
        assert_eq!(content_type("logo.svg"), "image/svg+xml");
        assert_eq!(content_type("font.woff2"), "font/woff2");
        assert_eq!(content_type("noext"), "application/octet-stream");
    }

    #[test]
    fn sanitize_root_maps_to_index() {
        assert_eq!(sanitize_request_path("cortexui://localhost/").unwrap(), "index.html");
        assert_eq!(sanitize_request_path("/").unwrap(), "index.html");
        assert_eq!(sanitize_request_path("cortexui://localhost").unwrap(), "index.html");
    }

    #[test]
    fn sanitize_keeps_normal_paths_and_strips_query() {
        assert_eq!(sanitize_request_path("cortexui://localhost/index.html").unwrap(), "index.html");
        assert_eq!(sanitize_request_path("/assets/app.js?v=123").unwrap(), "assets/app.js");
        assert_eq!(sanitize_request_path("cortexui://localhost/a/b/c.css#frag").unwrap(), "a/b/c.css");
    }

    #[test]
    fn sanitize_rejects_traversal_and_backslash() {
        assert!(sanitize_request_path("cortexui://localhost/../etc/passwd").is_none());
        assert!(sanitize_request_path("/a/../../b").is_none());
        assert!(sanitize_request_path("/a\\b").is_none());
    }

    #[test]
    fn sanitize_rejects_malformed_percent_encoding() {
        assert!(sanitize_request_path("/%ZZ").is_none());
        assert!(sanitize_request_path("/%FF").is_none()); // 0xFF is not valid UTF-8
        assert!(sanitize_request_path("/%2").is_none()); // truncated escape
    }

    #[test]
    fn resolve_serves_an_existing_file_with_mime() {
        with_tmp(|dir| {
            fs::write(dir.join("index.html"), b"<html>ROOT</html>").unwrap();
            fs::create_dir_all(dir.join("assets")).unwrap();
            fs::write(dir.join("assets/app.js"), b"console.log(1)").unwrap();
            let r = resolve_asset(dir, "cortexui://localhost/assets/app.js");
            assert_eq!(r.status, 200);
            assert_eq!(r.mime, "text/javascript; charset=utf-8");
            assert_eq!(r.body, b"console.log(1)");
        });
    }

    #[test]
    fn resolve_falls_back_to_index_for_unknown_route() {
        with_tmp(|dir| {
            fs::write(dir.join("index.html"), b"<html>SPA</html>").unwrap();
            let r = resolve_asset(dir, "cortexui://localhost/some/client/route");
            assert_eq!(r.status, 200);
            assert_eq!(r.mime, "text/html; charset=utf-8");
            assert_eq!(r.body, b"<html>SPA</html>");
        });
    }

    #[test]
    fn resolve_404_when_index_absent() {
        with_tmp(|dir| {
            let r = resolve_asset(dir, "cortexui://localhost/missing.js");
            assert_eq!(r.status, 404);
        });
    }

    #[test]
    fn resolve_embedded_serves_connect_html_regardless_of_dir() {
        // connect.html is served from the binary, so it does not depend on any on-disk frontend dir.
        for url in [
            "cortexui://localhost/connect.html",
            "http://cortexui.localhost/connect.html",
            "/connect.html?x=1",
        ] {
            let r = super::resolve_embedded(url).expect("connect.html must resolve from embed");
            assert_eq!(r.status, 200);
            assert_eq!(r.mime, "text/html; charset=utf-8");
            assert!(!r.body.is_empty());
        }
    }

    #[test]
    fn resolve_embedded_serves_the_setup_wizard() {
        // The wizard is a shell page too — it must be reachable before any frontend exists on disk.
        let r = super::resolve_embedded("cortexui://localhost/setup.html")
            .expect("setup.html must resolve from embed");
        assert_eq!(r.status, 200);
        assert_eq!(r.mime, "text/html; charset=utf-8");
        assert!(!r.body.is_empty());
    }

    /// Collect the argument of every `f('literal')` call in `source` for the given function name.
    fn call_literals(source: &str, call: &str) -> Vec<String> {
        let mut found = Vec::new();
        let needle = format!("{call}('");
        let mut rest = source;
        while let Some(at) = rest.find(&needle) {
            rest = &rest[at + needle.len()..];
            if let Some(end) = rest.find('\'') {
                found.push(rest[..end].to_string());
            }
        }
        found
    }

    #[test]
    fn every_element_a_shell_page_looks_up_actually_exists_in_it() {
        // These pages carry their own script with no build step and no framework, so a renamed id is
        // a silent `null` at runtime — on the one screen a user cannot get past.
        for (name, html) in EMBEDDED_PAGES {
            let mut ids = call_literals(html, "getElementById");
            ids.extend(call_literals(html, "el"));
            for id in ids {
                // A literal ending in `-` is a prefix concatenated with an index at runtime
                // (`cx-panel-` + 0..3), so only the prefix can be checked.
                let expected = if id.ends_with('-') {
                    format!("id=\"{id}")
                } else {
                    format!("id=\"{id}\"")
                };
                assert!(
                    html.contains(&expected),
                    "{name} looks up #{id}, which it never defines"
                );
            }
        }
    }

    #[test]
    fn every_string_a_shell_page_uses_is_translated_in_both_languages() {
        // Each page holds an en and a zh table; a key added to one and not the other renders as
        // `undefined` for half the users, which no type checker here would catch.
        for (name, html) in EMBEDDED_PAGES {
            let mut keys: Vec<&str> = Vec::new();
            let mut rest = *html;
            while let Some(at) = rest.find("L.") {
                rest = &rest[at + 2..];
                let end = rest
                    .find(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                    .unwrap_or(rest.len());
                if end > 0 {
                    keys.push(&rest[..end]);
                }
            }
            keys.sort_unstable();
            keys.dedup();
            for key in keys {
                let defined = html.matches(&format!("{key}: ")).count();
                assert!(
                    defined >= 2,
                    "{name} uses L.{key} but defines it {defined} time(s) — both en and zh need it"
                );
            }
        }
    }

    #[test]
    fn resolve_embedded_ignores_non_connect_paths() {
        assert!(super::resolve_embedded("cortexui://localhost/index.html").is_none());
        assert!(super::resolve_embedded("cortexui://localhost/").is_none());
        assert!(super::resolve_embedded("/assets/app.js").is_none());
    }

    #[test]
    fn resolve_400_on_traversal() {
        with_tmp(|dir| {
            fs::write(dir.join("index.html"), b"x").unwrap();
            let r = resolve_asset(dir, "cortexui://localhost/../../etc/passwd");
            assert_eq!(r.status, 400);
        });
    }
}
