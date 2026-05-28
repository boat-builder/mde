import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { save as saveDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import Editor, { EditorHandle } from "./Editor";
import Sidebar from "./Sidebar";

type OpenFilePayload = { path: string };
type OpenFolderPayload = { path: string };
type FileSnapshot = { mtime_ms: number; size: number };
type ReadFileResult = { contents: string; snapshot: FileSnapshot };
type ExternalChangePayload = { path: string; snapshot: FileSnapshot };
type WriteErrorPayload =
  | { kind: "io"; message: string }
  | { kind: "conflict"; current: FileSnapshot };
type Conflict = { diskSnapshot: FileSnapshot };

const AUTOSAVE_DEBOUNCE_MS = 600;

const basename = (p: string) => p.split(/[\\/]/).pop() || p;

type Theme = "system" | "light" | "sepia" | "dark";
const THEMES: Theme[] = ["system", "light", "sepia", "dark"];
const THEME_STORAGE_KEY = "mde:theme";
const WORKSPACE_STORAGE_KEY = "mde:workspace";
const SIDEBAR_OPEN_STORAGE_KEY = "mde:sidebar-open";
const THEME_LABEL: Record<Theme, string> = {
  system: "System",
  light: "Light",
  sepia: "Sepia",
  dark: "Dark",
};

function readStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v && (THEMES as string[]).includes(v)) return v as Theme;
  } catch {
    // localStorage may be unavailable; fall through
  }
  return "system";
}

function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
}

function isWriteError(e: unknown): e is WriteErrorPayload {
  return (
    typeof e === "object" &&
    e !== null &&
    "kind" in e &&
    ((e as { kind: unknown }).kind === "io" ||
      (e as { kind: unknown }).kind === "conflict")
  );
}

