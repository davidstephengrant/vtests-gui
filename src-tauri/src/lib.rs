use tauri::{Emitter, Manager};
use tokio::io::{AsyncReadExt, BufReader};
use tokio::process::Command;
use std::process::Stdio;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

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

#[derive(serde::Serialize, serde::Deserialize)]
struct TestfileRename {
    from: String,
    to: String,
}

#[derive(serde::Serialize)]
struct RenameResult {
    from: String,
    to: String,
    error: Option<String>,
}

fn is_valid_basename(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn sanitize_basename(name: &str) -> String {
    // Collapse each run of invalid chars to a single underscore, so
    // `My Score (v2).mscz` becomes `My_Score_v2_.mscz` rather than a string
    // of underscores for every space, paren, and letter stripped out.
    let mut out = String::with_capacity(name.len());
    let mut in_run = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('_');
            in_run = true;
        }
    }
    if out.is_empty() {
        out.push('_');
    }
    out
}

fn make_unique(name: &str, taken: &std::collections::HashSet<String>) -> String {
    if !taken.contains(name) {
        return name.to_string();
    }
    // Suffix before the extension. Don't treat a leading dot as an extension
    // separator so dotfiles like `.foo` aren't split into ("", ".foo").
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let mut n = 1u32;
    loop {
        let candidate = format!("{}_{}{}", stem, n, ext);
        if !taken.contains(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

fn collect_files(
    dir: &std::path::Path,
    by_parent: &mut std::collections::HashMap<std::path::PathBuf, Vec<std::path::PathBuf>>,
) -> std::io::Result<()> {
    let mut files_here = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        // Skip symlinks so a loop or out-of-tree link can't fool the walker.
        let ft = entry.file_type()?;
        if ft.is_symlink() {
            continue;
        }
        let path = entry.path();
        if ft.is_dir() {
            collect_files(&path, by_parent)?;
        } else if ft.is_file() {
            files_here.push(path);
        }
    }
    if !files_here.is_empty() {
        by_parent.insert(dir.to_path_buf(), files_here);
    }
    Ok(())
}

#[tauri::command]
fn scan_testfile_names(dir: &str) -> Result<Vec<TestfileRename>, String> {
    let root = std::path::Path::new(dir);
    if !root.is_dir() {
        return Err(format!("not a directory: {}", dir));
    }

    let mut by_parent: std::collections::HashMap<
        std::path::PathBuf,
        Vec<std::path::PathBuf>,
    > = std::collections::HashMap::new();
    collect_files(root, &mut by_parent).map_err(|e| e.to_string())?;

    let mut renames: Vec<TestfileRename> = Vec::new();
    for (parent, files) in &by_parent {
        // Seed `taken` with names we're NOT renaming (i.e. already valid),
        // so suffixing can't collide with a file we're leaving alone.
        let mut taken: std::collections::HashSet<String> = files
            .iter()
            .filter_map(|p| p.file_name().and_then(|n| n.to_str()))
            .filter(|n| is_valid_basename(n))
            .map(String::from)
            .collect();

        let mut invalid: Vec<&std::path::PathBuf> = files
            .iter()
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| !is_valid_basename(n))
            })
            .collect();
        // Sort so the same dir always yields the same suffix assignment.
        invalid.sort();

        for file in invalid {
            let Some(name) = file.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let sanitized = sanitize_basename(name);
            let unique = make_unique(&sanitized, &taken);
            taken.insert(unique.clone());
            let to = parent.join(&unique);
            renames.push(TestfileRename {
                from: file.to_string_lossy().into_owned(),
                to: to.to_string_lossy().into_owned(),
            });
        }
    }
    renames.sort_by(|a, b| a.from.cmp(&b.from));
    Ok(renames)
}

fn is_score_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".mscz") || lower.ends_with(".mscx")
}

/// Count score files at the top level of `dir` only. `vtest-generate-pngs.sh`
/// uses `ls -p | grep -v /` to build its job list, so it doesn't descend into
/// subdirectories — matching that keeps our progress denominator honest.
#[tauri::command]
fn count_scores(dir: &str) -> Result<u32, String> {
    let root = std::path::Path::new(dir);
    if !root.is_dir() {
        return Err(format!("not a directory: {}", dir));
    }
    let mut count = 0u32;
    for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        if !ft.is_file() {
            continue;
        }
        if let Some(name) = entry.file_name().to_str() {
            if is_score_file(name) {
                count += 1;
            }
        }
    }
    Ok(count)
}

