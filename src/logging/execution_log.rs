//! Execution log tee. Port of AstroEX-node src/logging/executionLog.ts.
//!
//! Mirrors stdout and stderr to one execution-scoped, ANSI-free file without
//! changing the bytes seen by either console stream. Unlike Node (which wraps
//! the stream write methods), the Rust port redirects file descriptors 1 and 2
//! on Unix (or standard handles on Windows) through pipes and forwards every chunk
//! both to the saved original descriptors (with ANSI intact) and to the log file (ANSI-stripped).

use std::fs::{File, OpenOptions};
use std::io::{Seek, Write};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};

#[cfg(windows)]
use windows_sys::Win32::Foundation::{
    CloseHandle, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
};
#[cfg(windows)]
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile};
#[cfg(windows)]
use windows_sys::Win32::System::Console::{
    GetConsoleMode, GetStdHandle, SetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE,
};
#[cfg(windows)]
use windows_sys::Win32::System::Pipes::{CreatePipe, PeekNamedPipe};

fn safe_identifier(value: &str) -> String {
    static RE_INVALID: OnceLock<regex::Regex> = OnceLock::new();
    static RE_EDGES: OnceLock<regex::Regex> = OnceLock::new();
    let re_invalid = RE_INVALID.get_or_init(|| regex::Regex::new(r"[^a-z0-9_-]+").unwrap());
    let re_edges = RE_EDGES.get_or_init(|| regex::Regex::new(r"^-+|-+$").unwrap());
    let lowered = value.trim().to_lowercase();
    let dashed = re_invalid.replace_all(&lowered, "-");
    let trimmed = re_edges.replace_all(&dashed, "");
    let sanitized = trimmed.to_string();
    if sanitized.is_empty() {
        "command".to_string()
    } else {
        sanitized
    }
}

fn command_identifier(args: &[String]) -> String {
    let first = args
        .iter()
        .find(|argument| !argument.starts_with('-'))
        .map(String::as_str)
        .unwrap_or("cli");
    safe_identifier(first)
}

fn timestamp_for_file() -> String {
    chrono::Utc::now()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        .replace(&['-', ':', '.'][..], "")
}

// ---------------------------------------------------------------------------
// Unix implementation (FD 1 & 2 redirection via libc pipe/dup/dup2)
// ---------------------------------------------------------------------------

#[cfg(unix)]
#[derive(Debug)]
struct ChannelSync {
    read_fd: i32,
    busy: bool,
    cycles: u64,
}

#[cfg(unix)]
struct SharedSync {
    stdout: Mutex<ChannelSync>,
    stderr: Mutex<ChannelSync>,
    condvar: Condvar,
}

#[cfg(unix)]
struct ExecutionLogState {
    path: PathBuf,
    file: Arc<Mutex<File>>,
    saved_stdout: i32,
    saved_stderr: i32,
    readers: Vec<std::thread::JoinHandle<()>>,
    sync: Arc<SharedSync>,
}

#[cfg(unix)]
static STATE: Mutex<Option<ExecutionLogState>> = Mutex::new(None);

