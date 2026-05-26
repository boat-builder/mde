use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Emitter, Manager, RunEvent, State};

#[derive(Default)]
struct PendingOpen {
    file: Mutex<Option<String>>,
    folder: Mutex<Option<String>>,
}

#[derive(Clone, Serialize)]
struct OpenFilePayload {
    path: String,
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

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("read {}: {}", path, e))
}

#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("write {}: {}", path, e))
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
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            list_md_tree,
            take_pending_open,
            take_pending_folder,
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
