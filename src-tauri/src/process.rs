//! Process supervision: spawns service commands in their own process group,
//! streams their output to the UI in batches, and makes sure nothing outlives
//! the app.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Runtime, Wry};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartSpec {
    pub id: String,
    pub command: String,
    pub cwd: String,
    #[serde(default)]
    pub env: Vec<(String, String)>,
    pub venv: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub id: String,
    pub stream: &'static str,
    pub text: String,
    pub ts: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEvent {
    pub id: String,
    /// running | stopping | stopped | exited | crashed
    pub status: &'static str,
    pub pid: Option<u32>,
    pub code: Option<i32>,
    pub ts: u64,
}

struct Running {
    pid: u32,
    stdin: Option<ChildStdin>,
    stop_requested: Arc<AtomicBool>,
}

pub struct Manager<R: Runtime = Wry> {
    procs: Mutex<HashMap<String, Running>>,
    log_tx: Sender<LogLine>,
    app: AppHandle<R>,
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl<R: Runtime> Manager<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        let (log_tx, log_rx) = mpsc::channel();
        let emitter = app.clone();
        thread::spawn(move || flush_logs(emitter, log_rx));
        // Resolve the login-shell environment early so the first start is fast.
        thread::spawn(|| {
            shell_env();
        });
        Self { procs: Mutex::new(HashMap::new()), log_tx, app }
    }

    pub fn start(&self, spec: StartSpec) -> Result<u32, String> {
        let mut procs = self.procs.lock().unwrap();
        if let Some(r) = procs.get(&spec.id) {
            return Err(format!("already running (pid {})", r.pid));
        }
        if !std::path::Path::new(&spec.cwd).is_dir() {
            return Err(format!("folder not found: {}", spec.cwd));
        }

        let mut cmd = shell_command(&spec.command);
        cmd.current_dir(&spec.cwd)
            .env_clear()
            .envs(shell_env().iter().cloned())
            .env("FORCE_COLOR", "1")
            .env("CLICOLOR_FORCE", "1")
            .env("PYTHONUNBUFFERED", "1")
            .env("TERM", "xterm-256color")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(venv) = &spec.venv {
            let path = shell_env().iter().find(|(k, _)| k == "PATH").map(|(_, v)| v.as_str()).unwrap_or("");
            cmd.env("VIRTUAL_ENV", venv).env("PATH", format!("{venv}/bin:{path}")).env_remove("PYTHONHOME");
        }
        for (k, v) in &spec.env {
            if !k.trim().is_empty() {
                cmd.env(k.trim(), v);
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Own process group, so stopping kills the whole tree (npm -> node, etc.).
            cmd.process_group(0);
        }

        let mut child: Child = cmd.spawn().map_err(|e| format!("could not start: {e}"))?;
        let pid = child.id();
        let stop_requested = Arc::new(AtomicBool::new(false));

        if let Some(out) = child.stdout.take() {
            pipe_lines(out, spec.id.clone(), "stdout", self.log_tx.clone());
        }
        if let Some(err) = child.stderr.take() {
            pipe_lines(err, spec.id.clone(), "stderr", self.log_tx.clone());
        }
        procs.insert(
            spec.id.clone(),
            Running { pid, stdin: child.stdin.take(), stop_requested: stop_requested.clone() },
        );
        drop(procs);

        self.emit_status(&spec.id, "running", Some(pid), None);
        let _ = self.log_tx.send(LogLine { id: spec.id.clone(), stream: "system", text: format!("$ {}", spec.command), ts: now_ms() });

        let app = self.app.clone();
        let id = spec.id.clone();
        thread::spawn(move || {
            let status = child.wait();
            let manager = app.state::<Arc<Manager<R>>>();
            manager.procs.lock().unwrap().remove(&id);
            let code = status.as_ref().ok().and_then(|s| s.code());
            let state = if stop_requested.load(Ordering::SeqCst) {
                "stopped"
            } else if code == Some(0) {
                "exited"
            } else {
                "crashed"
            };
            let note = match (state, code) {
                ("stopped", _) => "Stopped".to_string(),
                (_, Some(c)) => format!("Process exited with code {c}"),
                _ => "Process was terminated by a signal".to_string(),
            };
            let _ = manager.log_tx.send(LogLine { id: id.clone(), stream: "system", text: note, ts: now_ms() });
            manager.emit_status(&id, state, None, code);
        });
        Ok(pid)
    }

    pub fn stop(&self, id: &str) -> Result<(), String> {
        let (pid, flag) = {
            let procs = self.procs.lock().unwrap();
            let r = procs.get(id).ok_or("not running")?;
            (r.pid, r.stop_requested.clone())
        };
        flag.store(true, Ordering::SeqCst);
        self.emit_status(id, "stopping", Some(pid), None);
        terminate_group(pid);
        // Escalate if it ignores SIGTERM.
        let app = self.app.clone();
        let id = id.to_string();
        thread::spawn(move || {
            thread::sleep(Duration::from_secs(5));
            let manager = app.state::<Arc<Manager<R>>>();
            let still = manager.procs.lock().unwrap().get(&id).map(|r| r.pid) == Some(pid);
            if still {
                kill_group(pid);
            }
        });
        Ok(())
    }

    pub fn send_input(&self, id: &str, text: &str) -> Result<(), String> {
        let mut procs = self.procs.lock().unwrap();
        let r = procs.get_mut(id).ok_or("not running")?;
        let stdin = r.stdin.as_mut().ok_or("input is closed")?;
        stdin.write_all(text.as_bytes()).and_then(|_| stdin.write_all(b"\n")).and_then(|_| stdin.flush()).map_err(|e| e.to_string())
    }

    pub fn running(&self) -> Vec<(String, u32)> {
        self.procs.lock().unwrap().iter().map(|(k, r)| (k.clone(), r.pid)).collect()
    }

    /// Called on app exit: SIGTERM every group, give them a moment, then SIGKILL.
    pub fn shutdown_all(&self) {
        let pids: Vec<u32> = {
            let procs = self.procs.lock().unwrap();
            procs.values().map(|r| {
                r.stop_requested.store(true, Ordering::SeqCst);
                r.pid
            }).collect()
        };
        if pids.is_empty() {
            return;
        }
        for pid in &pids {
            terminate_group(*pid);
        }
        let deadline = Instant::now() + Duration::from_millis(2500);
        while Instant::now() < deadline && !self.procs.lock().unwrap().is_empty() {
            thread::sleep(Duration::from_millis(100));
        }
        for pid in pids {
            kill_group(pid);
        }
    }

    fn emit_status(&self, id: &str, status: &'static str, pid: Option<u32>, code: Option<i32>) {
        let _ = self.app.emit("auxin://status", StatusEvent { id: id.to_string(), status, pid, code, ts: now_ms() });
    }
}

