//! Repair never writes into an existing tool installation. Each managed attempt owns
//! a fresh private directory until selection publication retains its qualified identity.
use super::{CancelToken, GitSelection, Selection};
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};

#[cfg(windows)]
pub(super) fn bootstrap(
    home: &Path,
    path: &OsStr,
    floor: &str,
    token: &CancelToken,
    log: &impl Fn(&str),
) -> Result<Selection, String> {
    token.check()?;
    let mut selected = match Selection::read_saved(home)? {
        Some(saved) => saved,
        None => super::external_runtime(home, path, floor, token)?.unwrap_or_else(|| {
            Selection::new(PathBuf::new(), PathBuf::new(), home.join("runtime/prefix"))
        }),
    };
    let mut attempts = Vec::new();
    repair_node(&mut selected, home, path, floor, token, || {
        prepare_node(home, path, floor, token, log, &mut attempts)
    })?;
    let saved_git = selected.git.is_some();
    repair_git(&mut selected, token, || {
        select_git(home, path, saved_git, token, log, &mut attempts)
    })?;
    publish(selected, attempts, token, |selected| selected.save(home))
}

fn publish(
    selected: Selection,
    attempts: Vec<tempfile::TempDir>,
    token: &CancelToken,
    save: impl FnOnce(&Selection) -> Result<(), String>,
) -> Result<Selection, String> {
    selected.validate()?;
    token.check()?;
    save(&selected)?;
    // Publication commits these exact paths. Disarm every new guard before any
    // further cancellation/error return; saved/external paths never have guards.
    for attempt in attempts {
        let _ = attempt.keep();
    }
    token.check()?;
    Ok(selected)
}

fn repair_node(
    selected: &mut Selection,
    home: &Path,
    path: &OsStr,
    floor: &str,
    token: &CancelToken,
    prepare: impl FnOnce() -> Result<Selection, String>,
) -> Result<(), String> {
    token.check()?;
    let missing = selected.windows_repair_needs().node;
    if !missing
        && selected.qualify_windows_npm()
        && selected.qualify_node(home, path, floor, token)?
    {
        return Ok(());
    }
    let replacement = prepare()?;
    token.check()?;
    selected.node = replacement.node;
    selected.npm = replacement.npm;
    selected.npm_cli = replacement.npm_cli;
    selected.node_managed = replacement.node_managed;
    Ok(())
}

fn repair_git(
    selected: &mut Selection,
    token: &CancelToken,
    prepare: impl FnOnce() -> Result<GitSelection, String>,
) -> Result<(), String> {
    token.check()?;
    if !selected.windows_repair_needs().git {
        if selected.git.as_ref().unwrap().qualify(token)? {
            return Ok(());
        }
    }
    selected.git = Some(prepare()?);
    token.check()
}

#[cfg(windows)]
fn select_git(
    home: &Path,
    path: &OsStr,
    saved: bool,
    token: &CancelToken,
    log: &impl Fn(&str),
    attempts: &mut Vec<tempfile::TempDir>,
) -> Result<GitSelection, String> {
    if !saved {
        if let Some(git) = GitSelection::discover(path, &known_git_roots(), token)? {
            return Ok(git);
        }
    }
    prepare_git(home, token, log, attempts)
}

#[cfg(windows)]
fn known_git_roots() -> Vec<PathBuf> {
    [
        ("ProgramFiles", "Git"),
        ("ProgramFiles(x86)", "Git"),
        ("LOCALAPPDATA", "Programs/Git"),
    ]
    .into_iter()
    .filter_map(|(key, suffix)| std::env::var_os(key).map(|root| PathBuf::from(root).join(suffix)))
    .collect()
}

fn new_attempt(
    home: &Path,
    kind: &str,
    attempts: &mut Vec<tempfile::TempDir>,
) -> Result<PathBuf, String> {
    let root = home.join("runtime");
    std::fs::create_dir_all(&root).map_err(super::storage_error)?;
    super::windows_archive::plain_parents(&root)?;
    let attempt = tempfile::Builder::new()
        .prefix(&format!("{kind}-"))
        .tempdir_in(root)
        .map_err(super::storage_error)?;
    let path = attempt.path().to_owned();
    attempts.push(attempt);
    Ok(path)
}

#[cfg(windows)]
fn prepare_node(
    home: &Path,
    path: &OsStr,
    floor: &str,
    token: &CancelToken,
    log: &impl Fn(&str),
    attempts: &mut Vec<tempfile::TempDir>,
) -> Result<Selection, String> {
    require_x64()?;
    let attempt = new_attempt(home, "node-v24.21.0-win-x64", attempts)?;
    let root = extract_node(&attempt, token, log)?;
    let mut selected = Selection::new(
        root.join("node.exe"),
        root.join("npm.cmd"),
        home.join("runtime/prefix"),
    );
    selected.node_managed = true;
    if !selected.qualify_windows_npm() || !selected.qualify_node(home, path, floor, token)? {
        return Err("RUNTIME_UNSUPPORTED: prepared Node/npm did not qualify".into());
    }
    token.check()?;
    Ok(selected)
}

#[cfg(windows)]
fn extract_node(
    attempt: &Path,
    token: &CancelToken,
    log: &impl Fn(&str),
) -> Result<PathBuf, String> {
    let release = super::archive::release_for("windows", "x86_64")?;
    let mut file = tempfile::tempfile_in(attempt).map_err(super::storage_error)?;
    log("Downloading official Node runtime");
    super::archive::download(&release, &mut file, token)?;
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(0))
        .map_err(super::storage_error)?;
    let bytes = super::windows_archive::read_zip(file, token)?;
    let root = attempt.join("node");
    super::windows_archive::extract_zip(&bytes, &root, "node-v24.21.0-win-x64", token)?;
    Ok(root)
}

#[cfg(windows)]
fn prepare_git(
    home: &Path,
    token: &CancelToken,
    log: &impl Fn(&str),
    attempts: &mut Vec<tempfile::TempDir>,
) -> Result<GitSelection, String> {
    require_x64()?;
    let attempt = new_attempt(home, "git-2.56.0.2-x64", attempts)?;
    let mut file = tempfile::NamedTempFile::new_in(&attempt).map_err(super::storage_error)?;
    log("Downloading official Git Bash runtime");
    super::windows_download::download_git(file.as_file_mut(), token)?;
    let stage = attempt.join("git");
    let cancel = token.clone();
    super::portablegit::extract_x64(
        file.path(),
        &stage,
        super::portablegit::Cancellation::new(move || cancel.check().is_err()),
    )
    .map_err(|error| error.to_string())?;
    token.check()?;
    log("Preparing Git Bash");
    let git = super::windows_postinstall::run(&stage, &attempt.join("home"), token)?;
    drop(file);
    token.check()?;
    Ok(git)
}

#[cfg(windows)]
fn require_x64() -> Result<(), String> {
    if std::env::consts::ARCH != "x86_64" {
        return Err("RUNTIME_UNSUPPORTED: managed Windows runtime preparation is x64 only".into());
    }
    Ok(())
}

#[cfg(all(test, unix))]
#[path = "runtime_windows_bootstrap_tests.rs"]
mod tests;