/// Count unique source-score stems among the PNGs in `dir`. mscore emits PNGs
/// named `<stem>-<page>.png`, where `<page>` is an integer. Stripping a
/// trailing `-<digits>` groups pages back to their source score, so repeated
/// pages from one score only count once toward progress.
#[tauri::command]
fn count_processed_scores(dir: &str) -> Result<u32, String> {
    let root = std::path::Path::new(dir);
    if !root.is_dir() {
        // The dir may legitimately not exist yet (e.g. polling starts before
        // prepare_output_dir finishes on a cold start), so 0 is the right
        // answer rather than an error.
        return Ok(0);
    }
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let Some(name) = entry.file_name().to_str().map(String::from) else { continue };
        if !name.to_ascii_lowercase().ends_with(".png") {
            continue;
        }
        // Strip ".png" (case-insensitive on the already-lowered suffix check
        // above, case-preserving on the stem we keep).
        let stem = &name[..name.len() - 4];
        // Strip the final `-<digits>` if present. A score named
        // `accidental-10.mscz` renders to `accidental-10-1.png`; stripping once
        // leaves `accidental-10`, which is the grouping we want.
        let grouped = match stem.rfind('-') {
            Some(i) if i + 1 < stem.len() && stem[i + 1..].chars().all(|c| c.is_ascii_digit()) => {
                &stem[..i]
            }
            _ => stem,
        };
        seen.insert(grouped.to_string());
    }
    Ok(seen.len() as u32)
}

#[tauri::command]
fn count_pngs(dir: &str) -> Result<u32, String> {
    let root = std::path::Path::new(dir);
    if !root.is_dir() {
        return Ok(0);
    }
    let mut count = 0u32;
    for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if let Some(name) = entry.file_name().to_str() {
            if name.to_ascii_lowercase().ends_with(".png") {
                count += 1;
            }
        }
    }
    Ok(count)
}

#[tauri::command]
fn rename_testfiles(renames: Vec<TestfileRename>) -> Vec<RenameResult> {
    renames
        .into_iter()
        .map(|r| {
            let to_path = std::path::Path::new(&r.to);
            // Last-resort guard: scan_testfile_names already suffixes to avoid
            // collisions, but the FS state may have shifted since. Never
            // overwrite an existing entry here.
            let error = if to_path.exists() {
                Some(format!("target already exists: {}", r.to))
            } else {
                std::fs::rename(&r.from, &r.to).err().map(|e| e.to_string())
            };
            RenameResult {
                from: r.from,
                to: r.to,
                error,
            }
        })
        .collect()
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
    // Guards against logging the stop marker twice if the user clicks Stop
    // more than once during a single run.
    stop_logged: bool,
}

// One log file shared across the whole session. init_session_log installs the
// handle; every subsequent run_command, cancel_command, and log_event write
// into it. Outer Mutex so init can replace the inner Option atomically.
struct SessionLog(parking_lot::Mutex<Option<LogHandle>>);
struct LogDir(parking_lot::Mutex<Option<PathBuf>>);

struct Running(parking_lot::Mutex<RunState>);

// Writes timestamped, line-by-line copies of the script stream to a log file.
// Shared across stdout/stderr tasks via Arc<Mutex<_>>; `at_line_start` is a
// single global flag so timestamps land at true line starts even when the two
// streams interleave mid-line.
struct LineLogger {
    file: std::fs::File,
    at_line_start: bool,
}

impl LineLogger {
    // Write a single log-status line (e.g. "[stopped by user]") with a
    // timestamp. If the script was mid-line, inject a newline first so the
    // marker doesn't concat onto the partial line. Used only for GUI-
    // originated events, not script output.
    fn write_line(&mut self, s: &str) {
        if !self.at_line_start {
            let _ = self.file.write_all(b"\n");
            self.at_line_start = true;
        }
        self.write_chunk(&format!("{}\n", s));
    }

    fn write_chunk(&mut self, s: &str) {
        let bytes = s.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if self.at_line_start {
                let ts = chrono::Local::now().format("%H:%M:%S%.3f");
                let _ = write!(self.file, "[{}] ", ts);
                self.at_line_start = false;
            }
            let end = match bytes[i..].iter().position(|&b| b == b'\n') {
                Some(p) => i + p + 1,
                None => bytes.len(),
            };
            let _ = self.file.write_all(&bytes[i..end]);
            if end > i && bytes[end - 1] == b'\n' {
                self.at_line_start = true;
            }
            i = end;
        }
    }
}

type LogHandle = Arc<Mutex<LineLogger>>;

// Initialize the per-session log file in the OS app-data log dir, rotating
// older session logs so only `keep` remain after this one is created.
// Returns the absolute path of the new log file. Called once at app start.
#[tauri::command]
fn init_session_log(
    app: tauri::AppHandle,
    session_log: tauri::State<SessionLog>,
    log_dir: tauri::State<LogDir>,
    keep: u32,
) -> Result<String, String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let mut existing: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("vtests-gui-") && n.ends_with(".log"))
                .unwrap_or(false)
        })
        .collect();
    existing.sort();
    // Keep up to (keep - 1) of the most recent so after we create the new one
    // the total sits at `keep`.
    let keep_prev = keep.saturating_sub(1) as usize;
    if existing.len() > keep_prev {
        let drop_count = existing.len() - keep_prev;
        for path in existing.iter().take(drop_count) {
            let _ = std::fs::remove_file(path);
        }
    }

    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let path = dir.join(format!("vtests-gui-{}.log", ts));
    let file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    let handle: LogHandle = Arc::new(Mutex::new(LineLogger { file, at_line_start: true }));
    *session_log.0.lock() = Some(handle);
    *log_dir.0.lock() = Some(dir);
    Ok(path.to_string_lossy().into_owned())
}