#[cfg(unix)]
pub fn initialize_execution_log(log_dir: &Path, args: &[String]) -> std::io::Result<()> {
    let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    if state.is_some() {
        return Ok(());
    }

    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true).mode(0o700);
    builder.create(log_dir)?;
    for subdirectory in super::payload_logs::LLM_PAYLOAD_LOG_DIRECTORIES {
        builder.create(log_dir.join(subdirectory))?;
    }

    let file_name = format!(
        "astroom_{}_{}_p{}_{}.log",
        command_identifier(args),
        timestamp_for_file(),
        std::process::id(),
        uuid::Uuid::new_v4()
    );
    let file_path = log_dir.join(file_name);
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&file_path)?;

    let saved_stdout = unsafe { libc::dup(1) };
    if saved_stdout < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let saved_stderr = unsafe { libc::dup(2) };
    if saved_stderr < 0 {
        unsafe { libc::close(saved_stdout) };
        return Err(std::io::Error::last_os_error());
    }

    let mut stdout_pipe = [0i32; 2];
    if unsafe { libc::pipe(stdout_pipe.as_mut_ptr()) } != 0 {
        unsafe {
            libc::close(saved_stdout);
            libc::close(saved_stderr);
        }
        return Err(std::io::Error::last_os_error());
    }
    let mut stderr_pipe = [0i32; 2];
    if unsafe { libc::pipe(stderr_pipe.as_mut_ptr()) } != 0 {
        unsafe {
            libc::close(saved_stdout);
            libc::close(saved_stderr);
            libc::close(stdout_pipe[0]);
            libc::close(stdout_pipe[1]);
        }
        return Err(std::io::Error::last_os_error());
    }

    let redirected = unsafe {
        let stdout_result = libc::dup2(stdout_pipe[1], 1);
        libc::close(stdout_pipe[1]);
        let stderr_result = libc::dup2(stderr_pipe[1], 2);
        libc::close(stderr_pipe[1]);
        stdout_result >= 0 && stderr_result >= 0
    };
    if !redirected {
        let error = std::io::Error::last_os_error();
        unsafe {
            libc::dup2(saved_stdout, 1);
            libc::dup2(saved_stderr, 2);
            libc::close(saved_stdout);
            libc::close(saved_stderr);
            libc::close(stdout_pipe[0]);
            libc::close(stderr_pipe[0]);
        }
        return Err(error);
    }

    let shared_file = Arc::new(Mutex::new(file));
    let sync = Arc::new(SharedSync {
        stdout: Mutex::new(ChannelSync {
            read_fd: stdout_pipe[0],
            busy: false,
            cycles: 0,
        }),
        stderr: Mutex::new(ChannelSync {
            read_fd: stderr_pipe[0],
            busy: false,
            cycles: 0,
        }),
        condvar: Condvar::new(),
    });
    let readers = vec![
        spawn_reader(
            "stdout",
            stdout_pipe[0],
            saved_stdout,
            Arc::clone(&shared_file),
            Arc::clone(&sync),
        ),
        spawn_reader(
            "stderr",
            stderr_pipe[0],
            saved_stderr,
            Arc::clone(&shared_file),
            Arc::clone(&sync),
        ),
    ];

    *state = Some(ExecutionLogState {
        path: file_path,
        file: shared_file,
        saved_stdout,
        saved_stderr,
        readers,
        sync,
    });
    Ok(())
}

#[cfg(unix)]
pub fn is_stdout_terminal() -> bool {
    let state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(state) = state.as_ref() {
        unsafe { libc::isatty(state.saved_stdout) == 1 }
    } else {
        std::io::IsTerminal::is_terminal(&std::io::stdout())
    }
}

#[cfg(unix)]
pub fn is_tee_active() -> bool {
    let state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    state.is_some()
}

#[cfg(unix)]
pub fn get_saved_stdout() -> Option<i32> {
    let state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    state.as_ref().map(|s| s.saved_stdout)
}

#[cfg(unix)]
pub fn execution_log_path() -> Option<PathBuf> {
    STATE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|state| state.path.clone())
}

#[cfg(unix)]
pub fn close_execution_log() {
    let mut state_guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let mut state = match state_guard.take() {
        Some(state) => state,
        None => return,
    };

    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();

    unsafe {
        libc::dup2(state.saved_stdout, 1);
        libc::dup2(state.saved_stderr, 2);
    }

    for reader in state.readers.drain(..) {
        let _ = reader.join();
    }
    unsafe {
        libc::close(state.saved_stdout);
        libc::close(state.saved_stderr);
    }

    let final_result = state.file.lock().map(|mut file| {
        if let Ok(contents) = std::fs::read_to_string(&state.path) {
            let plain_text = crate::logging::strip_ansi(&contents);
            if plain_text != contents {
                let _ = file.set_len(0);
                let _ = file.seek(std::io::SeekFrom::Start(0));
                let _ = file.write_all(plain_text.as_bytes());
            }
        }
        file.sync_all()
    });
    let _ = final_result;
}

#[cfg(unix)]
pub fn flush_execution_log() {
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();

    let sync = {
        let state = STATE.lock().unwrap_or_else(|e| e.into_inner());
        match state.as_ref() {
            Some(s) => Arc::clone(&s.sync),
            None => return,
        }
    };

    let drain_channel = |channel_name: &str| loop {
        let (read_fd, is_busy) = {
            let chan = if channel_name == "stdout" {
                sync.stdout.lock().unwrap_or_else(|e| e.into_inner())
            } else {
                sync.stderr.lock().unwrap_or_else(|e| e.into_inner())
            };
            (chan.read_fd, chan.busy)
        };

        let mut available: libc::c_int = 0;
        let ioctl_res = unsafe { libc::ioctl(read_fd, libc::FIONREAD, &mut available) };
        let has_pending_bytes = ioctl_res == 0 && available > 0;

        if !has_pending_bytes && !is_busy {
            break;
        }

        let chan = if channel_name == "stdout" {
            sync.stdout.lock().unwrap_or_else(|e| e.into_inner())
        } else {
            sync.stderr.lock().unwrap_or_else(|e| e.into_inner())
        };
        let _ = sync
            .condvar
            .wait_timeout(chan, std::time::Duration::from_millis(50));
    };

    drain_channel("stderr");
    drain_channel("stdout");

    let state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(s) = state.as_ref() {
        if let Ok(file) = s.file.lock() {
            let _ = file.sync_data();
        }
    }
}

