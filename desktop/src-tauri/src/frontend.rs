// input:  custom-scheme URLs, frontend root, embedded shell assets
// output: sanitized paths and embedded/OTA asset responses
// pos:    Resolves standalone setup assets and workbench files
// >>> If I am updated, update my header comment and CORTEX.md <<<

use std::path::Path;

const INDEX: &str = "index.html";

/// Binary-embedded shell pages stay reachable regardless of seed/OTA state. Their source keeps the
/// same `/theme.css` link used in dev; the embedded response replaces that link with the canonical
/// palette so a missing or older OTA bundle cannot leave shell pages unstyled. Normal SPA requests
/// still resolve `theme.css` from the active frontend directory, preserving OTA token updates.
const EMBEDDED_ASSETS: &[(&str, &str)] = &[
    ("connect.html", include_str!("../../ui/connect.html")),
    ("setup.html", include_str!("../../ui/setup.html")),
    ("shell.css", include_str!("../../ui/shell.css")),
    ("shell.js", include_str!("../../ui/shell.js")),
    ("connect.js", include_str!("../../ui/connect.js")),
    ("setup-flow.js", include_str!("../../ui/setup-flow.js")),
    ("setup.js", include_str!("../../ui/setup.js")),
];
const THEME_LINK: &str = r#"<link rel="stylesheet" href="/theme.css">"#;
const SHARED_THEME: &str = include_str!("../../../web/public/theme.css");

fn inject_shell_theme(page: &str) -> Vec<u8> {
    page.replacen(THEME_LINK, &format!("<style>{SHARED_THEME}</style>"), 1)
        .into_bytes()
}

/// Serve a binary-embedded shell page before consulting the active frontend directory.
pub fn resolve_embedded(raw_url: &str) -> Option<ResolvedAsset> {
    let rel = sanitize_request_path(raw_url)?;
    let (path, body) = EMBEDDED_ASSETS.iter().find(|(name, _)| *name == rel)?;
    Some(ResolvedAsset {
        status: 200,
        mime: content_type(path),
        body: if path.ends_with(".html") {
            inject_shell_theme(body)
        } else {
            body.as_bytes().to_vec()
        },
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
        let dir: PathBuf =
            std::env::temp_dir().join(format!("cortex-fe-{}-{}", std::process::id(), n));
        fs::create_dir_all(&dir).unwrap();
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| body(&dir)));
        let _ = fs::remove_dir_all(&dir);
        if let Err(e) = res {
            std::panic::resume_unwind(e);
        }
    }

    #[test]
    fn sanitize_root_maps_to_index() {
        assert_eq!(
            sanitize_request_path("cortexui://localhost/").unwrap(),
            "index.html"
        );
        assert_eq!(sanitize_request_path("/").unwrap(), "index.html");
        assert_eq!(
            sanitize_request_path("cortexui://localhost").unwrap(),
            "index.html"
        );
    }

    #[test]
    fn sanitize_keeps_normal_paths_and_strips_query() {
        assert_eq!(
            sanitize_request_path("cortexui://localhost/index.html").unwrap(),
            "index.html"
        );
        assert_eq!(
            sanitize_request_path("/assets/app.js?v=123").unwrap(),
            "assets/app.js"
        );
        assert_eq!(
            sanitize_request_path("cortexui://localhost/a/b/c.css#frag").unwrap(),
            "a/b/c.css"
        );
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
            let html = String::from_utf8(r.body).unwrap();
            assert!(html.contains("--browser-theme-color"));
            assert!(!html.contains(THEME_LINK));
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

    #[test]
    fn resolve_embedded_serves_setup_dependencies_without_a_server() {
        for name in [
            "shell.css",
            "shell.js",
            "connect.js",
            "setup-flow.js",
            "setup.js",
        ] {
            let asset = resolve_embedded(&format!("cortexui://localhost/{name}")).unwrap();
            assert_eq!(asset.status, 200);
            assert_eq!(asset.mime, content_type(name));
            assert!(!asset.body.is_empty());
        }
    }

    #[test]
    fn resolve_embedded_ignores_non_connect_paths() {
        assert!(super::resolve_embedded("cortexui://localhost/index.html").is_none());
        assert!(super::resolve_embedded("cortexui://localhost/").is_none());
        assert!(super::resolve_embedded("/assets/app.js").is_none());
        assert!(super::resolve_embedded("/theme.css").is_none());
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
