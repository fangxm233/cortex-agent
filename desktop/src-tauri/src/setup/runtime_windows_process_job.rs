//! Ownership of ONE temporary install/probe tree; never used by the daemon runner.
use std::{
    io,
    mem::{size_of, zeroed},
    os::windows::{
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::CommandExt,
    },
    process::{Child, Command, Stdio},
    ptr::{null, null_mut},
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::{ERROR_NO_MORE_FILES, HANDLE, INVALID_HANDLE_VALUE},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
        },
        JobObjects::*,
        Threading::{
            GetProcessIdOfThread, OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED,
            THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
        },
    },
};

pub(crate) struct Owned {
    job: OwnedHandle,
    pub child: Child,
}

fn checked(ok: i32) -> io::Result<()> {
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn handle(raw: HANDLE) -> io::Result<OwnedHandle> {
    if raw.is_null() || raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: each caller supplies a newly-created, uniquely owned kernel handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}

fn new_job() -> io::Result<OwnedHandle> {
    // SAFETY: null security/name create an unnamed non-inheritable job.
    let job = handle(unsafe { CreateJobObjectW(null(), null()) })?;
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    // Deliberately no BREAKAWAY_OK or SILENT_BREAKAWAY_OK.
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: valid handle and initialized structure of exactly the advertised size.
    checked(unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            &limits as *const _ as _,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    })?;
    Ok(job)
}

impl Owned {
    pub fn suspended(mut command: Command) -> io::Result<Self> {
        let job = new_job()?;
        command
            .creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // std uses CreateProcessW, retaining its quoting (including .cmd/raw_arg),
        // cwd, env_clear/env_remove and Windows case-insensitive environment semantics.
        let child = command.spawn()?;
        let owned = Self { job, child }; // RAII BEFORE any fallible post-spawn operation.
        owned.assign()?;
        Ok(owned)
    }

    fn assign(&self) -> io::Result<()> {
        // SAFETY: both handles remain live; the only child thread is still suspended.
        checked(unsafe {
            AssignProcessToJobObject(self.job.as_raw_handle(), self.child.as_raw_handle())
        })?;
        if !self.is_member()? {
            return Err(io::Error::other("owned job membership not proven"));
        }
        Ok(())
    }

    pub fn is_member(&self) -> io::Result<bool> {
        let mut member = 0;
        // SAFETY: live handles and a writable BOOL; never queries/signals an unrelated process.
        checked(unsafe {
            IsProcessInJob(
                self.child.as_raw_handle(),
                self.job.as_raw_handle(),
                &mut member,
            )
        })?;
        Ok(member != 0)
    }

    pub fn resume(&self) -> io::Result<()> {
        let thread = primary_thread(self.child.id())?;
        // Reverify immediately before resume; no unowned fallback on restricted/nested jobs.
        if !self.is_member()? {
            return Err(io::Error::other("owned job membership lost"));
        }
        // SAFETY: a stable thread handle, verified to belong to this suspended root.
        match unsafe { ResumeThread(thread.as_raw_handle()) } {
            1 => Ok(()),
            u32::MAX => Err(io::Error::last_os_error()),
            _ => Err(io::Error::other("unexpected initial suspend count")),
        }
    }

    pub fn accounting(&self) -> io::Result<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION> {
        let mut state = unsafe { zeroed::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() };
        // SAFETY: valid job; writable structure and exact size.
        checked(unsafe {
            QueryInformationJobObject(
                self.job.as_raw_handle(),
                JobObjectBasicAccountingInformation,
                &mut state as *mut _ as _,
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                null_mut(),
            )
        })?;
        Ok(state)
    }

    pub fn terminate(&self) -> io::Result<()> {
        // SAFETY: this unnamed non-inheritable job owns only this invocation's tree.
        checked(unsafe { TerminateJobObject(self.job.as_raw_handle(), 125) })
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        let _ = self.terminate();
        // Also covers assignment failure: kill/reap the still-suspended, unassigned root.
        let _ = self.child.kill();
        let _ = self.child.wait();
        // Termination is asynchronous. Do not return while descendants can mutate staging
        // or hold output handles. Retry on kernel errors rather than abandon ownership.
        loop {
            let _ = self.terminate();
            if matches!(self.accounting(), Ok(state) if state.ActiveProcesses == 0) {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        // Job closes last, as a kill-on-close safety net. There are no reader threads.
    }
}

fn primary_thread(pid: u32) -> io::Result<OwnedHandle> {
    // std::process::Child does not expose the primary thread. CREATE_SUSPENDED means
    // no child bytecode has run: require exactly one thread, otherwise fail closed.
    let snapshot = handle(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) })?;
    let tid = sole_thread(snapshot.as_raw_handle(), pid)?;
    let access = THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION;
    let thread = handle(unsafe { OpenThread(access, 0, tid) })?;
    // Protect against an external root death and thread-id reuse during enumeration.
    if unsafe { GetProcessIdOfThread(thread.as_raw_handle()) } != pid {
        return Err(io::Error::other("suspended thread identity changed"));
    }
    Ok(thread)
}

fn sole_thread(snapshot: HANDLE, pid: u32) -> io::Result<u32> {
    let mut entry: THREADENTRY32 = unsafe { zeroed() };
    entry.dwSize = size_of::<THREADENTRY32>() as u32;
    let mut tid = None;
    // SAFETY: live snapshot and initialized entry with the correct size.
    checked(unsafe { Thread32First(snapshot, &mut entry) })?;
    loop {
        if entry.th32OwnerProcessID == pid && tid.replace(entry.th32ThreadID).is_some() {
            return Err(io::Error::other("suspended root has multiple threads"));
        }
        entry.dwSize = size_of::<THREADENTRY32>() as u32;
        if unsafe { Thread32Next(snapshot, &mut entry) } == 0 {
            break;
        }
    }
    if io::Error::last_os_error().raw_os_error() != Some(ERROR_NO_MORE_FILES as i32) {
        return Err(io::Error::last_os_error());
    }
    tid.ok_or_else(|| io::Error::other("suspended root thread missing"))
}