function readStoredWorkspace(): string | null {
  try {
    return localStorage.getItem(WORKSPACE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredWorkspace(p: string | null) {
  try {
    if (p) localStorage.setItem(WORKSPACE_STORAGE_KEY, p);
    else localStorage.removeItem(WORKSPACE_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function readStoredSidebarOpen(): boolean {
  try {
    const v = localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY);
    if (v === "1") return true;
    if (v === "0") return false;
  } catch {
    // ignore
  }
  return true;
}

function writeStoredSidebarOpen(open: boolean) {
  try {
    localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, open ? "1" : "0");
  } catch {
    // ignore
  }
}

export default function App() {
  const [path, setPath] = useState<string | null>(null);
  const [initialMarkdown, setInitialMarkdown] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [ready, setReady] = useState(false);
  const [loadKey, setLoadKey] = useState(0);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => readStoredSidebarOpen());
  const editorRef = useRef<EditorHandle>(null);
  const currentMarkdownRef = useRef<string>("");
  const lastSavedRef = useRef<string>("");
  const baselineCapturedRef = useRef<boolean>(false);
  const pathRef = useRef<string | null>(null);
  const scratchPathRef = useRef<string | null>(null);
  const snapshotRef = useRef<FileSnapshot | null>(null);
  const autosaveTimerRef = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  const conflictRef = useRef<Conflict | null>(null);
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme());

  useEffect(() => {
    pathRef.current = path;
  }, [path]);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    conflictRef.current = conflict;
  }, [conflict]);

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // ignore
    }
  }, [theme]);

  useEffect(() => {
    writeStoredSidebarOpen(sidebarOpen);
  }, [sidebarOpen]);

  const writeToDisk = useCallback(async (target: string, contents: string) => {
    try {
      const newSnapshot = await invoke<FileSnapshot>("write_file", {
        path: target,
        contents,
        expected: snapshotRef.current,
      });
      // The active document may have switched while this write was in flight
      // (e.g. a flush of the previous doc resolving after entering the
      // scratchpad). Only commit baseline state if `target` is still current.
      if ((pathRef.current ?? scratchPathRef.current) !== target) return;
      snapshotRef.current = newSnapshot;
      lastSavedRef.current = contents;
      if (currentMarkdownRef.current === contents) setDirty(false);
    } catch (e) {
      if ((pathRef.current ?? scratchPathRef.current) !== target) return;
      if (isWriteError(e) && e.kind === "conflict") {
        setConflict({ diskSnapshot: e.current });
      } else {
        console.error("autosave failed", e);
      }
    }
  }, []);

  const scheduleAutosave = useCallback(() => {
    if (autosaveTimerRef.current != null) {
      window.clearTimeout(autosaveTimerRef.current);
    }
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      if (conflictRef.current) return; // pause autosave while a conflict is unresolved
      const target = pathRef.current ?? scratchPathRef.current;
      if (!target) return;
      const snapshot = currentMarkdownRef.current;
      if (snapshot === lastSavedRef.current) return;
      void writeToDisk(target, snapshot);
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [writeToDisk]);

  const flushPendingAutosave = useCallback(() => {
    if (autosaveTimerRef.current != null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    const target = pathRef.current ?? scratchPathRef.current;
    if (!target) return;
    const snapshot = currentMarkdownRef.current;
    if (snapshot === lastSavedRef.current) return;
    void writeToDisk(target, snapshot);
  }, [writeToDisk]);

  const loadFile = useCallback(async (p: string) => {
    try {
      // Flush any pending autosave on the previous file before switching.
      flushPendingAutosave();
      const result = await invoke<ReadFileResult>("read_file", { path: p });
      if (autosaveTimerRef.current != null) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
      baselineCapturedRef.current = false;
      setPath(p);
      setInitialMarkdown(result.contents);
      currentMarkdownRef.current = result.contents;
      lastSavedRef.current = result.contents;
      snapshotRef.current = result.snapshot;
      setDirty(false);
      setConflict(null);
      setLoadKey((k) => k + 1);
      try {
        await invoke("watch_file", { path: p });
      } catch (e) {
        console.error("watch_file failed", e);
      }
    } catch (e) {
      console.error(e);
      alert(`Could not open ${p}\n${e}`);
    }
  }, [flushPendingAutosave]);

  const setWorkspace = useCallback((root: string | null) => {
    setWorkspaceRoot(root);
    writeStoredWorkspace(root);
    if (root) setSidebarOpen(true);
  }, []);

  const openFolderPicker = useCallback(async () => {
    try {
      const chosen = await openDialog({ directory: true, multiple: false });
      if (typeof chosen === "string") setWorkspace(chosen);
    } catch (e) {
      console.error("open folder failed", e);
    }
  }, [setWorkspace]);

  const openFilePicker = useCallback(async () => {
    try {
      const chosen = await openDialog({
        multiple: false,
        filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd"] }],
      });
      if (typeof chosen === "string") await loadFile(chosen);
    } catch (e) {
      console.error("open file failed", e);
    }
  }, [loadFile]);

  const revealInFinder = useCallback(async (target: string) => {
    try {
      await invoke("reveal_in_finder", { path: target });
    } catch (e) {
      console.error("reveal failed", e);
    }
  }, []);

  const reloadFromDisk = useCallback(async () => {
    const target = pathRef.current;
    if (!target) return;
    if (autosaveTimerRef.current != null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    try {
      const result = await invoke<ReadFileResult>("read_file", { path: target });
      baselineCapturedRef.current = false;
      setInitialMarkdown(result.contents);
      currentMarkdownRef.current = result.contents;
      lastSavedRef.current = result.contents;
      snapshotRef.current = result.snapshot;
      setDirty(false);
      setConflict(null);
      setLoadKey((k) => k + 1);
    } catch (e) {
      console.error("reload failed", e);
    }
  }, []);

  const keepMyVersion = useCallback(() => {
    const c = conflictRef.current;
    if (c) snapshotRef.current = c.diskSnapshot;
    setConflict(null);
    if (currentMarkdownRef.current !== lastSavedRef.current) {
      scheduleAutosave();
    }
  }, [scheduleAutosave]);

  // Switch the editor to the app-managed scratchpad (the "untitled" buffer).
  // Non-destructive: restores whatever was last jotted there.
  const enterScratch = useCallback(async () => {
    const scratch = scratchPathRef.current;
    if (!scratch) return;
    flushPendingAutosave(); // persist the outgoing doc before switching
    if (autosaveTimerRef.current != null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    try {
      await invoke("unwatch_file"); // the scratchpad isn't externally watched
    } catch (e) {
      console.error("unwatch_file failed", e);
    }
    let contents = "";
    let snapshot: FileSnapshot | null = null;
    try {
      const result = await invoke<ReadFileResult>("read_file", { path: scratch });
      contents = result.contents;
      snapshot = result.snapshot;
    } catch (e) {
      console.error("read scratch failed", e);
    }
    baselineCapturedRef.current = false;
    setPath(null);
    pathRef.current = null;
    setInitialMarkdown(contents);
    currentMarkdownRef.current = contents;
    lastSavedRef.current = contents;
    snapshotRef.current = snapshot;
    setDirty(false);
    setConflict(null);
    setLoadKey((k) => k + 1);
  }, [flushPendingAutosave]);

  // Empty the scratchpad ("scrap it"). Only meaningful while in scratch mode.
  const discardScratch = useCallback(async () => {
    const scratch = scratchPathRef.current;
    if (!scratch || pathRef.current) return;
    if (autosaveTimerRef.current != null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    try {
      const snap = await invoke<FileSnapshot>("write_file", {
        path: scratch,
        contents: "",
        expected: snapshotRef.current,
      });
      snapshotRef.current = snap;
    } catch (e) {
      console.error("discard scratch failed", e);
      snapshotRef.current = null;
    }
    baselineCapturedRef.current = false;
    currentMarkdownRef.current = "";
    lastSavedRef.current = "";
    setInitialMarkdown("");
    setDirty(false);
    setLoadKey((k) => k + 1);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        scratchPathRef.current = await invoke<string>("get_scratch_path");
      } catch (e) {
        console.error("get_scratch_path failed", e);
      }
      const pendingFolder = await invoke<string | null>("take_pending_folder");
      const pendingFile = await invoke<string | null>("take_pending_open");
      if (pendingFolder) {
        setWorkspace(pendingFolder);
      } else if (!pendingFile) {
        // Bare launch — restore the last workspace if there was one.
        const stored = readStoredWorkspace();
        if (stored) setWorkspaceRoot(stored);
      }
      if (pendingFile) await loadFile(pendingFile);
      else await enterScratch(); // restore the scratchpad (hot-exit) or start blank
      setReady(true);
    })();
    const unFile = listen<OpenFilePayload>("open-file", (e) => {
      void loadFile(e.payload.path);
    });
    const unFolder = listen<OpenFolderPayload>("open-folder", (e) => {
      setWorkspace(e.payload.path);
    });
    return () => {
      void unFile.then((f) => f());
      void unFolder.then((f) => f());
    };
  }, [loadFile, setWorkspace, enterScratch]);

  useEffect(() => {
    const un = listen<ExternalChangePayload>("file-externally-changed", (e) => {
      if (e.payload.path !== pathRef.current) return;
      if (dirtyRef.current || conflictRef.current) {
        setConflict({ diskSnapshot: e.payload.snapshot });
      } else {
        void reloadFromDisk();
      }
    });
    return () => {
      void un.then((f) => f());
    };
  }, [reloadFromDisk]);

  const onMarkdownChange = useCallback(
    (md: string) => {
      currentMarkdownRef.current = md;
      if (!baselineCapturedRef.current) {
        lastSavedRef.current = md;
        baselineCapturedRef.current = true;
        return;
      }
      const changed = md !== lastSavedRef.current;
      setDirty(changed);
      if (changed) scheduleAutosave();
    },
    [scheduleAutosave],
  );

  const handleSave = useCallback(async () => {
    let target = pathRef.current;
    const isNewPath = !target;
    if (!target) {
      const chosen = await saveDialog({
        title: "Save markdown",
        defaultPath: "untitled.md",
        filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
      });
      if (!chosen) return;
      target = chosen;
      setPath(target);
      pathRef.current = target;
      // Promote from scratchpad: this is Save As, so overwrite the chosen
      // target unconditionally rather than comparing against the scratch snapshot.
      snapshotRef.current = null;
    }
    if (autosaveTimerRef.current != null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    await writeToDisk(target, currentMarkdownRef.current);
    if (isNewPath) {
      try {
        await invoke("watch_file", { path: target });
      } catch (e) {
        console.error("watch_file failed", e);
      }
      // The content now lives in a real file; empty the scratchpad so it
      // starts fresh next time and doesn't shadow a duplicate copy.
      const scratch = scratchPathRef.current;
      if (scratch) {
        try {
          await invoke("write_file", { path: scratch, contents: "", expected: null });
        } catch (e) {
          console.error("clear scratch failed", e);
        }
      }
    }
  }, [writeToDisk]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "s" && !e.shiftKey) {
        e.preventDefault();
        void handleSave();
      } else if (k === "n" && !e.shiftKey) {
        e.preventDefault();
        void enterScratch();
      } else if (k === "o" && e.shiftKey) {
        e.preventDefault();
        void openFolderPicker();
      } else if (k === "o" && !e.shiftKey) {
        e.preventDefault();
        void openFilePicker();
      } else if (k === "\\") {
        e.preventDefault();
        if (workspaceRoot) setSidebarOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleSave, enterScratch, openFolderPicker, openFilePicker, workspaceRoot]);

  useEffect(() => {
    const name = path ? basename(path) : "Untitled";
    void getCurrentWindow().setTitle(`${dirty ? "● " : ""}${name}`);
  }, [path, dirty]);

  if (!ready) return null;

  const showSidebar = workspaceRoot != null && sidebarOpen;
  const isScratch = path == null;

  return (
    <div className={`app ${showSidebar ? "with-sidebar" : ""}`}>
      <div className="drag-strip" data-tauri-drag-region />
      {workspaceRoot && (
        <button
          className="sidebar-toggle"
          onClick={() => setSidebarOpen((v) => !v)}
          title={sidebarOpen ? "Hide sidebar (⌘\\)" : "Show sidebar (⌘\\)"}
          aria-label="Toggle sidebar"
          aria-pressed={sidebarOpen}
        >
          <SidebarIcon />
        </button>
      )}
      <FileLabel path={path} dirty={dirty} hasSidebarToggle={workspaceRoot != null} />
      {showSidebar && workspaceRoot && (
        <Sidebar
          root={workspaceRoot}
          currentPath={path}
          onOpenFile={loadFile}
          onOpenFolder={openFolderPicker}
          onOpenFilePicker={openFilePicker}
          onCloseWorkspace={() => setWorkspace(null)}
          onRevealInFinder={revealInFinder}
        />
      )}
      {conflict && (
        <ConflictBanner
          onReload={() => void reloadFromDisk()}
          onKeep={keepMyVersion}
        />
      )}
      <main className="editor-wrap">
        <Editor
          ref={editorRef}
          key={loadKey}
          initialMarkdown={initialMarkdown}
          onChange={onMarkdownChange}
        />
      </main>
      <Settings
        theme={theme}
        onChange={setTheme}
        isScratch={isScratch}
        onNewNote={() => void enterScratch()}
        onDiscard={() => void discardScratch()}
        onOpenFile={openFilePicker}
        onOpenFolder={openFolderPicker}
      />
    </div>
  );
}

/* ---------- Subviews ---------- */

function ConflictBanner({
  onReload,
  onKeep,
}: {
  onReload: () => void;
  onKeep: () => void;
}) {
  return (
    <div className="conflict-banner" role="alert">
      <span className="conflict-banner-text">
        This file has changed on disk.
      </span>
      <div className="conflict-banner-actions">
        <button className="conflict-banner-btn" onClick={onReload}>
          Reload from disk
        </button>
        <button
          className="conflict-banner-btn is-primary"
          onClick={onKeep}
        >
          Keep my version
        </button>
      </div>
    </div>
  );
}

function FileLabel({
  path,
  dirty,
  hasSidebarToggle,
}: {
  path: string | null;
  dirty: boolean;
  hasSidebarToggle: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch (e) {
      console.error("clipboard write failed", e);
    }
  }, [path]);

  if (!path) {
    return (
      <div className={`file-label ${hasSidebarToggle ? "with-toggle" : ""}`}>
        <span className="file-label-name">Untitled</span>
        {dirty && <span className="file-label-dot" aria-hidden>●</span>}
      </div>
    );
  }
  const label = basename(path);
  return (
    <div
      className={`file-label ${hasSidebarToggle ? "with-toggle" : ""}`}
      title={path}
    >
      <span className="file-label-name">{label}</span>
      {dirty && <span className="file-label-dot" aria-hidden>●</span>}
      <button
        className="file-label-copy"
        onClick={onCopy}
        title="Copy full path"
        aria-label="Copy full file path"
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  );
}