#[cfg(unix)]
fn spawn_reader(
    channel_name: &'static str,
    read_fd: i32,
    mirror_fd: i32,
    file: Arc<Mutex<File>>,
    sync: Arc<SharedSync>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::with_capacity(16384);
        loop {
            // Signal that we are currently idle and about to block in libc::read
            {
                let mut chan = if channel_name == "stdout" {
                    sync.stdout.lock().unwrap_or_else(|e| e.into_inner())
                } else {
                    sync.stderr.lock().unwrap_or_else(|e| e.into_inner())
                };
                chan.busy = false;
                sync.condvar.notify_all();
            }

            let read = unsafe {
                libc::read(
                    read_fd,
                    buffer.as_mut_ptr() as *mut libc::c_void,
                    buffer.len(),
                )
            };
            if read < 0 {
                if errno_is_eintr() {
                    continue;
                }
                break;
            }
            if read == 0 {
                break;
            }

            // Signal that we are busy processing new bytes
            {
                let mut chan = if channel_name == "stdout" {
                    sync.stdout.lock().unwrap_or_else(|e| e.into_inner())
                } else {
                    sync.stderr.lock().unwrap_or_else(|e| e.into_inner())
                };
                chan.busy = true;
            }

            pending.extend_from_slice(&buffer[..read as usize]);

            // Check if more data is waiting in the pipe
            let mut available: libc::c_int = 0;
            let ioctl_res = unsafe { libc::ioctl(read_fd, libc::FIONREAD, &mut available) };
            let has_more = ioctl_res == 0 && available > 0;

            let emit_chunk = if has_more && pending.len() < 65536 {
                if let Some(last_nl) = pending.iter().rposition(|&b| b == b'\n') {
                    let to_emit = pending.drain(..=last_nl).collect::<Vec<u8>>();
                    Some(to_emit)
                } else {
                    None
                }
            } else if !pending.is_empty() {
                Some(std::mem::take(&mut pending))
            } else {
                None
            };

            if let Some(chunk) = emit_chunk {
                {
                    let _guard = crate::logging::console_output::lock_console();
                    write_all_fd(mirror_fd, &chunk);
                }
                let plain_text = crate::logging::strip_ansi(&String::from_utf8_lossy(&chunk));
                if !plain_text.is_empty() {
                    if let Ok(mut log) = file.lock() {
                        let _ = log.write_all(plain_text.as_bytes());
                    }
                }
            }

            // Processing cycle completed
            {
                let mut chan = if channel_name == "stdout" {
                    sync.stdout.lock().unwrap_or_else(|e| e.into_inner())
                } else {
                    sync.stderr.lock().unwrap_or_else(|e| e.into_inner())
                };
                chan.cycles += 1;
                chan.busy = !pending.is_empty();
                sync.condvar.notify_all();
            }
        }

        if !pending.is_empty() {
            {
                let _guard = crate::logging::console_output::lock_console();
                write_all_fd(mirror_fd, &pending);
            }
            let plain_text = crate::logging::strip_ansi(&String::from_utf8_lossy(&pending));
            if !plain_text.is_empty() {
                if let Ok(mut log) = file.lock() {
                    let _ = log.write_all(plain_text.as_bytes());
                }
            }
        }

        unsafe { libc::close(read_fd) };

        let mut chan = if channel_name == "stdout" {
            sync.stdout.lock().unwrap_or_else(|e| e.into_inner())
        } else {
            sync.stderr.lock().unwrap_or_else(|e| e.into_inner())
        };
        chan.busy = false;
        sync.condvar.notify_all();
    })
}

#[cfg(unix)]
fn errno_is_eintr() -> bool {
    unsafe { *libc::__errno_location() == libc::EINTR }
}

