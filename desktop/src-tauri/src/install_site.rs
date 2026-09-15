// input:  current_exe(), $APPIMAGE, Windows uninstall registry, dpkg/rpm ownership probes
// output: InstallSite (where this build actually lives) + the asset kind and apply mode it implies
// pos:    Ground truth for "which install am I, and may I replace myself in place"
//
// Replaces the old guess-by-distro logic in app_update.rs (`detect_linux_kind_from`, which read
// /etc/os-release): a machine's package format says nothing about how THIS copy was installed. An
// extracted AppImage or a self-built binary on Ubuntu was being reported as a `deb` install, so the
// updater downloaded a .deb and the assisted flow produced a SECOND installation next to the one
// the user was actually running.
//
// Everything here is split into pure functions over injected probe results (unit-tested on any
// platform) plus thin `detect_*` wrappers that do the actual syscalls. No new crates: the Windows
// registry is read through `reg.exe query` rather than pulling in `winreg`, because Cargo.lock
// cannot be refreshed on the machine this was written on and the release build runs `--locked`.

use std::path::{Path, PathBuf};

/// The Linux package manager that owns this install, i.e. the one that must perform the upgrade.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PkgManager {
    Apt,
    Dnf,
    Zypper,
    Rpm,
}

#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
impl PkgManager {
    /// Absolute program path — pkexec requires one and sanitizes PATH.
    pub fn program(self) -> &'static str {
        match self {
            PkgManager::Apt => "/usr/bin/apt-get",
            PkgManager::Dnf => "/usr/bin/dnf",
            PkgManager::Zypper => "/usr/bin/zypper",
            PkgManager::Rpm => "/usr/bin/rpm",
        }
    }

    /// Non-interactive install arguments, with `{}` standing in for the package file.
    pub fn args(self, file: &str) -> Vec<String> {
        let f = file.to_string();
        match self {
            PkgManager::Apt => vec!["install".into(), "-y".into(), "--allow-downgrades".into(), f],
            PkgManager::Dnf => vec!["install".into(), "-y".into(), f],
            PkgManager::Zypper => vec![
                "--non-interactive".into(),
                "install".into(),
                "--allow-unsigned-rpm".into(),
                f,
            ],
            PkgManager::Rpm => vec!["-U".into(), f],
        }
    }
}

/// Where this running build actually lives, and therefore what may be done to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallSite {
    /// Installed by the NSIS installer. `registry_dir` is the location the installer recorded;
    /// when it differs from `exe_dir` this process is a portable copy and a silent install would
    /// upgrade a DIFFERENT installation.
    WindowsNsis {
        exe_dir: PathBuf,
        registry_dir: Option<PathBuf>,
    },
    /// A `.app` bundle. `writable` reflects the PARENT directory: replacing a bundle means swapping
    /// a directory entry next to it, not writing inside the running bundle.
    MacBundle { bundle: PathBuf, writable: bool },
    /// Running from an AppImage file ($APPIMAGE), which can swap itself in place.
    LinuxAppImage { path: PathBuf },
    /// A dpkg/rpm-owned install: only the package manager may replace these files.
    LinuxManaged { manager: PkgManager },
    /// An extracted / self-built copy owned by nobody. Self-replacement is possible in principle
    /// but we have no single-file artifact for it, so it stays assisted.
    LinuxPortable { root: PathBuf },
    Android,
    Unknown,
}

/// How an update for this site may be applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Apply {
    /// May be installed with no user interaction at all (quit / next launch).
    Auto,
    /// Installable in one click but needs a root authorization dialog: only ever on a
    /// user-present path, never at quit or startup.
    Elevated,
    /// Needs the user to finish it by hand; the reason is surfaced to the SPA.
    Assisted(&'static str),
}

// ─── Pure policy ────────────────────────────────────────────────────────────

/// The release asset kind this site consumes.
pub fn wanted_kind_for(site: &InstallSite) -> &'static str {
    match site {
        InstallSite::WindowsNsis { .. } => "nsis",
        InstallSite::MacBundle { .. } => "dmg",
        InstallSite::LinuxAppImage { .. } | InstallSite::LinuxPortable { .. } => "appimage",
        InstallSite::LinuxManaged { manager } => match manager {
            PkgManager::Apt => "deb",
            PkgManager::Dnf | PkgManager::Zypper | PkgManager::Rpm => "rpm",
        },
        InstallSite::Android => "apk",
        InstallSite::Unknown => "none",
    }
}