function Settings({
  theme,
  onChange,
  isScratch,
  onNewNote,
  onDiscard,
  onOpenFile,
  onOpenFolder,
}: {
  theme: Theme;
  onChange: (t: Theme) => void;
  isScratch: boolean;
  onNewNote: () => void;
  onDiscard: () => void;
  onOpenFile: () => void;
  onOpenFolder: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="settings-wrap">
      {open && (
        <div className="settings-popover" role="menu" aria-label="Settings">
          <div className="settings-section-label">File</div>
          <button
            role="menuitem"
            className="settings-option"
            onClick={() => {
              setOpen(false);
              onNewNote();
            }}
          >
            <span className="settings-option-check" />
            <span className="settings-option-label">New note</span>
            <span className="settings-option-kbd">⌘N</span>
          </button>
          {isScratch && (
            <button
              role="menuitem"
              className="settings-option"
              onClick={() => {
                setOpen(false);
                onDiscard();
              }}
            >
              <span className="settings-option-check" />
              <span className="settings-option-label">Clear scratchpad</span>
            </button>
          )}
          <button
            role="menuitem"
            className="settings-option"
            onClick={() => {
              setOpen(false);
              onOpenFile();
            }}
          >
            <span className="settings-option-check" />
            <span className="settings-option-label">Open file…</span>
            <span className="settings-option-kbd">⌘O</span>
          </button>
          <button
            role="menuitem"
            className="settings-option"
            onClick={() => {
              setOpen(false);
              onOpenFolder();
            }}
          >
            <span className="settings-option-check" />
            <span className="settings-option-label">Open folder…</span>
            <span className="settings-option-kbd">⌘⇧O</span>
          </button>
          <div className="settings-divider" />
          <div className="settings-section-label">Appearance</div>
          {THEMES.map((t) => (
            <button
              key={t}
              role="menuitemradio"
              aria-checked={theme === t}
              className={`settings-option ${theme === t ? "is-active" : ""}`}
              onClick={() => {
                onChange(t);
                setOpen(false);
              }}
            >
              <span className="settings-option-check">
                {theme === t ? <CheckIcon /> : null}
              </span>
              <span className="settings-option-label">{THEME_LABEL[t]}</span>
            </button>
          ))}
        </div>
      )}
      <button
        className="settings-fab"
        onClick={() => setOpen((o) => !o)}
        aria-label="Settings"
        aria-expanded={open}
        title="Settings"
      >
        <GearIcon />
      </button>
    </div>
  );
}

/* ---------- Icons ---------- */

function GearIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function SidebarIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9" y1="4" x2="9" y2="20" />
    </svg>
  );
}
