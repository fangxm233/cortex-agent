// Windows start-at-login: a per-user Run entry that launches this app with `--start-server`. That
// launch starts the local daemon when it is not running and exits without opening a window. It
// needs no administrator rights, shows no console (the app is a GUI program, unlike node.exe), and
// appears under Task Manager → Startup apps, where the user can also switch it off.
use std::path::Path;

use super::autostart::{AutostartState, START_SERVER_ARG};

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
/// Task Manager's Startup apps switch keeps its state here, under the same value name.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const APPROVED_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const VALUE: &str = "Cortex";

fn command_line(exe: &Path) -> String {
    format!("\"{}\" {START_SERVER_ARG}", exe.display())
}

/// An odd first byte marks an entry the user switched off in Task Manager.
fn switched_off(approval: &[u8]) -> bool {
    approval.first().is_some_and(|flag| flag & 1 == 1)
}

/// An entry naming another executable (an older install location) is stale: off, and turning it
/// on rewrites it for this one.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn state_of(run: Option<&str>, approval: Option<&[u8]>, exe: &Path) -> AutostartState {
    let current = run == Some(command_line(exe).as_str());
    if current && !approval.is_some_and(switched_off) {
        AutostartState::On
    } else {
        AutostartState::Off
    }
}

#[cfg(target_os = "windows")]
pub(super) fn state() -> AutostartState {
    let Ok(exe) = std::env::current_exe() else {
        return AutostartState::Off;
    };
    let run = registry::get_string(RUN_KEY, VALUE);
    let approval = registry::get_binary(APPROVED_KEY, VALUE);
    state_of(run.as_deref(), approval.as_deref(), &exe)
}

/// Writes the entry for this executable and clears a Task Manager switch-off.
#[cfg(target_os = "windows")]
pub(super) fn enable() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("AUTOSTART_FAILED: {e}"))?;
    if !registry::set_string(RUN_KEY, VALUE, &command_line(&exe)) {
        return Err("AUTOSTART_FAILED: cannot write the login entry".into());
    }
    registry::delete(APPROVED_KEY, VALUE);
    Ok(())
}

/// Ok(true) = an entry was removed; Ok(false) = there was none.
#[cfg(target_os = "windows")]
pub(super) fn disable() -> Result<bool, String> {
    let existed = registry::get_string(RUN_KEY, VALUE).is_some();
    registry::delete(RUN_KEY, VALUE);
    registry::delete(APPROVED_KEY, VALUE);
    Ok(existed)
}

/// HKEY_CURRENT_USER values through the wide-character API, so a non-ASCII profile path survives.
#[cfg(target_os = "windows")]
mod registry {
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ,
        RRF_RT_REG_BINARY, RRF_RT_REG_SZ,
    };

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }

    fn get(key: &str, name: &str, flags: u32) -> Option<Vec<u8>> {
        let (key, name) = (wide(key), wide(name));
        let mut len = 0u32;
        let read = |data: *mut u8, len: &mut u32| unsafe {
            RegGetValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr(), flags, null_mut(), data.cast(), len)
        };
        if read(null_mut(), &mut len) != ERROR_SUCCESS {
            return None;
        }
        let mut data = vec![0u8; len as usize];
        if read(data.as_mut_ptr(), &mut len) != ERROR_SUCCESS {
            return None;
        }
        data.truncate(len as usize);
        Some(data)
    }

    pub fn get_string(key: &str, name: &str) -> Option<String> {
        let bytes = get(key, name, RRF_RT_REG_SZ)?;
        let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        Some(String::from_utf16_lossy(&units).trim_end_matches('\0').to_string())
    }

    pub fn get_binary(key: &str, name: &str) -> Option<Vec<u8>> {
        get(key, name, RRF_RT_REG_BINARY)
    }

    pub fn set_string(key: &str, name: &str, value: &str) -> bool {
        let (key, name, data) = (wide(key), wide(name), wide(value));
        let bytes = (data.len() * 2) as u32;
        let status = unsafe {
            RegSetKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr(), REG_SZ, data.as_ptr().cast(), bytes)
        };
        status == ERROR_SUCCESS
    }

    /// Best-effort: an absent value is the goal either way.
    pub fn delete(key: &str, name: &str) {
        let (key, name) = (wide(key), wide(name));
        unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr()) };
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use windows_sys::Win32::System::Registry::RegDeleteKeyW;

        const SCRATCH: &str = r"Software\CortexLoginEntryTest";

        #[test]
        fn a_non_ascii_command_line_round_trips() {
            let value = "\"C:\\Users\\方欣\\AppData\\Local\\Cortex\\cortex-desktop.exe\" --start-server";
            assert!(set_string(SCRATCH, "Cortex", value));
            assert_eq!(get_string(SCRATCH, "Cortex").as_deref(), Some(value));
            assert!(get_binary(SCRATCH, "Cortex").is_none(), "a string is not read as binary");
            delete(SCRATCH, "Cortex");
            assert!(get_string(SCRATCH, "Cortex").is_none());
            unsafe { RegDeleteKeyW(HKEY_CURRENT_USER, wide(SCRATCH).as_ptr()) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn exe() -> PathBuf {
        PathBuf::from(r"C:\Users\方欣\AppData\Local\Cortex\cortex-desktop.exe")
    }

    #[test]
    fn the_entry_quotes_the_executable_and_asks_for_a_headless_start() {
        assert_eq!(
            command_line(&exe()),
            "\"C:\\Users\\方欣\\AppData\\Local\\Cortex\\cortex-desktop.exe\" --start-server"
        );
    }

    #[test]
    fn only_this_executables_entry_counts_as_on() {
        let ours = command_line(&exe());
        assert_eq!(state_of(Some(&ours), None, &exe()), AutostartState::On);
        assert_eq!(state_of(None, None, &exe()), AutostartState::Off);
        let stale = "\"D:\\Old\\cortex-desktop.exe\" --start-server";
        assert_eq!(state_of(Some(stale), None, &exe()), AutostartState::Off);
    }

    #[test]
    fn task_manager_switch_off_wins() {
        let ours = command_line(&exe());
        let disabled = [3u8, 0, 0, 0, 0x4a, 0x1b, 0, 0, 0, 0, 0, 0];
        let enabled = [2u8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        assert_eq!(state_of(Some(&ours), Some(&disabled), &exe()), AutostartState::Off);
        assert_eq!(state_of(Some(&ours), Some(&enabled), &exe()), AutostartState::On);
    }
}
