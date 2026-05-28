use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, FileIdMap};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

#[derive(Default)]
struct PendingOpen {
    file: Mutex<Option<String>>,
    folder: Mutex<Option<String>>,
}

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

#[derive(Clone, Serialize)]
struct OpenFolderPayload {
    path: String,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum TreeNode {
    File {
        name: String,
        path: String,
    },
    Dir {
        name: String,
        path: String,
        children: Vec<TreeNode>,
    },
}

const MAX_TREE_DEPTH: usize = 12;
const MAX_TREE_ENTRIES: usize = 5000;

fn is_markdown(path: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => matches!(ext.to_ascii_lowercase().as_str(), "md" | "markdown" | "mdown" | "mkd"),
        None => false,
    }
}

fn is_hidden_or_ignored(name: &str) -> bool {
    if name.starts_with('.') {
        return true;
    }
    matches!(
        name,
        "node_modules" | "target" | "dist" | "build" | "__pycache__" | ".git"
    )
}

/// Recursively walks `dir`, returning a pruned tree containing only directories
/// that (transitively) contain markdown files. Returns None if the directory has
/// no markdown descendants. Mutates `budget` to enforce a global entry cap.
fn walk(dir: &Path, depth: usize, budget: &mut usize) -> Option<TreeNode> {
    if depth > MAX_TREE_DEPTH || *budget == 0 {
        return None;
    }

    let entries = std::fs::read_dir(dir).ok()?;
    let mut subdirs: Vec<PathBuf> = Vec::new();
    let mut files: Vec<PathBuf> = Vec::new();

    for entry in entries.flatten() {
        if *budget == 0 {
            break;
        }
        *budget -= 1;
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if is_hidden_or_ignored(&name_str) {
            continue;
        }
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if ft.is_dir() {
            subdirs.push(path);
        } else if ft.is_file() && is_markdown(&path) {
            files.push(path);
        }
    }

    subdirs.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
    files.sort_by(|a, b| a.file_name().cmp(&b.file_name()));

    let mut children: Vec<TreeNode> = Vec::new();
    for sub in subdirs {
        if let Some(node) = walk(&sub, depth + 1, budget) {
            children.push(node);
        }
    }
    for f in files {
        children.push(TreeNode::File {
            name: f.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            path: f.to_string_lossy().to_string(),
        });
    }

    if children.is_empty() {
        return None;
    }

    Some(TreeNode::Dir {
        name: dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| dir.to_string_lossy().to_string()),
        path: dir.to_string_lossy().to_string(),
        children,
    })
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
fn list_md_tree(path: String) -> Result<TreeNode, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("not a directory: {}", path));
    }
    let mut budget = MAX_TREE_ENTRIES;
    // Always return a Dir node for the root, even when empty, so the UI can
    // show "no markdown files here" rather than an error.
    if let Some(node) = walk(&root, 0, &mut budget) {
        Ok(node)
    } else {
        Ok(TreeNode::Dir {
            name: root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| root.to_string_lossy().to_string()),
            path: root.to_string_lossy().to_string(),
            children: Vec::new(),
        })
    }
}

#[tauri::command]
fn take_pending_open(state: State<'_, PendingOpen>) -> Option<String> {
    state.file.lock().ok().and_then(|mut g| g.take())
}

#[tauri::command]
fn take_pending_folder(state: State<'_, PendingOpen>) -> Option<String> {
    state.folder.lock().ok().and_then(|mut g| g.take())
}

/// Returns the path to the app-managed scratchpad file, creating the parent
/// directory and an empty file on first use. This backs the "untitled" buffer
/// so a document is always durably persisted even before the user names a file.
#[tauri::command]
fn get_scratch_path(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {}", e))?
        .join("scratch");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create scratch dir: {}", e))?;
    let file = dir.join("current.md");
    if !file.exists() {
        std::fs::write(&file, "").map_err(|e| format!("init scratch: {}", e))?;
    }
    Ok(file.to_string_lossy().to_string())
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("reveal {}: {}", path, e))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("reveal_in_finder is only supported on macOS".to_string())
    }
}

enum CliPath {
    File(PathBuf),
    Folder(PathBuf),
}

fn classify_arg(arg: &str) -> Option<CliPath> {
    let pb = if arg.starts_with("file://") {
        url::Url::parse(arg).ok().and_then(|u| u.to_file_path().ok())?
    } else if !arg.is_empty() && !arg.starts_with('-') {
        PathBuf::from(arg)
    } else {
        return None;
    };
    // Resolve relative args like "." to an absolute path so the UI can show a
    // real directory name. Falls back to the original for nonexistent paths.
    let pb = std::fs::canonicalize(&pb).unwrap_or(pb);
    if pb.is_dir() {
        Some(CliPath::Folder(pb))
    } else {
        Some(CliPath::File(pb))
    }
}

/// Returns (folder, file) extracted from argv. A directory arg becomes the
/// folder; the first non-directory arg becomes the file. Either may be None.
fn classify_argv(argv: &[String]) -> (Option<PathBuf>, Option<PathBuf>) {
    let mut folder = None;
    let mut file = None;
    for a in argv.iter().skip(1) {
        match classify_arg(a) {
            Some(CliPath::Folder(p)) if folder.is_none() => folder = Some(p),
            Some(CliPath::File(p)) if file.is_none() => file = Some(p),
            _ => {}
        }
    }
    (folder, file)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let (initial_folder, initial_file) = classify_argv(&std::env::args().collect::<Vec<_>>());

    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(
            |app, argv, _cwd| {
                let (folder, file) = classify_argv(&argv);
                if let Some(p) = folder {
                    let _ = app.emit(
                        "open-folder",
                        OpenFolderPayload { path: p.to_string_lossy().to_string() },
                    );
                }
                if let Some(p) = file {
                    let _ = app.emit(
                        "open-file",
                        OpenFilePayload { path: p.to_string_lossy().to_string() },
                    );
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
            list_md_tree,
            take_pending_open,
            take_pending_folder,
            get_scratch_path,
            reveal_in_finder
        ])
        .setup(move |app| {
            let state = app.state::<PendingOpen>();
            if let Some(p) = &initial_folder {
                if let Ok(mut g) = state.folder.lock() {
                    *g = Some(p.to_string_lossy().to_string());
                }
            }
            if let Some(p) = &initial_file {
                if let Ok(mut g) = state.file.lock() {
                    *g = Some(p.to_string_lossy().to_string());
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let RunEvent::Opened { urls } = &event {
            for u in urls {
                if let Ok(p) = u.to_file_path() {
                    let path_str = p.to_string_lossy().to_string();
                    if p.is_dir() {
                        if let Ok(mut g) = app.state::<PendingOpen>().folder.lock() {
                            *g = Some(path_str.clone());
                        }
                        let _ = app.emit("open-folder", OpenFolderPayload { path: path_str });
                    } else {
                        if let Ok(mut g) = app.state::<PendingOpen>().file.lock() {
                            *g = Some(path_str.clone());
                        }
                        let _ = app.emit("open-file", OpenFilePayload { path: path_str });
                    }
                }
            }
        }
        let _ = event;
    });
}