// Append a single timestamped line to the session log. No-op if the log
// hasn't been initialized (or failed to initialize).
#[tauri::command]
fn log_event(message: String, session_log: tauri::State<SessionLog>) {
    let handle = session_log.0.lock().clone();
    if let Some(log) = handle {
        if let Ok(mut l) = log.lock() { l.write_line(&message); }
    }
}

// Path of the session log directory, for the "Open log directory" button.
#[tauri::command]
fn get_log_dir(log_dir: tauri::State<LogDir>) -> Option<String> {
    log_dir.0.lock().as_ref().map(|p| p.to_string_lossy().into_owned())
}

// Stream bytes from `reader` to the "terminal-output" event, emitting only
// complete UTF-8 sequences. A multi-byte char split across two reads would
// otherwise be lossily replaced with U+FFFD on each half.
async fn read_and_emit<R>(reader: R, window: tauri::Window, logger: Option<LogHandle>)
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
        drain_valid_utf8(&window, &mut pending, logger.as_ref());
    }
    // Flush any trailing partial bytes at EOF with lossy replacement.
    if !pending.is_empty() {
        let tail = String::from_utf8_lossy(&pending).into_owned();
        if let Some(log) = logger.as_ref() {
            if let Ok(mut l) = log.lock() { l.write_chunk(&tail); }
        }
        let _ = window.emit("terminal-output", tail);
    }
}

fn drain_valid_utf8(window: &tauri::Window, pending: &mut Vec<u8>, logger: Option<&LogHandle>) {
    loop {
        let (valid_upto, error_len) = match std::str::from_utf8(pending) {
            Ok(s) => (s.len(), None),
            Err(e) => (e.valid_up_to(), e.error_len()),
        };
        if valid_upto > 0 {
            let chunk = std::str::from_utf8(&pending[..valid_upto])
                .expect("verified valid UTF-8 prefix")
                .to_owned();
            if let Some(log) = logger {
                if let Ok(mut l) = log.lock() { l.write_chunk(&chunk); }
            }
            let _ = window.emit("terminal-output", chunk);
        }
        match error_len {
            // A genuinely invalid sequence of `n` bytes: replace and skip so
            // pending can't grow without bound on bad input.
            Some(n) => {
                if let Some(log) = logger {
                    if let Ok(mut l) = log.lock() { l.write_chunk("\u{FFFD}"); }
                }
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
    session_log: tauri::State<'_, SessionLog>,
    program: String,
    args: Vec<String>,
) -> Result<Option<i32>, String> {
    // Borrow the shared session logger and emit a "$ cmd args" header so the
    // log records which script was invoked for this run.
    let logger: Option<LogHandle> = session_log.0.lock().clone();
    if let Some(log) = logger.as_ref() {
        if let Ok(mut l) = log.lock() {
            l.write_line(&format!("$ {} {}", program, args.join(" ")));
        }
    }
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
        if let Some(log) = logger.as_ref() {
            if let Ok(mut l) = log.lock() { l.write_chunk(&msg); }
        }
        let _ = window.emit("terminal-output", msg);
        e.to_string()
    })?;

    {
        let pid = child.id();
        let mut st = state.0.lock();
        st.pid = pid;
        st.stop_logged = false;
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
    let log1 = logger.clone();
    let stdout_task = tokio::spawn(async move { read_and_emit(stdout, w1, log1).await; });

    let w2 = window.clone();
    let log2 = logger.clone();
    let stderr_task = tokio::spawn(async move { read_and_emit(stderr, w2, log2).await; });

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
async fn cancel_command(
    state: tauri::State<'_, Running>,
    session_log: tauri::State<'_, SessionLog>,
) -> Result<(), ()> {
    // Mark the stop in the log so a later reader can tell a user-initiated
    // stop apart from a crash. Only write once per run.
    {
        let mut st = state.0.lock();
        if !st.stop_logged {
            if let Some(log) = session_log.0.lock().clone() {
                if let Ok(mut l) = log.lock() { l.write_line("[stopped by user]"); }
            }
            st.stop_logged = true;
        }
    }
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

pub fn run() {
    // The CSP in tauri.conf.json includes `style-src 'self' 'unsafe-inline'`.
    // 'unsafe-inline' is required because xterm.js injects dynamic <style>
    // rules at runtime for per-terminal theming and sizing. Removing it
    // breaks terminal rendering. JSON has no comments, hence this note.
    tauri::Builder::default()
        .manage(Running(parking_lot::Mutex::new(RunState::default())))
        .manage(SessionLog(parking_lot::Mutex::new(None)))
        .manage(LogDir(parking_lot::Mutex::new(None)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![path_exists, platform, command_exists, open_path, set_executable, prepare_output_dir, run_command, cancel_command, scan_testfile_names, rename_testfiles, count_scores, count_processed_scores, count_pngs, init_session_log, log_event, get_log_dir])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
