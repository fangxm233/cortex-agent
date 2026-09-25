//! Windows only: make copies taken inside the webview show up in Clipboard History (Win+V).
//!
//! WebView2 writes the clipboard from its own browser process (`msedgewebview2.exe`, a child of
//! this one), and Windows leaves those writes out of Clipboard History: paste works, Win+V never
//! lists them. The shell therefore listens for clipboard changes and, whenever the new owner is our
//! own WebView2 browser process, writes the same data back under a window of this process, which
//! History does record. That covers every copy path at once — Ctrl+C, the context menu, the SPA's
//! copy buttons — without the page taking part.
//!
//! Only our webview's writes are touched, never content its writer marked as excluded from history
//! or clipboard monitors, and the ownership check and the rewrite share one `OpenClipboard`, so a
//! copy another app makes in between can never be overwritten.

use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{CloseHandle, GlobalFree, HWND, INVALID_HANDLE_VALUE, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::DataExchange::{
    AddClipboardFormatListener, CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData,
    GetClipboardOwner, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
use windows_sys::Win32::System::Threading::{GetCurrentProcessId, Sleep};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, GetWindowThreadProcessId, RegisterClassW,
    HWND_MESSAGE, MSG, WM_CLIPBOARDUPDATE, WNDCLASSW,
};

const CF_DIB: u32 = 8;
const CF_UNICODETEXT: u32 = 13;
const CF_HDROP: u32 = 15;
const CF_DIBV5: u32 = 17;
/// Registered (string-named) formats occupy this range and are always plain global memory.
const FIRST_REGISTERED_FORMAT: u32 = 0xC000;

/// Formats a writer adds to keep its data out of History or away from clipboard monitors.
const OPT_OUT_FORMATS: [&str; 3] =
    ["ExcludeClipboardContentFromMonitorProcessing", "CanIncludeInClipboardHistory", "Clipboard Viewer Ignore"];

const WEBVIEW_EXE: &str = "msedgewebview2.exe";

/// Start the listener on its own thread. Failures are logged and leave copying exactly as before.
pub fn start() {
    let spawned = std::thread::Builder::new()
        .name("clipboard-history".into())
        .spawn(|| unsafe { run_listener() });
    if let Err(e) = spawned {
        shell_log!("[cortex-desktop] clipboard history listener not started: {e}");
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

unsafe fn run_listener() {
    let class = wide("CortexClipboardHistory");
    let instance = GetModuleHandleW(null());
    let wc = WNDCLASSW {
        lpfnWndProc: Some(window_proc),
        hInstance: instance,
        lpszClassName: class.as_ptr(),
        ..std::mem::zeroed()
    };
    if RegisterClassW(&wc) == 0 {
        shell_log!("[cortex-desktop] clipboard history: RegisterClassW failed");
        return;
    }
    let hwnd = CreateWindowExW(0, class.as_ptr(), null(), 0, 0, 0, 0, 0, HWND_MESSAGE, null_mut(), instance, null());
    if hwnd.is_null() || AddClipboardFormatListener(hwnd) == 0 {
        shell_log!("[cortex-desktop] clipboard history: listener window unavailable");
        return;
    }
    let mut msg: MSG = std::mem::zeroed();
    while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
        DispatchMessageW(&msg);
    }
}

unsafe extern "system" fn window_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_CLIPBOARDUPDATE {
        republish(hwnd);
        return 0;
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

/// The formats worth carrying over. Everything else is either synthesized by Windows from these
/// (CF_TEXT, CF_OEMTEXT, CF_LOCALE, CF_BITMAP) or a GDI handle that cannot be copied as bytes.
fn carried(format: u32) -> bool {
    matches!(format, CF_DIB | CF_UNICODETEXT | CF_HDROP | CF_DIBV5) || format >= FIRST_REGISTERED_FORMAT
}

unsafe fn republish(hwnd: HWND) {
    // Checked before opening too, so a copy made in any other app never waits on this listener.
    if !owned_by_our_webview() {
        return;
    }
    // A clipboard change wakes every listener at once, so the clipboard may briefly be held open
    // by another reader (History itself among them).
    let mut opened = false;
    for _ in 0..10 {
        if OpenClipboard(hwnd) != 0 {
            opened = true;
            break;
        }
        Sleep(10);
    }
    if !opened {
        return;
    }
    // Again under the lock: another app may have copied since the first check.
    if owned_by_our_webview() {
        let items = read_formats();
        if !items.is_empty() && EmptyClipboard() != 0 {
            for (format, bytes) in &items {
                write_format(*format, bytes);
            }
        }
    }
    CloseClipboard();
}

/// Our own rewrite also raises a clipboard change; its owner is this process, so it stops here.
unsafe fn owned_by_our_webview() -> bool {
    let owner = GetClipboardOwner();
    if owner.is_null() {
        return false;
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(owner, &mut pid);
    pid != 0 && pid != GetCurrentProcessId() && is_our_webview_process(pid)
}

unsafe fn is_our_webview_process(pid: u32) -> bool {
    let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if snapshot == INVALID_HANDLE_VALUE {
        return false;
    }
    let mut entry: PROCESSENTRY32W = std::mem::zeroed();
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut found = false;
    let mut more = Process32FirstW(snapshot, &mut entry) != 0;
    while more {
        if entry.th32ProcessID == pid {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            let exe = String::from_utf16_lossy(&entry.szExeFile[..len]);
            found = entry.th32ParentProcessID == GetCurrentProcessId() && exe.eq_ignore_ascii_case(WEBVIEW_EXE);
            break;
        }
        more = Process32NextW(snapshot, &mut entry) != 0;
    }
    CloseHandle(snapshot);
    found
}

/// Copies every carried format out of the open clipboard; empty when the writer opted out.
unsafe fn read_formats() -> Vec<(u32, Vec<u8>)> {
    let opt_out: Vec<u32> = OPT_OUT_FORMATS.iter().map(|name| RegisterClipboardFormatW(wide(name).as_ptr())).collect();
    let mut items = Vec::new();
    let mut format = 0;
    loop {
        format = EnumClipboardFormats(format);
        if format == 0 {
            break;
        }
        if opt_out.contains(&format) {
            return Vec::new();
        }
        if !carried(format) {
            continue;
        }
        let handle = GetClipboardData(format);
        if handle.is_null() {
            continue;
        }
        let data = GlobalLock(handle) as *const u8;
        if data.is_null() {
            continue;
        }
        items.push((format, std::slice::from_raw_parts(data, GlobalSize(handle)).to_vec()));
        GlobalUnlock(handle);
    }
    items
}

unsafe fn write_format(format: u32, bytes: &[u8]) {
    let mem = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1));
    if mem.is_null() {
        return;
    }
    let dst = GlobalLock(mem) as *mut u8;
    if dst.is_null() {
        GlobalFree(mem);
        return;
    }
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), dst, bytes.len());
    GlobalUnlock(mem);
    // On success the clipboard owns the memory; on failure it is still ours to free.
    if SetClipboardData(format, mem).is_null() {
        GlobalFree(mem);
    }
}