/// Whether this site can be updated without asking, with a root prompt, or not at all.
pub fn silent_capability(site: &InstallSite) -> Apply {
    match site {
        InstallSite::WindowsNsis {
            exe_dir,
            registry_dir,
        } => match registry_dir {
            // No recorded location: nothing proves this copy is the installed one.
            None => Apply::Assisted("portable_copy"),
            Some(dir) if same_dir(dir, exe_dir) => Apply::Auto,
            Some(_) => Apply::Assisted("portable_copy"),
        },
        InstallSite::MacBundle { writable: true, .. } => Apply::Auto,
        InstallSite::MacBundle { writable: false, .. } => Apply::Assisted("bundle_not_writable"),
        InstallSite::LinuxAppImage { .. } => Apply::Auto,
        InstallSite::LinuxManaged { .. } => Apply::Elevated,
        InstallSite::LinuxPortable { .. } => Apply::Assisted("portable_copy"),
        InstallSite::Android => Apply::Auto,
        InstallSite::Unknown => Apply::Assisted("unknown_install_site"),
    }
}

/// Path equality for install directories: trailing separators are noise, and Windows paths are
/// case-insensitive. Kept as a runtime `cfg!` (not `#[cfg]`) so both branches stay unit-testable.
pub fn same_dir(a: &Path, b: &Path) -> bool {
    same_dir_with(cfg!(target_os = "windows"), a, b)
}

pub fn same_dir_with(case_insensitive: bool, a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| -> String {
        let s = p.to_string_lossy().replace('\\', "/");
        let trimmed = s.trim_end_matches('/').to_string();
        if case_insensitive {
            trimmed.to_lowercase()
        } else {
            trimmed
        }
    };
    norm(a) == norm(b)
}

/// `reg query … /v InstallLocation` output → the recorded directory.
///
/// The NSIS template writes the value WITH surrounding quotes (`"$\"$INSTDIR$\""`), which `reg`
/// prints verbatim, so they are stripped here. Output shape:
/// `    InstallLocation    REG_SZ    "C:\Users\me\AppData\Local\Cortex"`
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
pub fn parse_reg_install_location(output: &str) -> Option<PathBuf> {
    for line in output.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("InstallLocation") {
            continue;
        }
        // Split on the type marker rather than whitespace: the path itself may contain spaces.
        let value = trimmed
            .split_once("REG_EXPAND_SZ")
            .or_else(|| trimmed.split_once("REG_SZ"))
            .map(|(_, rest)| rest.trim())?;
        let unquoted = value.trim_matches('"').trim();
        if unquoted.is_empty() {
            return None;
        }
        return Some(PathBuf::from(unquoted));
    }
    None
}

/// `…/Cortex.app/Contents/MacOS/cortex-desktop` → `…/Cortex.app`. None when the executable is not
/// inside a bundle (a `cargo run` binary, a Homebrew-style bare install).
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub fn bundle_root_from_exe(exe: &Path) -> Option<PathBuf> {
    let macos_dir = exe.parent()?;
    if macos_dir.file_name()? != "MacOS" {
        return None;
    }
    let contents = macos_dir.parent()?;
    if contents.file_name()? != "Contents" {
        return None;
    }
    let bundle = contents.parent()?;
    if !bundle.to_string_lossy().ends_with(".app") {
        return None;
    }
    Some(bundle.to_path_buf())
}

