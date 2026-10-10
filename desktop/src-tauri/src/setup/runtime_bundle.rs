//! Runtime archives shipped inside the app (`<resources>/runtime`, staged at build time by
//! desktop/scripts/fetch-bundled-runtime.mjs) and their extraction into `<home>/runtime/<root>`.
//! A versioned directory that still runs is reused; a missing or broken one is unpacked again.
use super::{CancelToken, GitSelection};
use serde::Deserialize;
use std::{
    fs::File,
    io::BufReader,
    path::{Component, Path, PathBuf},
    process::Command,
    time::Duration,
};

pub const NOT_BUNDLED: &str = "RUNTIME_NOT_BUNDLED: this build does not include its runtime";

#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub node: Archive,
    #[serde(default)]
    pub git: Option<Archive>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Archive {
    pub version: String,
    /// File name beside manifest.json.
    pub archive: String,
    /// Top-level folder inside the archive; also the directory name under `<home>/runtime`.
    pub root: String,
}

impl Manifest {
    pub fn load(bundle: &Path) -> Result<Self, String> {
        let bytes = std::fs::read(bundle.join("manifest.json")).map_err(|_| NOT_BUNDLED.to_string())?;
        let manifest: Self = serde_json::from_slice(&bytes).map_err(|_| NOT_BUNDLED.to_string())?;
        let names = [Some(&manifest.node), manifest.git.as_ref()]
            .into_iter()
            .flatten()
            .flat_map(|a| [&a.archive, &a.root]);
        for name in names {
            if !matches!(Path::new(name).components().collect::<Vec<_>>()[..], [Component::Normal(_)]) {
                return Err(NOT_BUNDLED.into());
            }
        }
        Ok(manifest)
    }
}

/// Executables of an unpacked official Node distribution.
pub struct NodeLayout {
    pub node: PathBuf,
    pub npm: PathBuf,
    pub npm_cli: PathBuf,
}

impl NodeLayout {
    pub fn of(root: &Path) -> Self {
        if cfg!(windows) {
            Self {
                node: root.join("node.exe"),
                npm: root.join("npm.cmd"),
                npm_cli: root.join("node_modules/npm/bin/npm-cli.js"),
            }
        } else {
            Self {
                node: root.join("bin/node"),
                npm: root.join("bin/npm"),
                npm_cli: root.join("lib/node_modules/npm/bin/npm-cli.js"),
            }
        }
    }

    fn runs(&self, token: &CancelToken) -> Result<bool, String> {
        if !self.node.is_file() || !self.npm_cli.is_file() {
            return Ok(false);
        }
        Ok(super::probe::output(Command::new(&self.node), &["--version"], token)?.is_some())
    }
}

/// `<runtime>/<root>` holding a Node that runs, unpacking the bundled archive when needed.
pub fn ensure_node(
    manifest: &Manifest,
    bundle: &Path,
    runtime: &Path,
    token: &CancelToken,
    log: &impl Fn(&str),
) -> Result<PathBuf, String> {
    let root = runtime.join(&manifest.node.root);
    let layout = NodeLayout::of(&root);
    if layout.runs(token)? {
        return Ok(root);
    }
    log(&format!("Preparing bundled Node.js {}", manifest.node.version));
    unpack(bundle, &manifest.node, runtime, token, |_| Ok(()))?;
    if !fresh(|| layout.runs(token))? {
        return Err("RUNTIME_UNSUPPORTED: bundled Node.js cannot run on this system".into());
    }
    Ok(root)
}

/// `<runtime>/<root>` holding a usable Git Bash. PortableGit's own post-install runs once on a
/// fresh copy; its outcome is judged only by qualification afterwards.
pub fn ensure_git(
    archive: &Archive,
    bundle: &Path,
    runtime: &Path,
    token: &CancelToken,
    log: &impl Fn(&str),
    post_install: impl FnOnce(&Path, &CancelToken) -> Result<(), String>,
) -> Result<GitSelection, String> {
    let root = runtime.join(&archive.root);
    if let Some(git) = GitSelection::from_root(root.clone(), true) {
        if git.qualify(token)? {
            return Ok(git);
        }
    }
    log(&format!("Preparing bundled Git Bash {}", archive.version));
    unpack(bundle, archive, runtime, token, |stage| post_install(stage, token))?;
    let git = GitSelection::from_root(root, true)
        .ok_or("RUNTIME_MISSING: bundled Git Bash is incomplete")?;
    if !fresh(|| git.qualify(token))? {
        return Err("RUNTIME_MISSING: bundled Git Bash cannot run".into());
    }
    Ok(git)
}

/// A just-written executable can briefly refuse to start (Linux ETXTBSY while another thread
/// forks; a Windows scanner holding the file), so a fresh copy gets one more try.
fn fresh(check: impl Fn() -> Result<bool, String>) -> Result<bool, String> {
    if check()? {
        return Ok(true);
    }
    std::thread::sleep(Duration::from_millis(500));
    check()
}

fn unpack_error(e: impl std::fmt::Display) -> String {
    format!("RUNTIME_MISSING: bundled runtime could not be unpacked: {e}")
}

