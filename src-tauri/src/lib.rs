use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, FileIdMap};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

#[derive(Default)]
struct PendingOpen(Mutex<Option<String>>);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
struct FileSnapshot {
    mtime_ms: u64,
    size: u64,
}

#[derive(Clone, Serialize)]
struct ReadFileResult {
    contents: String,
    snapshot: FileSnapshot,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind")]
enum WriteError {
    #[serde(rename = "io")]
    Io { message: String },
    #[serde(rename = "conflict")]
    Conflict { current: FileSnapshot },
}

#[derive(Clone, Serialize)]
struct OpenFilePayload {
    path: String,
}

#[derive(Clone, Serialize)]
struct ExternalChangePayload {
    path: String,
    snapshot: FileSnapshot,
}

struct WatcherState {
    path: PathBuf,
    last_snapshot: FileSnapshot,
    _debouncer: Debouncer<RecommendedWatcher, FileIdMap>,
}

#[derive(Clone)]
struct WatcherStore(Arc<Mutex<Option<WatcherState>>>);

impl Default for WatcherStore {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(None)))
    }
}

fn stat_snapshot(path: &Path) -> std::io::Result<FileSnapshot> {
    let meta = std::fs::metadata(path)?;
    let size = meta.len();
    let mtime_ms = meta
        .modified()?
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(FileSnapshot { mtime_ms, size })
}

fn handle_debounced_events(
    store: &Arc<Mutex<Option<WatcherState>>>,
    app: &AppHandle,
    watched_path: &Path,
) {
    let new_snapshot = match stat_snapshot(watched_path) {
        Ok(s) => s,
        Err(_) => return, // file briefly missing during atomic rename; next event covers it
    };

    let mut guard = match store.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let state = match guard.as_mut() {
        Some(s) => s,
        None => return,
    };
    if state.path != watched_path {
        return;
    }
    if state.last_snapshot == new_snapshot {
        return;
    }
    state.last_snapshot = new_snapshot.clone();
    drop(guard);

    let _ = app.emit(
        "file-externally-changed",
        ExternalChangePayload {
            path: watched_path.to_string_lossy().to_string(),
            snapshot: new_snapshot,
        },
    );
}

#[tauri::command]
fn read_file(path: String) -> Result<ReadFileResult, String> {
    let path_buf = PathBuf::from(&path);
    let contents =
        std::fs::read_to_string(&path_buf).map_err(|e| format!("read {}: {}", path, e))?;
    let snapshot = stat_snapshot(&path_buf).map_err(|e| format!("stat {}: {}", path, e))?;
    Ok(ReadFileResult { contents, snapshot })
}

#[tauri::command]
fn write_file(
    path: String,
    contents: String,
    expected: Option<FileSnapshot>,
    store: State<'_, WatcherStore>,
) -> Result<FileSnapshot, WriteError> {
    let path_buf = PathBuf::from(&path);

    if let Some(expected) = expected {
        if path_buf.exists() {
            let current = stat_snapshot(&path_buf).map_err(|e| WriteError::Io {
                message: format!("stat {}: {}", path, e),
            })?;
            if current != expected {
                return Err(WriteError::Conflict { current });
            }
        }
    }

    std::fs::write(&path_buf, contents).map_err(|e| WriteError::Io {
        message: format!("write {}: {}", path, e),
    })?;

    let new_snapshot = stat_snapshot(&path_buf).map_err(|e| WriteError::Io {
        message: format!("stat {}: {}", path, e),
    })?;

    if let Ok(mut guard) = store.0.lock() {
        if let Some(state) = guard.as_mut() {
            if state.path == path_buf {
                state.last_snapshot = new_snapshot.clone();
            }
        }
    }

    Ok(new_snapshot)
}

#[tauri::command]
fn watch_file(
    path: String,
    app: AppHandle,
    store: State<'_, WatcherStore>,
) -> Result<FileSnapshot, String> {
    let path_buf = PathBuf::from(&path);
    let snapshot = stat_snapshot(&path_buf).map_err(|e| format!("stat {}: {}", path, e))?;

    // Drop the previous watcher OUTSIDE the lock so its worker thread can shut down
    // without contending with the lock our event handler will try to take.
    let previous = store.0.lock().unwrap().take();
    drop(previous);

    let store_arc = store.0.clone();
    let app_clone = app.clone();
    let path_for_closure = path_buf.clone();

    let mut debouncer = new_debouncer(
        Duration::from_millis(250),
        None,
        move |result: DebounceEventResult| {
            if result.is_err() {
                return;
            }
            handle_debounced_events(&store_arc, &app_clone, &path_for_closure);
        },
    )
    .map_err(|e| format!("watcher init: {}", e))?;

    debouncer
        .watcher()
        .watch(&path_buf, RecursiveMode::NonRecursive)
        .map_err(|e| format!("watch {}: {}", path, e))?;
    debouncer
        .cache()
        .add_root(&path_buf, RecursiveMode::NonRecursive);

    *store.0.lock().unwrap() = Some(WatcherState {
        path: path_buf,
        last_snapshot: snapshot.clone(),
        _debouncer: debouncer,
    });

    Ok(snapshot)
}

#[tauri::command]
fn unwatch_file(store: State<'_, WatcherStore>) {
    let previous = store.0.lock().unwrap().take();
    drop(previous);
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
        .manage(WatcherStore::default())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            watch_file,
            unwatch_file,
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