#[cfg(unix)]
pub fn write_all_fd(fd: i32, mut data: &[u8]) {
    while !data.is_empty() {
        let written = unsafe { libc::write(fd, data.as_ptr() as *const libc::c_void, data.len()) };
        if written < 0 {
            if errno_is_eintr() {
                continue;
            }
            break;
        }
        data = &data[written as usize..];
    }
}

// ---------------------------------------------------------------------------
// Windows implementation (Standard handle redirection via Win32 pipes)
// ---------------------------------------------------------------------------

#[cfg(windows)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SendHandle(HANDLE);
#[cfg(windows)]
unsafe impl Send for SendHandle {}
#[cfg(windows)]
unsafe impl Sync for SendHandle {}

#[cfg(windows)]
impl SendHandle {
    #[inline]
    fn as_raw(self) -> HANDLE {
        self.0
    }
}

#[cfg(windows)]
#[derive(Debug)]
struct ChannelSync {
    read_handle: SendHandle,
    busy: bool,
    cycles: u64,
}

#[cfg(windows)]
struct SharedSync {
    stdout: Mutex<ChannelSync>,
    stderr: Mutex<ChannelSync>,
    condvar: Condvar,
}

#[cfg(windows)]
struct ExecutionLogState {
    path: PathBuf,
    file: Arc<Mutex<File>>,
    saved_stdout: SendHandle,
    saved_stderr: SendHandle,
    write_stdout: SendHandle,
    write_stderr: SendHandle,
    readers: Vec<std::thread::JoinHandle<()>>,
    sync: Arc<SharedSync>,
}

#[cfg(windows)]
static STATE: Mutex<Option<ExecutionLogState>> = Mutex::new(None);

#[cfg(windows)]
pub fn initialize_execution_log(log_dir: &Path, args: &[String]) -> std::io::Result<()> {
    let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    if state.is_some() {
        return Ok(());
    }

    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    builder.create(log_dir)?;
    for subdirectory in super::payload_logs::LLM_PAYLOAD_LOG_DIRECTORIES {
        builder.create(log_dir.join(subdirectory))?;
    }

    let file_name = format!(
        "astroom_{}_{}_p{}_{}.log",
        command_identifier(args),
        timestamp_for_file(),
        std::process::id(),
        uuid::Uuid::new_v4()
    );
    let file_path = log_dir.join(file_name);
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&file_path)?;

    let saved_stdout = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
    let saved_stderr = unsafe { GetStdHandle(STD_ERROR_HANDLE) };
    if saved_stdout.is_null()
        || saved_stdout == INVALID_HANDLE_VALUE
        || saved_stderr.is_null()
        || saved_stderr == INVALID_HANDLE_VALUE
    {
        return Err(std::io::Error::other("Invalid standard handle"));
    }

    let sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: 1,
    };

    let mut stdout_read: HANDLE = std::ptr::null_mut();
    let mut stdout_write: HANDLE = std::ptr::null_mut();
    if unsafe { CreatePipe(&mut stdout_read, &mut stdout_write, &sa, 0) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    unsafe {
        windows_sys::Win32::Foundation::SetHandleInformation(stdout_read, HANDLE_FLAG_INHERIT, 0);
    }

    let mut stderr_read: HANDLE = std::ptr::null_mut();
    let mut stderr_write: HANDLE = std::ptr::null_mut();
    if unsafe { CreatePipe(&mut stderr_read, &mut stderr_write, &sa, 0) } == 0 {
        let err = std::io::Error::last_os_error();
        unsafe {
            CloseHandle(stdout_read);
            CloseHandle(stdout_write);
        }
        return Err(err);
    }
    unsafe {
        windows_sys::Win32::Foundation::SetHandleInformation(stderr_read, HANDLE_FLAG_INHERIT, 0);
    }

    let ok_out = unsafe { SetStdHandle(STD_OUTPUT_HANDLE, stdout_write) };
    let ok_err = unsafe { SetStdHandle(STD_ERROR_HANDLE, stderr_write) };
    if ok_out == 0 || ok_err == 0 {
        let err = std::io::Error::last_os_error();
        unsafe {
            SetStdHandle(STD_OUTPUT_HANDLE, saved_stdout);
            SetStdHandle(STD_ERROR_HANDLE, saved_stderr);
            CloseHandle(stdout_read);
            CloseHandle(stdout_write);
            CloseHandle(stderr_read);
            CloseHandle(stderr_write);
        }
        return Err(err);
    }

    let shared_file = Arc::new(Mutex::new(file));
    let sync = Arc::new(SharedSync {
        stdout: Mutex::new(ChannelSync {
            read_handle: SendHandle(stdout_read),
            busy: false,
            cycles: 0,
        }),
        stderr: Mutex::new(ChannelSync {
            read_handle: SendHandle(stderr_read),
            busy: false,
            cycles: 0,
        }),
        condvar: Condvar::new(),
    });

    let readers = vec![
        spawn_reader(
            "stdout",
            SendHandle(stdout_read),
            SendHandle(saved_stdout),
            Arc::clone(&shared_file),
            Arc::clone(&sync),
        ),
        spawn_reader(
            "stderr",
            SendHandle(stderr_read),
            SendHandle(saved_stderr),
            Arc::clone(&shared_file),
            Arc::clone(&sync),
        ),
    ];

    *state = Some(ExecutionLogState {
        path: file_path,
        file: shared_file,
        saved_stdout: SendHandle(saved_stdout),
        saved_stderr: SendHandle(saved_stderr),
        write_stdout: SendHandle(stdout_write),
        write_stderr: SendHandle(stderr_write),
        readers,
        sync,
    });
    Ok(())
}

