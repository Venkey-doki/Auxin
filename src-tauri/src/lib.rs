mod conns;
mod deps;
mod http;
mod netpolicy;
mod process;
mod scan;
mod steps;
mod topology;
mod workspace_files;

use process::{Manager, StartSpec};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager as _, RunEvent, State};

#[tauri::command]
async fn step_exec(app: AppHandle, state: State<'_, Arc<http::HttpState>>, req: steps::StepRequest) -> Result<steps::StepResult, String> {
    let temp = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("responses");
    steps::exec(state.inner().clone(), req, temp).await
}

/// Cancels an in-flight step of any kind by its id.
#[tauri::command]
fn step_cancel(state: State<'_, Arc<http::HttpState>>, id: String) -> bool {
    state.cancel(&id)
}

#[tauri::command]
fn http_drop_jar(state: State<'_, Arc<http::HttpState>>, id: String) {
    state.drop_jar(&id);
}

#[tauri::command]
async fn auxin_list(root: String) -> Vec<workspace_files::AuxinFile> {
    tauri::async_runtime::spawn_blocking(move || workspace_files::list(&root)).await.unwrap_or_default()
}

#[tauri::command]
fn auxin_write(root: String, path: String, text: String) -> Result<(), String> {
    workspace_files::write(&root, &path, &text)
}

#[tauri::command]
fn auxin_delete(root: String, path: String) -> Result<(), String> {
    workspace_files::delete(&root, &path)
}

#[tauri::command]
fn auxin_watch(app: AppHandle, watch: State<'_, workspace_files::FileWatch>, root: String) -> Result<(), String> {
    watch.watch(app, &root)
}

#[tauri::command]
fn file_preview(path: String) -> Result<(String, u64), String> {
    workspace_files::preview(&path, 64 * 1024)
}

#[tauri::command]
fn auxin_list_dir(root: String, path: String) -> Result<Vec<String>, String> {
    workspace_files::list_dir(&root, &path)
}

#[tauri::command]
fn auxin_read(root: String, path: String) -> Result<String, String> {
    workspace_files::read(&root, &path)
}

#[tauri::command]
async fn discover_topology(root: String, services: Vec<topology::ServiceRef>, code_scan: bool) -> topology::Discovery {
    tauri::async_runtime::spawn_blocking(move || topology::discover(std::path::Path::new(&root), &services, code_scan)).await.unwrap_or_default()
}

#[tauri::command]
async fn sample_connections(groups: Vec<(String, u32)>, port_owner: std::collections::HashMap<u16, String>) -> Vec<(String, String)> {
    tauri::async_runtime::spawn_blocking(move || conns::sample_connections(&groups, &port_owner)).await.unwrap_or_default()
}

#[tauri::command]
async fn scan_workspace(root: String) -> Result<Vec<scan::DetectedService>, String> {
    let path = PathBuf::from(&root);
    if !path.is_dir() {
        return Err(format!("Folder not found: {root}"));
    }
    tauri::async_runtime::spawn_blocking(move || scan::scan(&path)).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn inspect_folder(path: String) -> Option<scan::DetectedService> {
    let path = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || scan::scan(&path).into_iter().find(|s| std::path::Path::new(&s.path) == path))
        .await
        .ok()
        .flatten()
}

#[tauri::command]
async fn start_service(manager: State<'_, Arc<Manager>>, spec: StartSpec) -> Result<u32, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.start(spec)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn stop_service(manager: State<'_, Arc<Manager>>, id: String) -> Result<(), String> {
    manager.stop(&id)
}

#[tauri::command]
fn send_input(manager: State<'_, Arc<Manager>>, id: String, text: String) -> Result<(), String> {
    manager.send_input(&id, &text)
}

#[tauri::command]
fn running_services(manager: State<'_, Arc<Manager>>) -> Vec<(String, u32)> {
    manager.running()
}

#[tauri::command]
fn check_port(port: u16) -> bool {
    ["127.0.0.1", "::1"].iter().any(|host| {
        let addr: SocketAddr = format!("{}:{port}", if host.contains(':') { format!("[{host}]") } else { host.to_string() })
            .parse()
            .unwrap();
        TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
    })
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("auxin.json"))
}

#[tauri::command]
fn load_config(app: AppHandle) -> Result<Option<String>, String> {
    let path = config_path(&app)?;
    Ok(std::fs::read_to_string(path).ok())
}

#[tauri::command]
fn save_config(app: AppHandle, json: String) -> Result<(), String> {
    let path = config_path(&app)?;
    // Write-then-rename so a crash mid-save never corrupts the config.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_in_editor(path: String) -> Result<(), String> {
    let env = process::shell_env();
    let spawned = std::process::Command::new("code").arg(&path).env_clear().envs(env.iter().cloned()).spawn();
    if spawned.is_ok() {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&path).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        spawned.map(|_| ()).map_err(|e| e.to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(Arc::new(Manager::new(app.handle().clone())));
            app.manage(Arc::new(http::HttpState::default()));
            app.manage(workspace_files::FileWatch::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_workspace,
            inspect_folder,
            start_service,
            stop_service,
            send_input,
            running_services,
            check_port,
            load_config,
            save_config,
            open_in_editor,
            step_exec,
            step_cancel,
            http_drop_jar,
            auxin_list,
            auxin_write,
            auxin_delete,
            auxin_watch,
            file_preview,
            auxin_list_dir,
            auxin_read,
            discover_topology,
            sample_connections
        ])
        .build(tauri::generate_context!())
        .expect("error while building Auxin");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            // Never leave orphaned services behind.
            handle.state::<Arc<Manager>>().shutdown_all();
        }
    });
}
