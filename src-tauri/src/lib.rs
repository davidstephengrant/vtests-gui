use tauri::Emitter;
use tokio::io::{AsyncReadExt, BufReader};
use tokio::process::Command;
use std::process::Stdio;

#[tauri::command]
fn path_exists(path: &str) -> bool {
    std::path::Path::new(path).exists()
}

#[tauri::command]
fn platform() -> &'static str {
    if cfg!(target_os = "windows") { "windows" }
    else if cfg!(target_os = "macos") { "macos" }
    else { "linux" }
}

#[tauri::command]
async fn command_exists(name: String) -> bool {
    // std::process::Command::output blocks — spawn_blocking so we don't stall
    // the tokio runtime while `which`/`where` forks and execs.
    let finder = if cfg!(windows) { "where" } else { "which" };
    tokio::task::spawn_blocking(move || {
        std::process::Command::new(finder)
            .arg(name)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

#[tauri::command]
fn open_path(path: &str, app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_executable_version(path: String) -> Option<String> {
    get_version(path).await
}

#[cfg(target_os = "linux")]
async fn get_version(path: String) -> Option<String> {
    if let Some(v) = get_version_from_squashfs(path.clone()).await {
        return Some(v);
    }
    let filename = std::path::Path::new(&path).file_name()?.to_str()?.to_owned();
    extract_version_from_str(&filename)
}

#[cfg(target_os = "linux")]
fn find_squashfs_offset(path: &str) -> Option<u64> {
    use std::io::Read;
    // AppImages are an ELF runtime followed by a squashfs filesystem.
    // We find the squashfs by scanning for its little-endian magic bytes.
    // The runtime is typically 1–5 MB, so 20 MB is a safe upper bound.
    // Scan in chunks with a 3-byte carry so the 4-byte magic is still seen
    // when it straddles a read boundary.
    const CHUNK: usize = 64 * 1024;
    const MAX_SCAN: u64 = 20 * 1024 * 1024;
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = [0u8; 3 + CHUNK];
    let mut carry_len: usize = 0;
    let mut read_total: u64 = 0;
    loop {
        if read_total >= MAX_SCAN {
            return None;
        }
        let want = std::cmp::min(CHUNK as u64, MAX_SCAN - read_total) as usize;
        let n = file.read(&mut buf[carry_len..carry_len + want]).ok()?;
        if n == 0 {
            return None;
        }
        let valid = carry_len + n;
        if let Some(pos) = buf[..valid].windows(4).position(|w| w == b"hsqs") {
            // buf[0] sits at file offset (read_total - carry_len), so the
            // match at buf[pos] is at that offset plus pos.
            return Some(read_total - carry_len as u64 + pos as u64);
        }
        read_total += n as u64;
        let new_carry = std::cmp::min(3, valid);
        buf.copy_within(valid - new_carry..valid, 0);
        carry_len = new_carry;
    }
}

#[cfg(target_os = "linux")]
async fn get_version_from_squashfs(path: String) -> Option<String> {
    // find_squashfs_offset does file I/O and unsquashfs forks a subprocess;
    // both are blocking, so they run on a dedicated blocking thread.
    tokio::task::spawn_blocking(move || {
        let offset = find_squashfs_offset(&path)?;
        let output = std::process::Command::new("unsquashfs")
            .args(["-q", "-o", &offset.to_string(), "-cat", &path, "*.desktop"])
            .output()
            .ok()?;
        if output.stdout.is_empty() {
            return None;
        }
        let content = String::from_utf8_lossy(&output.stdout);
        // Prefer X-AppImage-Version if present, then fall back to Version=
        for line in content.lines() {
            if let Some(v) = line.strip_prefix("X-AppImage-Version=") {
                let v = v.trim();
                if !v.is_empty() { return Some(v.to_string()); }
            }
        }
        for line in content.lines() {
            if let Some(v) = line.strip_prefix("Version=") {
                let v = v.trim();
                // Skip the desktop spec version declaration
                if v != "1.0" && !v.is_empty() && is_version_like(v) {
                    return Some(v.to_string());
                }
            }
        }
        None
    })
    .await
    .ok()
    .flatten()
}

#[cfg(target_os = "linux")]
fn is_version_like(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    parts.len() >= 2 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

#[cfg(target_os = "macos")]
async fn get_version(path: String) -> Option<String> {
    // Reading the plist blocks on disk I/O — keep the runtime free.
    tokio::task::spawn_blocking(move || {
        let plist = std::fs::read_to_string(format!("{}/Contents/Info.plist", path)).ok()?;
        parse_plist_string_value(&plist, "CFBundleShortVersionString")
            .or_else(|| parse_plist_string_value(&plist, "CFBundleVersion"))
    })
    .await
    .ok()
    .flatten()
}

#[cfg(target_os = "windows")]
async fn get_version(path: String) -> Option<String> {
    // FileMap::open memory-maps the executable and pelite walks PE resources
    // synchronously. Spawn on the blocking pool so the runtime isn't stalled.
    tokio::task::spawn_blocking(move || {
        use pelite::FileMap;
        let map = FileMap::open(&path).ok()?;
        let bytes = map.as_ref();

        macro_rules! try_pe {
            ($module:ident) => {{
                use pelite::$module::PeFile;
                if let Ok(pe) = PeFile::from_bytes(bytes) {
                    if let Ok(res) = pe.resources() {
                        if let Ok(vi) = res.version_info() {
                            if let Some(f) = vi.fixed() {
                                let major = f.dwFileVersionMS >> 16;
                                let minor = f.dwFileVersionMS & 0xFFFF;
                                let patch = f.dwFileVersionLS >> 16;
                                let build = f.dwFileVersionLS & 0xFFFF;
                                return Some(format!("{}.{}.{}.{}", major, minor, patch, build));
                            }
                        }
                    }
                }
            }};
        }

        try_pe!(pe64);
        try_pe!(pe32);
        None
    })
    .await
    .ok()
    .flatten()
}

#[cfg(target_os = "linux")]
fn extract_version_from_str(s: &str) -> Option<String> {
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_ascii_digit() {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                i += 1;
            }
            let candidate: String = chars[start..i].iter().collect();
            if candidate.matches('.').count() >= 2
                && candidate.ends_with(|c: char| c.is_ascii_digit())
            {
                return Some(candidate);
            }
        } else {
            i += 1;
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn parse_plist_string_value(plist: &str, key: &str) -> Option<String> {
    let key_tag = format!("<key>{}</key>", key);
    let after = &plist[plist.find(&key_tag)? + key_tag.len()..];
    let start = after.find("<string>")? + "<string>".len();
    let end = after[start..].find("</string>")?;
    let value = after[start..start + end].trim().to_string();
    if value.is_empty() { None } else { Some(value) }
}

#[tauri::command]
fn set_executable(path: &str) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path).map_err(|e| e.to_string())?.permissions();
        perms.set_mode(perms.mode() | 0o111);
        std::fs::set_permissions(path, perms).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn prepare_output_dir(workdir: &str, subdir: &str) -> Result<(), String> {
    // The contract is encoded in the signature: callers pass the workdir and
    // pick a subdir name from a fixed allowlist. We never rm -rf an arbitrary
    // path from the frontend.
    if !matches!(subdir, "ref" | "current" | "diff") {
        return Err(format!("invalid subdir: {}", subdir));
    }

    // Canonicalize to resolve symlinks so a symlinked workdir → / can't sneak
    // past the depth/home guards.
    let canonical = std::fs::canonicalize(workdir)
        .map_err(|e| format!("cannot canonicalize workdir {}: {}", workdir, e))?;
    if !canonical.is_dir() {
        return Err(format!("workdir is not a directory: {}", canonical.display()));
    }

    reject_sensitive_workdir(&canonical)?;

    let target = canonical.join(subdir);
    if target.exists() {
        std::fs::remove_dir_all(&target).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    Ok(())
}

fn reject_sensitive_workdir(p: &std::path::Path) -> Result<(), String> {
    // Depth guard: 3+ normal components rules out /, /home, /Users, /etc,
    // /var, /tmp, C:\, C:\Users, etc. Note: on macOS this also rejects
    // /Volumes/<disk> as a direct workdir — users on external drives must
    // nest one level deeper (e.g. /Volumes/<disk>/vtests-work).
    let depth = p.components()
        .filter(|c| matches!(c, std::path::Component::Normal(_)))
        .count();
    if depth < 3 {
        return Err(format!("refusing shallow workdir: {}", p.display()));
    }

    // Explicitly refuse the user's home directory itself, even if deep.
    if let Some(home) = home_dir() {
        let home_canonical = std::fs::canonicalize(&home).unwrap_or(home);
        if p == home_canonical {
            return Err(format!("refusing home directory as workdir: {}", p.display()));
        }
    }

    Ok(())
}

fn home_dir() -> Option<std::path::PathBuf> {
    #[cfg(windows)]
    { std::env::var_os("USERPROFILE").map(std::path::PathBuf::from) }
    #[cfg(not(windows))]
    { std::env::var_os("HOME").map(std::path::PathBuf::from) }
}

#[cfg(windows)]
mod win_job {
    use std::ptr;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    pub struct Job(HANDLE);
    // HANDLE is an opaque kernel handle; the OS guarantees thread-safety for
    // the job operations we use, and closing from another thread is fine.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        /// A job that kills every assigned process when the final handle is
        /// closed — our safety net if the app itself dies mid-run.
        pub fn new_kill_on_close() -> Option<Self> {
            unsafe {
                let h = CreateJobObjectW(ptr::null(), ptr::null());
                if h.is_null() {
                    return None;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    h,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    CloseHandle(h);
                    return None;
                }
                Some(Job(h))
            }
        }

        pub fn assign(&self, pid: u32) -> bool {
            unsafe {
                let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
                if process.is_null() {
                    return false;
                }
                let ok = AssignProcessToJobObject(self.0, process);
                CloseHandle(process);
                ok != 0
            }
        }

        pub fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[derive(Default)]
struct RunState {
    pid: Option<u32>,
    #[cfg(windows)]
    job: Option<win_job::Job>,
}

struct Running(parking_lot::Mutex<RunState>);

// Stream bytes from `reader` to the "terminal-output" event, emitting only
// complete UTF-8 sequences. A multi-byte char split across two reads would
// otherwise be lossily replaced with U+FFFD on each half.
async fn read_and_emit<R>(reader: R, window: tauri::Window)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut reader = BufReader::new(reader);
    let mut buf = [0u8; 1024];
    let mut pending: Vec<u8> = Vec::new();
    loop {
        let n = match reader.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        pending.extend_from_slice(&buf[..n]);
        drain_valid_utf8(&window, &mut pending);
    }
    // Flush any trailing partial bytes at EOF with lossy replacement.
    if !pending.is_empty() {
        let _ = window.emit(
            "terminal-output",
            String::from_utf8_lossy(&pending).into_owned(),
        );
    }
}

fn drain_valid_utf8(window: &tauri::Window, pending: &mut Vec<u8>) {
    loop {
        let (valid_upto, error_len) = match std::str::from_utf8(pending) {
            Ok(s) => (s.len(), None),
            Err(e) => (e.valid_up_to(), e.error_len()),
        };
        if valid_upto > 0 {
            let chunk = std::str::from_utf8(&pending[..valid_upto])
                .expect("verified valid UTF-8 prefix")
                .to_owned();
            let _ = window.emit("terminal-output", chunk);
        }
        match error_len {
            // A genuinely invalid sequence of `n` bytes: replace and skip so
            // pending can't grow without bound on bad input.
            Some(n) => {
                let _ = window.emit("terminal-output", "\u{FFFD}".to_string());
                pending.drain(..valid_upto + n);
            }
            // Either fully consumed or a truncation at the end — keep the
            // remainder for the next read.
            None => {
                pending.drain(..valid_upto);
                return;
            }
        }
    }
}

#[tauri::command]
async fn run_command(
    window: tauri::Window,
    state: tauri::State<'_, Running>,
    program: String,
    args: Vec<String>,
) -> Result<Option<i32>, String> {
    // Always clear the tracked state and notify the UI that the run ended,
    // even on early return, so buttons never stay disabled on error.
    // `status` is None for spawn/wait errors and signal-terminated children;
    // a concrete exit code otherwise.
    struct Cleanup<'a> {
        state: &'a Running,
        window: &'a tauri::Window,
        status: Option<i32>,
    }
    impl Drop for Cleanup<'_> {
        fn drop(&mut self) {
            // Dropping the RunState also drops any Windows Job handle. By now
            // wait() has already returned, so the child is gone and closing
            // the job has no live processes to kill.
            *self.state.0.lock() = RunState::default();
            let _ = self.window.emit("terminal-done", self.status);
        }
    }
    let mut cleanup = Cleanup { state: &state, window: &window, status: None };

    // On Windows, .sh scripts can't execute directly. Route them through bash
    // so Git Bash or WSL installs work transparently. If bash isn't on PATH,
    // the spawn error below will surface with a hint.
    let uses_bash_shim = cfg!(windows) && program.to_lowercase().ends_with(".sh");
    let mut cmd = if uses_bash_shim {
        let mut c = Command::new("bash");
        c.arg(&program);
        c
    } else {
        Command::new(&program)
    };
    cmd.args(&args).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd.spawn().map_err(|e| {
        let hint = if uses_bash_shim { " (is bash on PATH?)" } else { "" };
        let msg = format!("\r\n\x1b[31mError: failed to start: {}{}\x1b[0m\r\n", e, hint);
        let _ = window.emit("terminal-output", msg);
        e.to_string()
    })?;

    {
        let pid = child.id();
        let mut st = state.0.lock();
        st.pid = pid;
        // On Windows, wrap the child in a Job Object so cancel_command can
        // terminate the whole process tree reliably. If job creation or
        // assignment fails we silently fall back to taskkill /T in
        // cancel_command — best-effort is better than nothing here.
        #[cfg(windows)]
        if let (Some(pid), Some(job)) = (pid, win_job::Job::new_kill_on_close()) {
            if job.assign(pid) {
                st.job = Some(job);
            }
        }
    }

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    let w1 = window.clone();
    let stdout_task = tokio::spawn(async move { read_and_emit(stdout, w1).await; });

    let w2 = window.clone();
    let stderr_task = tokio::spawn(async move { read_and_emit(stderr, w2).await; });

    let _ = stdout_task.await;
    let _ = stderr_task.await;
    // Clear the PID as soon as stdio drains: once wait() returns the kernel
    // is free to recycle the PID, so a late Stop click could otherwise target
    // an unrelated process group. The job handle stays until Cleanup drops —
    // closing it here would kill the child before wait() observes its exit.
    state.0.lock().pid = None;
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let code = status.code();
    cleanup.status = code;

    Ok(code)
}

#[tauri::command]
async fn cancel_command(state: tauri::State<'_, Running>) -> Result<(), ()> {
    let pid = state.0.lock().pid;
    if let Some(pid) = pid {
        #[cfg(unix)]
        if pid > 1 {
            // SIGTERM first so GUI apps (e.g. MuseScore) can unregister from the
            // desktop session manager before dying, which prevents session logout.
            unsafe { libc::killpg(pid as libc::pid_t, libc::SIGTERM); }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            // Re-check the tracked PID before escalating: if the child already
            // exited, run_command has cleared state and the kernel may have
            // recycled the PID for an unrelated process group.
            if state.0.lock().pid == Some(pid) {
                unsafe { libc::killpg(pid as libc::pid_t, libc::SIGKILL); }
            }
        }
        #[cfg(windows)]
        {
            // Prefer TerminateJobObject — it takes down the entire process
            // tree atomically, including any grandchildren the script spawned
            // (imagemagick, MuseScore, etc.). Fall back to taskkill /T only if
            // we failed to create or assign the job at spawn time.
            let had_job = {
                let st = state.0.lock();
                if let Some(job) = st.job.as_ref() {
                    job.terminate();
                    true
                } else {
                    false
                }
            };
            if !had_job {
                let _ = Command::new("taskkill")
                    .args(["/F", "/T", "/PID", &pid.to_string()])
                    .status()
                    .await;
            }
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The CSP in tauri.conf.json includes `style-src 'self' 'unsafe-inline'`.
    // 'unsafe-inline' is required because xterm.js injects dynamic <style>
    // rules at runtime for per-terminal theming and sizing. Removing it
    // breaks terminal rendering. JSON has no comments, hence this note.
    tauri::Builder::default()
        .manage(Running(parking_lot::Mutex::new(RunState::default())))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![path_exists, platform, command_exists, open_path, set_executable, prepare_output_dir, run_command, cancel_command, get_executable_version])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