#[cfg(windows)]
pub fn is_stdout_terminal() -> bool {
    let state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(state) = state.as_ref() {
        let mut mode = 0u32;
        unsafe { GetConsoleMode(state.saved_stdout.as_raw(), &mut mode) != 0 }
    } else {
        std::io::IsTerminal::is_terminal(&std::io::stdout())
    }
}

#[cfg(windows)]
pub fn is_tee_active() -> bool {
    let state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    state.is_some()
}

#[cfg(windows)]
pub fn get_saved_stdout() -> Option<HANDLE> {
    let state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    state.as_ref().map(|s| s.saved_stdout.as_raw())
}

#[cfg(windows)]
pub fn execution_log_path() -> Option<PathBuf> {
    STATE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|state| state.path.clone())
}

#[cfg(windows)]
pub fn close_execution_log() {
    let mut state_guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let mut state = match state_guard.take() {
        Some(state) => state,
        None => return,
    };

    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();

    unsafe {
        SetStdHandle(STD_OUTPUT_HANDLE, state.saved_stdout.as_raw());
        SetStdHandle(STD_ERROR_HANDLE, state.saved_stderr.as_raw());
        CloseHandle(state.write_stdout.as_raw());
        CloseHandle(state.write_stderr.as_raw());
    }

    for reader in state.readers.drain(..) {
        let _ = reader.join();
    }

    let final_result = state.file.lock().map(|mut file| {
        if let Ok(contents) = std::fs::read_to_string(&state.path) {
            let plain_text = crate::logging::strip_ansi(&contents);
            if plain_text != contents {
                let _ = file.set_len(0);
                let _ = file.seek(std::io::SeekFrom::Start(0));
                let _ = file.write_all(plain_text.as_bytes());
            }
        }
        file.sync_all()
    });
    let _ = final_result;
}

#[cfg(windows)]
pub fn flush_execution_log() {
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();

    let sync = {
        let state = STATE.lock().unwrap_or_else(|e| e.into_inner());
        match state.as_ref() {
            Some(s) => Arc::clone(&s.sync),
            None => return,
        }
    };

    let drain_channel = |channel_name: &str| loop {
        let (read_handle, is_busy) = {
            let chan = if channel_name == "stdout" {
                sync.stdout.lock().unwrap_or_else(|e| e.into_inner())
            } else {
                sync.stderr.lock().unwrap_or_else(|e| e.into_inner())
            };
            (chan.read_handle.as_raw(), chan.busy)
        };

        let mut total_bytes_avail = 0u32;
        let peek_res = unsafe {
            PeekNamedPipe(
                read_handle,
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut total_bytes_avail,
                std::ptr::null_mut(),
            )
        };
        let has_pending_bytes = peek_res != 0 && total_bytes_avail > 0;

        if !has_pending_bytes && !is_busy {
            break;
        }

        let chan = if channel_name == "stdout" {
            sync.stdout.lock().unwrap_or_else(|e| e.into_inner())
        } else {
            sync.stderr.lock().unwrap_or_else(|e| e.into_inner())
        };
        let _ = sync
            .condvar
            .wait_timeout(chan, std::time::Duration::from_millis(50));
    };

    drain_channel("stderr");
    drain_channel("stdout");

    let state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(s) = state.as_ref() {
        if let Ok(file) = s.file.lock() {
            let _ = file.sync_data();
        }
    }
}