/// Extract into a private stage, prepare it there, then move it to its versioned directory.
fn unpack(
    bundle: &Path,
    archive: &Archive,
    runtime: &Path,
    token: &CancelToken,
    prepare: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let source = bundle.join(&archive.archive);
    if !source.is_file() {
        return Err(NOT_BUNDLED.into());
    }
    std::fs::create_dir_all(runtime).map_err(unpack_error)?;
    let stage = tempfile::Builder::new()
        .prefix(".stage-")
        .tempdir_in(runtime)
        .map_err(unpack_error)?;
    extract(&source, stage.path(), token)?;
    token.check()?;
    let unpacked = stage.path().join(&archive.root);
    if !unpacked.is_dir() {
        return Err(unpack_error("unexpected archive layout"));
    }
    prepare(&unpacked)?;
    token.check()?;
    replace_dir(&unpacked, &runtime.join(&archive.root), runtime)
}

fn replace_dir(from: &Path, to: &Path, runtime: &Path) -> Result<(), String> {
    let _old = if std::fs::symlink_metadata(to).is_ok() {
        let old = tempfile::Builder::new()
            .prefix(".old-")
            .tempdir_in(runtime)
            .map_err(unpack_error)?;
        std::fs::rename(to, old.path().join("dir")).map_err(unpack_error)?;
        Some(old) // removed on return
    } else {
        None
    };
    // A scanner may still hold a just-written file briefly on Windows.
    let mut attempt = 0;
    loop {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(_) if attempt < 10 => attempt += 1,
            Err(e) => return Err(unpack_error(e)),
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

fn extract(source: &Path, stage: &Path, token: &CancelToken) -> Result<(), String> {
    std::fs::create_dir_all(stage).map_err(unpack_error)?;
    let name = source.to_string_lossy();
    #[cfg(unix)]
    if name.ends_with(".tar.gz") {
        return extract_tar_gz(source, stage, token);
    }
    if name.ends_with(".zip") {
        return extract_zip(source, stage, token);
    }
    #[cfg(any(windows, test))]
    if name.ends_with(".7z") {
        return extract_7z(source, stage, token);
    }
    Err(NOT_BUNDLED.into())
}

/// Only plain relative components: every entry stays inside the stage.
fn inside(stage: &Path, name: &str) -> Result<PathBuf, String> {
    let relative = Path::new(name);
    if name.is_empty() || relative.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(unpack_error(format!("entry outside the archive root: {name}")));
    }
    Ok(stage.join(relative))
}

#[cfg(unix)]
fn extract_tar_gz(source: &Path, stage: &Path, token: &CancelToken) -> Result<(), String> {
    let file = File::open(source).map_err(unpack_error)?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(BufReader::new(file)));
    archive.set_preserve_permissions(false); // keeps executable bits, drops setuid/setgid
    for entry in archive.entries().map_err(unpack_error)? {
        token.check()?;
        let mut entry = entry.map_err(unpack_error)?;
        if !entry.unpack_in(stage).map_err(unpack_error)? {
            return Err(unpack_error("entry outside the archive root"));
        }
    }
    Ok(())
}

fn extract_zip(source: &Path, stage: &Path, token: &CancelToken) -> Result<(), String> {
    let file = File::open(source).map_err(unpack_error)?;
    let mut archive = zip::ZipArchive::new(BufReader::new(file)).map_err(unpack_error)?;
    for index in 0..archive.len() {
        token.check()?;
        let mut entry = archive.by_index(index).map_err(unpack_error)?;
        let name = entry.name().trim_end_matches('/').to_string();
        let target = inside(stage, &name)?;
        if entry.is_dir() {
            std::fs::create_dir_all(&target).map_err(unpack_error)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(unpack_error)?;
        }
        let mut output = File::create(&target).map_err(unpack_error)?;
        std::io::copy(&mut entry, &mut output).map_err(unpack_error)?;
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn extract_7z(source: &Path, stage: &Path, token: &CancelToken) -> Result<(), String> {
    let file = File::open(source).map_err(unpack_error)?;
    let mut archive = sevenz_rust2::ArchiveReader::new(BufReader::new(file), sevenz_rust2::Password::empty())
        .map_err(unpack_error)?;
    let mut failure = None;
    archive
        .for_each_entries(|entry, input| {
            if token.check().is_err() {
                return Ok(false);
            }
            let written = inside(stage, &entry.name().replace('\\', "/")).and_then(|target| {
                if entry.is_directory() {
                    return std::fs::create_dir_all(&target).map_err(unpack_error);
                }
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent).map_err(unpack_error)?;
                }
                let mut output = File::create(&target).map_err(unpack_error)?;
                std::io::copy(input, &mut output).map(drop).map_err(unpack_error)
            });
            match written {
                Ok(()) => Ok(true),
                Err(e) => {
                    failure = Some(e);
                    Ok(false)
                }
            }
        })
        .map_err(unpack_error)?;
    token.check()?;
    failure.map_or(Ok(()), Err)
}

#[cfg(all(test, unix))]
#[path = "runtime_bundle_tests.rs"]
mod tests;