use tauri::Manager as _;

fn shell_command(command: &str) -> Command {
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let mut c = Command::new(shell);
        c.arg("-c").arg(command);
        c
    }
    #[cfg(windows)]
    {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(command);
        c
    }
}

#[cfg(unix)]
fn terminate_group(pid: u32) {
    unsafe {
        libc::kill(-(pid as i32), libc::SIGTERM);
    }
}

#[cfg(unix)]
fn kill_group(pid: u32) {
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

#[cfg(windows)]
fn terminate_group(pid: u32) {
    let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T"]).status();
}

#[cfg(windows)]
fn kill_group(pid: u32) {
    let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).status();
}

/// Reads a pipe line by line (lossy UTF-8, CR-only progress lines split too).
fn pipe_lines<R: Read + Send + 'static>(reader: R, id: String, stream: &'static str, tx: Sender<LogLine>) {
    thread::spawn(move || {
        let mut reader = BufReader::with_capacity(64 * 1024, reader);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let text = String::from_utf8_lossy(&buf);
                    let text = text.trim_end_matches(['\n', '\r']);
                    // Progress bars redraw with \r; keep only the final frame.
                    let text = text.rsplit('\r').next().unwrap_or(text);
                    if tx.send(LogLine { id: id.clone(), stream, text: text.to_string(), ts: now_ms() }).is_err() {
                        break;
                    }
                }
            }
        }
    });
}