#[cfg(windows)]
fn spawn_reader(
    channel_name: &'static str,
    read_handle: SendHandle,
    mirror_handle: SendHandle,
    file: Arc<Mutex<File>>,
    sync: Arc<SharedSync>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let _ = &read_handle;
        let _ = &mirror_handle;
        let mut buffer = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::with_capacity(16384);
        loop {
            // Signal idle
            {
                let mut chan = if channel_name == "stdout" {
                    sync.stdout.lock().unwrap_or_else(|e| e.into_inner())
                } else {
                    sync.stderr.lock().unwrap_or_else(|e| e.into_inner())
                };
                chan.busy = false;
                sync.condvar.notify_all();
            }

            let mut bytes_read = 0u32;
            let success = unsafe {
                ReadFile(
                    read_handle.as_raw(),
                    buffer.as_mut_ptr() as *mut _,
                    buffer.len() as u32,
                    &mut bytes_read,
                    std::ptr::null_mut(),
                )
            };

            if success == 0 || bytes_read == 0 {
                break;
            }

            // Signal busy
            {
                let mut chan = if channel_name == "stdout" {
                    sync.stdout.lock().unwrap_or_else(|e| e.into_inner())
                } else {
                    sync.stderr.lock().unwrap_or_else(|e| e.into_inner())
                };
                chan.busy = true;
            }

            pending.extend_from_slice(&buffer[..bytes_read as usize]);

            // Check if more data is waiting in the pipe
            let mut total_bytes_avail = 0u32;
            let peek_res = unsafe {
                PeekNamedPipe(
                    read_handle.as_raw(),
                    std::ptr::null_mut(),
                    0,
                    std::ptr::null_mut(),
                    &mut total_bytes_avail,
                    std::ptr::null_mut(),
                )
            };
            let has_more = peek_res != 0 && total_bytes_avail > 0;

            let emit_chunk = if has_more && pending.len() < 65536 {
                if let Some(last_nl) = pending.iter().rposition(|&b| b == b'\n') {
                    let to_emit = pending.drain(..=last_nl).collect::<Vec<u8>>();
                    Some(to_emit)
                } else {
                    None
                }
            } else if !pending.is_empty() {
                Some(std::mem::take(&mut pending))
            } else {
                None
            };

            if let Some(chunk) = emit_chunk {
                {
                    let _guard = crate::logging::console_output::lock_console();
                    write_all_handle(mirror_handle.as_raw(), &chunk);
                }
                let plain_text = crate::logging::strip_ansi(&String::from_utf8_lossy(&chunk));
                if !plain_text.is_empty() {
                    if let Ok(mut log) = file.lock() {
                        let _ = log.write_all(plain_text.as_bytes());
                    }
                }
            }

            // Processing cycle completed
            {
                let mut chan = if channel_name == "stdout" {
                    sync.stdout.lock().unwrap_or_else(|e| e.into_inner())
                } else {
                    sync.stderr.lock().unwrap_or_else(|e| e.into_inner())
                };
                chan.cycles += 1;
                chan.busy = !pending.is_empty();
                sync.condvar.notify_all();
            }
        }

        if !pending.is_empty() {
            {
                let _guard = crate::logging::console_output::lock_console();
                write_all_handle(mirror_handle.as_raw(), &pending);
            }
            let plain_text = crate::logging::strip_ansi(&String::from_utf8_lossy(&pending));
            if !plain_text.is_empty() {
                if let Ok(mut log) = file.lock() {
                    let _ = log.write_all(plain_text.as_bytes());
                }
            }
        }

        unsafe { CloseHandle(read_handle.as_raw()) };

        let mut chan = if channel_name == "stdout" {
            sync.stdout.lock().unwrap_or_else(|e| e.into_inner())
        } else {
            sync.stderr.lock().unwrap_or_else(|e| e.into_inner())
        };
        chan.busy = false;
        sync.condvar.notify_all();
    })
}

#[cfg(windows)]
fn write_all_handle(handle: HANDLE, mut data: &[u8]) {
    while !data.is_empty() {
        let chunk_len = data.len().min(u32::MAX as usize) as u32;
        let mut written = 0u32;
        let res = unsafe {
            WriteFile(
                handle,
                data.as_ptr() as *const _,
                chunk_len,
                &mut written,
                std::ptr::null_mut(),
            )
        };
        if res == 0 || written == 0 {
            break;
        }
        data = &data[written as usize..];
    }
}
