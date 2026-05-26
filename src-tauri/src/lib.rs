use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Emitter, Manager, RunEvent, State};

#[derive(Default)]
struct PendingOpen(Mutex<Option<String>>);

#[derive(Clone, Serialize)]
struct OpenFilePayload {
    path: String,
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("read {}: {}", path, e))
}

#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("write {}: {}", path, e))
}

#[tauri::command]
fn take_pending_open(state: State<'_, PendingOpen>) -> Option<String> {
    state.0.lock().ok().and_then(|mut g| g.take())
}

fn path_from_arg(arg: &str) -> Option<PathBuf> {
    if arg.starts_with("file://") {
        url::Url::parse(arg).ok().and_then(|u| u.to_file_path().ok())
    } else if !arg.is_empty() && !arg.starts_with('-') {
        Some(PathBuf::from(arg))
    } else {
        None
    }
}

fn first_file_arg(argv: &[String]) -> Option<PathBuf> {
    argv.iter().skip(1).find_map(|a| path_from_arg(a))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial_cli_path = first_file_arg(&std::env::args().collect::<Vec<_>>());

    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(
            |app, argv, _cwd| {
                if let Some(path) = first_file_arg(&argv) {
                    let p = path.to_string_lossy().to_string();
                    let _ = app.emit("open-file", OpenFilePayload { path: p });
                }
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_focus();
                    let _ = win.unminimize();
                }
            },
        ));
    }

    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .manage(PendingOpen::default())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            take_pending_open
        ])
        .setup(move |app| {
            if let Some(path) = &initial_cli_path {
                if let Ok(mut g) = app.state::<PendingOpen>().0.lock() {
                    *g = Some(path.to_string_lossy().to_string());
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let RunEvent::Opened { urls } = &event {
            let paths: Vec<String> = urls
                .iter()
                .filter_map(|u| u.to_file_path().ok())
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            if let Some(first) = paths.first() {
                if let Ok(mut g) = app.state::<PendingOpen>().0.lock() {
                    *g = Some(first.clone());
                }
                let _ = app.emit(
                    "open-file",
                    OpenFilePayload {
                        path: first.clone(),
                    },
                );
            }
        }
        let _ = event;
    });
}