/// Pick the Linux site from probe results. `appimage_env` is `$APPIMAGE`; `deb_owned` / `rpm_owned`
/// are whether `dpkg -S` / `rpm -qf` claimed the executable; `exists` tests absolute program paths.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
pub fn linux_site_from(
    appimage_env: Option<&str>,
    exe: &Path,
    deb_owned: bool,
    rpm_owned: bool,
    exists: impl Fn(&str) -> bool,
) -> InstallSite {
    if let Some(path) = appimage_env.filter(|v| !v.trim().is_empty()) {
        return InstallSite::LinuxAppImage {
            path: PathBuf::from(path),
        };
    }
    if deb_owned && exists(PkgManager::Apt.program()) {
        return InstallSite::LinuxManaged {
            manager: PkgManager::Apt,
        };
    }
    if rpm_owned {
        // Prefer the high-level manager: it resolves dependencies and honours repo config.
        for candidate in [PkgManager::Dnf, PkgManager::Zypper, PkgManager::Rpm] {
            if exists(candidate.program()) {
                return InstallSite::LinuxManaged { manager: candidate };
            }
        }
    }
    // Owned by a package manager we cannot drive (or by none at all): treat as a loose copy.
    InstallSite::LinuxPortable {
        root: exe.parent().unwrap_or(exe).to_path_buf(),
    }
}

// ─── Probes ─────────────────────────────────────────────────────────────────

/// Detect the site of the running process. Any probe failure degrades to the most conservative
/// answer (`Unknown` / `portable`), never to a wrong "safe to replace".
pub fn detect() -> InstallSite {
    #[cfg(target_os = "android")]
    {
        return InstallSite::Android;
    }

    #[cfg(not(target_os = "android"))]
    {
        let exe = match std::env::current_exe() {
            Ok(exe) => std::fs::canonicalize(&exe).unwrap_or(exe),
            Err(_) => return InstallSite::Unknown,
        };

        #[cfg(target_os = "windows")]
        {
            let exe_dir = match exe.parent() {
                Some(dir) => dir.to_path_buf(),
                None => return InstallSite::Unknown,
            };
            InstallSite::WindowsNsis {
                exe_dir,
                registry_dir: read_windows_install_location(),
            }
        }

        #[cfg(target_os = "macos")]
        {
            match bundle_root_from_exe(&exe) {
                Some(bundle) => {
                    let writable = bundle
                        .parent()
                        .is_some_and(|parent| directory_is_writable(parent));
                    InstallSite::MacBundle { bundle, writable }
                }
                None => InstallSite::Unknown,
            }
        }

        #[cfg(target_os = "linux")]
        {
            linux_site_from(
                std::env::var("APPIMAGE").ok().as_deref(),
                &exe,
                package_owns(&["dpkg", "-S"], &exe),
                package_owns(&["rpm", "-qf"], &exe),
                |p| Path::new(p).exists(),
            )
        }

        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        {
            let _ = exe;
            InstallSite::Unknown
        }
    }
}

/// Read the install location the NSIS installer recorded. HKCU first (the default `currentUser`
/// install mode writes there), then HKLM for a per-machine install.
#[cfg(target_os = "windows")]
fn read_windows_install_location() -> Option<PathBuf> {
    const KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Cortex";
    for root in ["HKCU", "HKLM"] {
        let out = std::process::Command::new("reg")
            .args(["query", &format!(r"{root}\{KEY}"), "/v", "InstallLocation"])
            .output()
            .ok()?;
        if !out.status.success() {
            continue;
        }
        if let Some(dir) = parse_reg_install_location(&String::from_utf8_lossy(&out.stdout)) {
            return Some(dir);
        }
    }
    None
}