/// Batches log lines so a chatty service cannot flood the IPC bridge.
fn flush_logs<R: Runtime>(app: AppHandle<R>, rx: Receiver<LogLine>) {
    let mut batch: Vec<LogLine> = Vec::with_capacity(512);
    loop {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(line) => {
                batch.push(line);
                // Drain whatever else is ready without blocking.
                while batch.len() < 2000 {
                    match rx.try_recv() {
                        Ok(l) => batch.push(l),
                        Err(_) => break,
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if !batch.is_empty() {
            let _ = app.emit("auxin://logs", &batch);
            batch.clear();
            thread::sleep(Duration::from_millis(30));
        }
    }
}

/// GUI apps on macOS start with a bare PATH. Capture the user's login shell
/// environment once (as editors do) so `npm`, `nvm`, `pyenv` etc. resolve.
pub fn shell_env() -> &'static Vec<(String, String)> {
    static ENV: OnceLock<Vec<(String, String)>> = OnceLock::new();
    ENV.get_or_init(|| {
        let base: Vec<(String, String)> = std::env::vars().collect();
        #[cfg(unix)]
        {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
            const MARK: &str = "__AUXIN_ENV__";
            let child = Command::new(&shell)
                .args(["-ilc", &format!("printf '{MARK}'; env -0")])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn();
            if let Ok(mut child) = child {
                let (tx, rx) = mpsc::channel();
                let mut out = child.stdout.take().unwrap();
                thread::spawn(move || {
                    let mut s = Vec::new();
                    let _ = out.read_to_end(&mut s);
                    let _ = tx.send(s);
                });
                if let Ok(bytes) = rx.recv_timeout(Duration::from_secs(6)) {
                    let _ = child.wait();
                    let text = String::from_utf8_lossy(&bytes);
                    if let Some((_, env)) = text.split_once(MARK) {
                        let vars: Vec<(String, String)> = env
                            .split('\0')
                            .filter_map(|kv| kv.split_once('='))
                            .filter(|(k, _)| !k.is_empty() && !k.contains('\n'))
                            .map(|(k, v)| (k.to_string(), v.to_string()))
                            .collect();
                        if vars.iter().any(|(k, _)| k == "PATH") {
                            return vars;
                        }
                    }
                } else {
                    let _ = child.kill();
                }
            }
        }
        base
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;
    use tauri::Listener;

    fn group_alive(pid: u32) -> bool {
        unsafe { libc::kill(-(pid as i32), 0) == 0 }
    }

    #[test]
    fn start_streams_output_and_stop_kills_whole_tree() {
        let app = tauri::test::mock_app();
        let manager = Arc::new(Manager::new(app.handle().clone()));
        app.manage(manager.clone());

        let lines: Arc<StdMutex<Vec<String>>> = Arc::default();
        let sink = lines.clone();
        app.listen("auxin://logs", move |e| sink.lock().unwrap().push(e.payload().to_string()));

        // A parent that also forks a background child, like `npm run dev` -> node.
        let pid = manager
            .start(StartSpec {
                id: "svc".into(),
                command: "echo hello-from-auxin; echo $AUXIN_TEST_VAR; sleep 30 & sleep 30".into(),
                cwd: std::env::temp_dir().to_string_lossy().into(),
                env: vec![("AUXIN_TEST_VAR".into(), "custom-env-ok".into())],
                venv: None,
            })
            .expect("start");
        assert!(manager.start(StartSpec { id: "svc".into(), command: "true".into(), cwd: "/".into(), env: vec![], venv: None }).is_err(), "double start must fail");

        thread::sleep(Duration::from_millis(800));
        let got = lines.lock().unwrap().join("\n");
        assert!(got.contains("hello-from-auxin"), "stdout streamed: {got}");
        assert!(got.contains("custom-env-ok"), "custom env applied: {got}");
        assert!(group_alive(pid));

        manager.stop("svc").unwrap();
        let deadline = Instant::now() + Duration::from_secs(4);
        while Instant::now() < deadline && (!manager.running().is_empty() || group_alive(pid)) {
            thread::sleep(Duration::from_millis(50));
        }
        assert!(manager.running().is_empty(), "manager forgot the process");
        assert!(!group_alive(pid), "background child survived stop");
    }

    #[test]
    fn shutdown_all_leaves_no_orphans() {
        let app = tauri::test::mock_app();
        let manager = Arc::new(Manager::new(app.handle().clone()));
        app.manage(manager.clone());
        let mut pids = vec![];
        for i in 0..3 {
            pids.push(
                manager
                    .start(StartSpec { id: format!("s{i}"), command: "sleep 30 & sleep 30".into(), cwd: "/".into(), env: vec![], venv: None })
                    .unwrap(),
            );
        }
        thread::sleep(Duration::from_millis(300));
        manager.shutdown_all();
        thread::sleep(Duration::from_millis(300));
        for pid in pids {
            assert!(!group_alive(pid), "group {pid} still alive after shutdown");
        }
    }

    #[test]
    fn bad_folder_is_reported() {
        let app = tauri::test::mock_app();
        let manager = Manager::new(app.handle().clone());
        let err = manager.start(StartSpec { id: "x".into(), command: "true".into(), cwd: "/definitely/not/here".into(), env: vec![], venv: None }).unwrap_err();
        assert!(err.contains("folder not found"));
    }
}
