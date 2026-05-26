import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import Editor, { EditorHandle } from "./Editor";

type OpenFilePayload = { path: string };

const AUTOSAVE_DEBOUNCE_MS = 600;

const basename = (p: string) => p.split(/[\\/]/).pop() || p;

type Theme = "system" | "light" | "sepia" | "dark";
const THEME_CYCLE: Theme[] = ["system", "light", "sepia", "dark"];
const THEME_STORAGE_KEY = "mde:theme";

function readStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v && THEME_CYCLE.includes(v as Theme)) return v as Theme;
  } catch {
    // localStorage may be unavailable; fall through to default
  }
  return "system";
}

function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
}

export default function App() {
  const [path, setPath] = useState<string | null>(null);
  const [initialMarkdown, setInitialMarkdown] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [ready, setReady] = useState(false);
  const editorRef = useRef<EditorHandle>(null);
  const currentMarkdownRef = useRef<string>("");
  const lastSavedRef = useRef<string>("");
  const baselineCapturedRef = useRef<boolean>(false);
  const pathRef = useRef<string | null>(null);
  const autosaveTimerRef = useRef<number | null>(null);
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme());

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // ignore
    }
  }, [theme]);

  const cycleTheme = useCallback(() => {
    setTheme((t) => {
      const i = THEME_CYCLE.indexOf(t);
      return THEME_CYCLE[(i + 1) % THEME_CYCLE.length];
    });
  }, []);

  useEffect(() => {
    pathRef.current = path;
  }, [path]);

  const writeToDisk = useCallback(async (target: string, contents: string) => {
    try {
      await invoke("write_file", { path: target, contents });
      lastSavedRef.current = contents;
      if (currentMarkdownRef.current === contents) setDirty(false);
    } catch (e) {
      console.error("autosave failed", e);
    }
  }, []);

  const scheduleAutosave = useCallback(() => {
    if (autosaveTimerRef.current != null) {
      window.clearTimeout(autosaveTimerRef.current);
    }
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      const target = pathRef.current;
      if (!target) return; // Untitled — manual ⌘S to choose a path
      const snapshot = currentMarkdownRef.current;
      if (snapshot === lastSavedRef.current) return;
      void writeToDisk(target, snapshot);
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [writeToDisk]);

  const loadFile = useCallback(async (p: string) => {
    try {
      const text = await invoke<string>("read_file", { path: p });
      if (autosaveTimerRef.current != null) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
      baselineCapturedRef.current = false;
      setPath(p);
      setInitialMarkdown(text);
      currentMarkdownRef.current = text;
      lastSavedRef.current = text;
      setDirty(false);
    } catch (e) {
      console.error(e);
      alert(`Could not open ${p}\n${e}`);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const pending = await invoke<string | null>("take_pending_open");
      if (pending) await loadFile(pending);
      setReady(true);
    })();
    const un = listen<OpenFilePayload>("open-file", (e) => {
      void loadFile(e.payload.path);
    });
    return () => {
      void un.then((f) => f());
    };
  }, [loadFile]);

  const onMarkdownChange = useCallback(
    (md: string) => {
      currentMarkdownRef.current = md;
      if (!baselineCapturedRef.current) {
        // First emit after load: Milkdown's normalized serialization of the
        // just-loaded file. Treat as the saved baseline; don't trigger save.
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
    }
    if (autosaveTimerRef.current != null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    await writeToDisk(target, currentMarkdownRef.current);
  }, [writeToDisk]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSave();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        cycleTheme();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleSave, cycleTheme]);

  // Flush on close (best-effort — Tauri close-requested event)
  useEffect(() => {
    const unlisten = getCurrentWindow().onCloseRequested(async () => {
      if (autosaveTimerRef.current != null) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
      const target = pathRef.current;
      if (target && currentMarkdownRef.current !== lastSavedRef.current) {
        await writeToDisk(target, currentMarkdownRef.current);
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, [writeToDisk]);

  useEffect(() => {
    const title = path ? `${dirty ? "● " : ""}${basename(path)}` : "MDE";
    void getCurrentWindow().setTitle(title);
  }, [path, dirty]);

  if (!ready) return null;

  return (
    <div className="app">
      <div className="drag-strip" data-tauri-drag-region />
      <main className="editor-wrap">
        <Editor
          ref={editorRef}
          key={path ?? "__empty__"}
          initialMarkdown={initialMarkdown}
          onChange={onMarkdownChange}
        />
      </main>
      <ThemeToast theme={theme} />
    </div>
  );
}

function ThemeToast({ theme }: { theme: Theme }) {
  const [visible, setVisible] = useState(false);
  const firstRenderRef = useRef(true);
  useEffect(() => {
    if (firstRenderRef.current) {
      firstRenderRef.current = false;
      return;
    }
    setVisible(true);
    const id = window.setTimeout(() => setVisible(false), 900);
    return () => window.clearTimeout(id);
  }, [theme]);
  if (!visible) return null;
  return <div className="theme-toast">{theme}</div>;
}
