//! Only the pinned official Git asset may redirect, only to official release CDNs.
use super::CancelToken;
use sha2::{Digest, Sha256};
use std::{io::Write, time::Duration};

pub(super) const GIT_URL: &str = "https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/PortableGit-2.56.0.2-64-bit.7z.exe";
const GIT_SHA: &str = "075e158ef8e1f0ab80b347e245405d3eca735c2dc88fd8e032e137d0ca61f61b";
const GIT_SIZE: usize = 60_027_568;

pub(super) fn git_redirect_allowed(first: &reqwest::Url, next: &reqwest::Url, hops: usize) -> bool {
    first.as_str() == GIT_URL
        && hops <= 3
        && next.scheme() == "https"
        && next.username().is_empty()
        && next.password().is_none()
        && next.port_or_known_default() == Some(443)
        && matches!(
            next.host_str(),
            Some("release-assets.githubusercontent.com" | "objects.githubusercontent.com")
        )
}

fn client() -> Result<reqwest::Client, String> {
    super::archive::http_builder()?
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let allowed = attempt
                .previous()
                .first()
                .is_some_and(|first| git_redirect_allowed(first, attempt.url(), attempt.previous().len()));
            if allowed {
                attempt.follow()
            } else {
                attempt.error("unapproved Git redirect")
            }
        }))
        .build()
        .map_err(super::archive::download_error)
}

pub(super) fn download_git(file: &mut std::fs::File, token: &CancelToken) -> Result<(), String> {
    token.check()?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(super::archive::download_error)?;
    let result = runtime.block_on(async {
        tokio::select! {
            result = chunks(file) => result,
            _ = super::archive::wait_cancel(token) => Err("SETUP_CANCELLED".into()),
        }
    });
    token.check()?;
    result
}

async fn chunks(file: &mut std::fs::File) -> Result<(), String> {
    let mut response = client()?
        .get(GIT_URL)
        .timeout(Duration::from_secs(300))
        .send()
        .await
        .map_err(super::archive::download_error)?
        .error_for_status()
        .map_err(super::archive::download_error)?;
    let mut size = 0;
    let mut hash = Sha256::new();
    while let Some(chunk) = response.chunk().await.map_err(super::archive::download_error)? {
        size += chunk.len();
        if size > GIT_SIZE {
            return Err("RUNTIME_INTEGRITY_FAILED: Git size limit".into());
        }
        hash.update(&chunk);
        file.write_all(&chunk).map_err(super::archive::download_error)?;
    }
    if size != GIT_SIZE {
        return Err("RUNTIME_INTEGRITY_FAILED: Git size mismatch".into());
    }
    super::archive::verify_digest(&format!("{:x}", hash.finalize()), GIT_SHA)
}
