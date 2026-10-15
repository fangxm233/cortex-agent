//! Removing the app itself, which depends on how this copy was installed (see install_site.rs).
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use super::{Step, StepStatus};
use crate::install_site::{self, InstallSite, PkgManager};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Removal {
    /// The NSIS uninstaller that started us deletes the program files once we exit.
    Installer,
    /// A macOS bundle, moved to the Trash.
    Trash(PathBuf),
    /// An AppImage file.
    DeleteFile(PathBuf),
    /// A deb/rpm install, removed by its package manager behind one authorization prompt.
    Package(PkgManager),
    /// Nothing owns this copy; the user deletes it.
    Manual(Option<PathBuf>),
}

impl Removal {
    pub fn for_site(site: &InstallSite, from_installer: bool) -> Self {
        match site {
            InstallSite::WindowsNsis { .. } if from_installer => Removal::Installer,
            InstallSite::WindowsNsis { exe_dir, .. } => Removal::Manual(Some(exe_dir.clone())),
            InstallSite::MacBundle { bundle, .. } => Removal::Trash(bundle.clone()),
            InstallSite::LinuxAppImage { path } => Removal::DeleteFile(path.clone()),
            InstallSite::LinuxManaged { manager } => Removal::Package(*manager),
            InstallSite::LinuxPortable { root } => Removal::Manual(Some(root.clone())),
            InstallSite::Android | InstallSite::Unknown => Removal::Manual(None),
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Removal::Installer => "installer",
            Removal::Trash(_) => "trash",
            Removal::DeleteFile(_) => "file",
            Removal::Package(_) => "package",
            Removal::Manual(_) => "manual",
        }
    }

    pub fn location(&self) -> Option<&Path> {
        match self {
            Removal::Trash(path) | Removal::DeleteFile(path) => Some(path),
            Removal::Manual(path) => path.as_deref(),
            Removal::Installer | Removal::Package(_) => None,
        }
    }
}

pub fn remove_app(removal: &Removal) -> Step {
    let outcome = match removal {
        Removal::Installer => return Step::new("app", StepStatus::Deferred),
        Removal::Manual(_) => return Step::new("app", StepStatus::Manual),
        Removal::Trash(bundle) => move_to_trash(bundle),
        Removal::DeleteFile(file) => {
            std::fs::remove_file(file).map_err(|e| format!("cannot remove {}: {e}", file.display()))
        }
        Removal::Package(manager) => remove_package(*manager),
    };
    match outcome {
        Ok(()) => Step::new("app", StepStatus::Done),
        Err(error) => Step::new("app", StepStatus::Failed).detail(error),
    }
}

/// A rename into ~/.Trash, under a fresh name when one is already there. Moving a running bundle
/// is fine on macOS; a bundle on another volume fails here and is left for the user to drag.
fn move_to_trash(bundle: &Path) -> Result<(), String> {
    let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
    let target = trash_target(&Path::new(&home).join(".Trash"), bundle, std::time::SystemTime::now())?;
    std::fs::rename(bundle, &target).map_err(|e| format!("cannot move {} to the Trash: {e}", bundle.display()))
}

pub fn trash_target(trash: &Path, bundle: &Path, now: std::time::SystemTime) -> Result<PathBuf, String> {
    let name = bundle.file_name().ok_or("bundle has no name")?;
    let plain = trash.join(name);
    if std::fs::symlink_metadata(&plain).is_err() {
        return Ok(plain);
    }
    let stamp = now.duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let stem = Path::new(name).file_stem().unwrap_or(name).to_string_lossy();
    Ok(trash.join(format!("{stem} {stamp}.app")))
}

fn remove_package(manager: PkgManager) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let (query, query_args) = manager.owner_query();
    let owner = std::process::Command::new(query)
        .args(query_args)
        .arg(&exe)
        .output()
        .map_err(|e| format!("cannot run {query}: {e}"))?;
    let name = install_site::parse_package_owner(manager, &String::from_utf8_lossy(&owner.stdout))
        .ok_or_else(|| format!("no package owns {}", exe.display()))?;
    // pkexec needs an absolute program path; 126 = the authorization was dismissed.
    let status = std::process::Command::new("pkexec")
        .arg(manager.program())
        .args(manager.remove_args(&name))
        .status()
        .map_err(|e| format!("pkexec could not be started: {e}"))?;
    if status.success() {
        return Ok(());
    }
    Err(format!("{} {} exited with {:?}", manager.program(), manager.remove_args(&name).join(" "), status.code()))
}

/// How the settings action starts the uninstaller: the NSIS uninstaller for an installed Windows
/// copy (it runs ours first), otherwise this app again. An AppImage relaunches through its file,
/// since the mount it runs from disappears when this process exits.
pub fn launcher(site: &InstallSite, exe: &Path) -> (PathBuf, Vec<&'static str>) {
    match site {
        InstallSite::WindowsNsis { exe_dir, registry_dir: Some(dir) } if install_site::same_dir(dir, exe_dir) => {
            (exe_dir.join("uninstall.exe"), Vec::new())
        }
        InstallSite::LinuxAppImage { path } => (path.clone(), vec![super::UNINSTALL_ARG]),
        _ => (exe.to_path_buf(), vec![super::UNINSTALL_ARG]),
    }
}