/// True when the package manager claims ownership of `path` (exit status 0).
#[cfg(target_os = "linux")]
fn package_owns(cmd: &[&str], path: &Path) -> bool {
    let Some((program, args)) = cmd.split_first() else {
        return false;
    };
    std::process::Command::new(program)
        .args(args)
        .arg(path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Probe write access by actually creating and removing a file: permission bits alone do not
/// account for ACLs, read-only mounts, or macOS app translocation (a read-only temp mount).
#[cfg(target_os = "macos")]
fn directory_is_writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".cortex-write-probe-{}", std::process::id()));
    match std::fs::File::create(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_quoted_and_expandable_registry_values() {
        let out = "\r\nHKEY_CURRENT_USER\\Software\\...\\Cortex\r\n    InstallLocation    REG_SZ    \"C:\\Users\\me\\AppData\\Local\\Cortex\"\r\n\r\n";
        assert_eq!(
            parse_reg_install_location(out),
            Some(PathBuf::from(r"C:\Users\me\AppData\Local\Cortex"))
        );
        // Paths with spaces survive, because the split is on the type marker, not whitespace.
        let spaced = "    InstallLocation    REG_EXPAND_SZ    C:\\Program Files\\Cortex";
        assert_eq!(
            parse_reg_install_location(spaced),
            Some(PathBuf::from(r"C:\Program Files\Cortex"))
        );
        assert_eq!(parse_reg_install_location("    DisplayName    REG_SZ    Cortex"), None);
        assert_eq!(parse_reg_install_location("    InstallLocation    REG_SZ    \"\""), None);
        assert_eq!(parse_reg_install_location(""), None);
    }

    #[test]
    fn same_dir_ignores_separators_and_case_only_on_windows() {
        let a = Path::new(r"C:\Users\me\AppData\Local\Cortex");
        let b = Path::new(r"c:/users/me/appdata/local/cortex/");
        assert!(same_dir_with(true, a, b));
        assert!(!same_dir_with(false, a, b));
        assert!(same_dir_with(false, Path::new("/opt/cortex/"), Path::new("/opt/cortex")));
        assert!(!same_dir_with(false, Path::new("/opt/cortex"), Path::new("/opt/cortex2")));
    }

    #[test]
    fn bundle_root_requires_the_full_macos_layout() {
        assert_eq!(
            bundle_root_from_exe(Path::new("/Applications/Cortex.app/Contents/MacOS/cortex-desktop")),
            Some(PathBuf::from("/Applications/Cortex.app"))
        );
        // A bare binary, a cargo target dir, and a truncated layout are all "not a bundle".
        assert_eq!(bundle_root_from_exe(Path::new("/usr/local/bin/cortex-desktop")), None);
        assert_eq!(
            bundle_root_from_exe(Path::new("/src/target/release/cortex-desktop")),
            None
        );
        assert_eq!(
            bundle_root_from_exe(Path::new("/Applications/Cortex/Contents/MacOS/cortex-desktop")),
            None
        );
    }

    #[test]
    fn appimage_env_wins_over_package_ownership() {
        let site = linux_site_from(
            Some("/home/me/Apps/Cortex.AppImage"),
            Path::new("/tmp/.mount_abc/usr/bin/cortex-desktop"),
            true,
            true,
            |_| true,
        );
        assert_eq!(
            site,
            InstallSite::LinuxAppImage {
                path: PathBuf::from("/home/me/Apps/Cortex.AppImage")
            }
        );
        // A blank value is not an AppImage run.
        assert!(matches!(
            linux_site_from(Some("  "), Path::new("/usr/bin/cortex-desktop"), true, false, |_| true),
            InstallSite::LinuxManaged { .. }
        ));
    }

    #[test]
    fn package_ownership_picks_the_manager_that_exists() {
        let exe = Path::new("/usr/bin/cortex-desktop");
        assert_eq!(
            linux_site_from(None, exe, true, false, |p| p == "/usr/bin/apt-get"),
            InstallSite::LinuxManaged { manager: PkgManager::Apt }
        );
        assert_eq!(
            linux_site_from(None, exe, false, true, |p| p == "/usr/bin/dnf"),
            InstallSite::LinuxManaged { manager: PkgManager::Dnf }
        );
        assert_eq!(
            linux_site_from(None, exe, false, true, |p| p == "/usr/bin/zypper"),
            InstallSite::LinuxManaged { manager: PkgManager::Zypper }
        );
        assert_eq!(
            linux_site_from(None, exe, false, true, |p| p == "/usr/bin/rpm"),
            InstallSite::LinuxManaged { manager: PkgManager::Rpm }
        );
        // dpkg claims it but apt-get is absent → we cannot drive the upgrade.
        assert_eq!(
            linux_site_from(None, exe, true, false, |_| false),
            InstallSite::LinuxPortable { root: PathBuf::from("/usr/bin") }
        );
    }

    /// The regression this module exists for: an extracted AppImage / self-built copy on a Debian
    /// machine used to be reported as a `deb` install (distro guess), so the updater downloaded a
    /// .deb and the assisted flow created a SECOND installation.
    #[test]
    fn unowned_copy_on_a_deb_machine_is_portable_not_deb() {
        let site = linux_site_from(
            None,
            Path::new("/home/me/cortex/squashfs-root/usr/bin/cortex-desktop"),
            false,
            false,
            |p| p == "/usr/bin/apt-get", // a Debian box: apt exists, it just does not own us
        );
        assert_eq!(
            site,
            InstallSite::LinuxPortable {
                root: PathBuf::from("/home/me/cortex/squashfs-root/usr/bin")
            }
        );
        assert_eq!(wanted_kind_for(&site), "appimage");
        assert_eq!(silent_capability(&site), Apply::Assisted("portable_copy"));
    }

    #[test]
    fn wanted_kind_covers_every_site() {
        assert_eq!(
            wanted_kind_for(&InstallSite::WindowsNsis {
                exe_dir: PathBuf::from("C:/x"),
                registry_dir: None
            }),
            "nsis"
        );
        assert_eq!(
            wanted_kind_for(&InstallSite::MacBundle {
                bundle: PathBuf::from("/Applications/Cortex.app"),
                writable: true
            }),
            "dmg"
        );
        assert_eq!(
            wanted_kind_for(&InstallSite::LinuxAppImage { path: PathBuf::from("/x") }),
            "appimage"
        );
        assert_eq!(
            wanted_kind_for(&InstallSite::LinuxManaged { manager: PkgManager::Apt }),
            "deb"
        );
        assert_eq!(
            wanted_kind_for(&InstallSite::LinuxManaged { manager: PkgManager::Zypper }),
            "rpm"
        );
        assert_eq!(wanted_kind_for(&InstallSite::Android), "apk");
        assert_eq!(wanted_kind_for(&InstallSite::Unknown), "none");
    }

    #[test]
    fn windows_silent_only_when_running_the_recorded_install() {
        let installed = InstallSite::WindowsNsis {
            exe_dir: PathBuf::from(r"C:\Users\me\AppData\Local\Cortex"),
            registry_dir: Some(PathBuf::from(r"C:\Users\me\AppData\Local\Cortex\")),
        };
        assert_eq!(silent_capability(&installed), Apply::Auto);

        // A portable copy: silently running the installer would upgrade the OTHER installation
        // and leave this process on the old binary forever.
        let portable = InstallSite::WindowsNsis {
            exe_dir: PathBuf::from(r"D:\portable\Cortex"),
            registry_dir: Some(PathBuf::from(r"C:\Users\me\AppData\Local\Cortex")),
        };
        assert_eq!(silent_capability(&portable), Apply::Assisted("portable_copy"));

        let unrecorded = InstallSite::WindowsNsis {
            exe_dir: PathBuf::from(r"D:\portable\Cortex"),
            registry_dir: None,
        };
        assert_eq!(silent_capability(&unrecorded), Apply::Assisted("portable_copy"));
    }

    #[test]
    fn managed_installs_are_elevated_never_auto() {
        // The whole point: Elevated must never be mistaken for Auto, because the quit-time path
        // would then raise a polkit password dialog at a moment the user is walking away.
        assert_eq!(
            silent_capability(&InstallSite::LinuxManaged { manager: PkgManager::Apt }),
            Apply::Elevated
        );
        assert_eq!(
            silent_capability(&InstallSite::MacBundle {
                bundle: PathBuf::from("/Volumes/Cortex/Cortex.app"),
                writable: false
            }),
            Apply::Assisted("bundle_not_writable")
        );
        assert_eq!(silent_capability(&InstallSite::Unknown), Apply::Assisted("unknown_install_site"));
    }

    #[test]
    fn pkexec_arguments_are_non_interactive_and_absolute() {
        assert_eq!(PkgManager::Apt.program(), "/usr/bin/apt-get");
        assert_eq!(
            PkgManager::Apt.args("/tmp/Cortex.deb"),
            vec!["install", "-y", "--allow-downgrades", "/tmp/Cortex.deb"]
        );
        assert_eq!(PkgManager::Dnf.args("/tmp/x.rpm"), vec!["install", "-y", "/tmp/x.rpm"]);
        assert_eq!(
            PkgManager::Zypper.args("/tmp/x.rpm"),
            vec!["--non-interactive", "install", "--allow-unsigned-rpm", "/tmp/x.rpm"]
        );
        assert_eq!(PkgManager::Rpm.args("/tmp/x.rpm"), vec!["-U", "/tmp/x.rpm"]);
    }
}