/// This app's own data directories (frontend cache, update files, WebView profile). Only
/// directories named after the bundle identifier are returned: nothing shared is ever touched.
pub fn app_data_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let path = app.path();
    let mut dirs: Vec<PathBuf> = [
        path.app_data_dir(),
        path.app_local_data_dir(),
        path.app_config_dir(),
        path.app_cache_dir(),
        path.app_log_dir(),
    ]
    .into_iter()
    .flatten()
    .collect();
    if cfg!(target_os = "macos") {
        if let Ok(home) = path.home_dir() {
            dirs.push(home.join("Library/WebKit").join(&app.config().identifier));
        }
    }
    owned_dirs(dirs, &app.config().identifier)
}

pub fn owned_dirs(dirs: Vec<PathBuf>, identifier: &str) -> Vec<PathBuf> {
    let mut owned: Vec<PathBuf> = Vec::new();
    for dir in dirs {
        let named = dir.file_name().is_some_and(|name| name == identifier);
        if named && !owned.iter().any(|known| install_site::same_dir(known, &dir)) && dir.exists() {
            owned.push(dir);
        }
    }
    owned
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_install_site_has_one_way_out() {
        let nsis = InstallSite::WindowsNsis { exe_dir: PathBuf::from("C:/Cortex"), registry_dir: None };
        assert_eq!(Removal::for_site(&nsis, true), Removal::Installer);
        assert_eq!(Removal::for_site(&nsis, false).kind(), "manual");
        let bundle = InstallSite::MacBundle { bundle: PathBuf::from("/Applications/Cortex.app"), writable: true };
        assert_eq!(Removal::for_site(&bundle, false), Removal::Trash(PathBuf::from("/Applications/Cortex.app")));
        let appimage = InstallSite::LinuxAppImage { path: PathBuf::from("/home/me/Cortex.AppImage") };
        assert_eq!(Removal::for_site(&appimage, false).location(), Some(Path::new("/home/me/Cortex.AppImage")));
        let deb = InstallSite::LinuxManaged { manager: PkgManager::Apt };
        assert_eq!(Removal::for_site(&deb, false), Removal::Package(PkgManager::Apt));
        assert_eq!(Removal::for_site(&InstallSite::Unknown, false), Removal::Manual(None));
    }

    #[test]
    fn installer_and_manual_removals_never_touch_files() {
        assert_eq!(remove_app(&Removal::Installer).status, StepStatus::Deferred);
        assert_eq!(remove_app(&Removal::Manual(Some(PathBuf::from("/opt/cortex")))).status, StepStatus::Manual);
    }

    #[test]
    fn an_appimage_is_removed_by_deleting_its_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("Cortex.AppImage");
        std::fs::write(&file, b"fixture").unwrap();
        assert_eq!(remove_app(&Removal::DeleteFile(file.clone())).status, StepStatus::Done);
        assert!(!file.exists());
        assert_eq!(remove_app(&Removal::DeleteFile(file)).status, StepStatus::Failed);
    }

    #[test]
    fn the_trash_never_overwrites_an_earlier_copy() {
        let trash = tempfile::tempdir().unwrap();
        let bundle = Path::new("/Applications/Cortex.app");
        let now = std::time::UNIX_EPOCH + std::time::Duration::from_secs(42);
        assert_eq!(trash_target(trash.path(), bundle, now).unwrap(), trash.path().join("Cortex.app"));
        std::fs::create_dir(trash.path().join("Cortex.app")).unwrap();
        assert_eq!(trash_target(trash.path(), bundle, now).unwrap(), trash.path().join("Cortex 42.app"));
    }

    #[test]
    fn the_settings_action_starts_the_right_uninstaller() {
        let exe = Path::new("/usr/bin/cortex-desktop");
        let installed = InstallSite::WindowsNsis {
            exe_dir: PathBuf::from(r"C:\Users\me\AppData\Local\Cortex"),
            registry_dir: Some(PathBuf::from(r"C:\Users\me\AppData\Local\Cortex")),
        };
        let (program, args) = launcher(&installed, exe);
        assert_eq!(program, PathBuf::from(r"C:\Users\me\AppData\Local\Cortex").join("uninstall.exe"));
        assert!(args.is_empty());
        let appimage = InstallSite::LinuxAppImage { path: PathBuf::from("/home/me/Cortex.AppImage") };
        assert_eq!(launcher(&appimage, exe), (PathBuf::from("/home/me/Cortex.AppImage"), vec!["--uninstall"]));
        let deb = InstallSite::LinuxManaged { manager: PkgManager::Apt };
        assert_eq!(launcher(&deb, exe), (exe.to_path_buf(), vec!["--uninstall"]));
    }

    #[test]
    fn only_directories_named_after_the_app_are_data() {
        let root = tempfile::tempdir().unwrap();
        let ours = root.path().join("dev.cortex.desktop");
        let logs = ours.join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let shared = root.path().join("share");
        std::fs::create_dir_all(&shared).unwrap();
        let dirs = vec![ours.clone(), ours.clone(), logs, shared, root.path().join("missing/dev.cortex.desktop")];
        assert_eq!(owned_dirs(dirs, "dev.cortex.desktop"), vec![ours]);
    }
}
