# MDE — Markdown Editor

A minimal Tauri 2 desktop app for editing markdown files with a Notion-style WYSIWYG editor (Milkdown / Crepe). Files are stored as plain markdown on disk.

## What it does

- Edit one `.md` file at a time, optionally inside a folder workspace with a
  collapsible file sidebar
- Live block-style editing: type `# foo` and it becomes an H1, type `**bold**` and it bolds inline, slash menu for blocks, drag handles, etc.
- Save back to the same `.md` file (lossless markdown round-trip via remark)
- Launches from:
  - Double-click on a `.md` file (or a folder) in Finder
  - `mde path/to/file.md` or `mde path/to/dir` from the terminal (via a shim)
  - Existing window if already running (single-instance, the path routes to the open window)

## Develop

```sh
pnpm install
pnpm tauri dev
```

## Build & install

One script does it all — build the release bundle, install `MDE.app` to
`/Applications`, install the `mde` CLI shim:

```sh
./scripts/install.sh
```

Run it the first time to set everything up, and re-run it any time you
change the code. It is idempotent — the old bundle is wiped before the new
one is copied so LaunchServices doesn't cache stale `.md` associations.

Prerequisites: `pnpm` and Rust (`rustup`). The script sources `~/.cargo/env`
itself, so the common zsh-doesn't-read-bash-profile gotcha is handled
automatically.

Optional env overrides if the defaults don't fit:

```sh
APP_DIR=~/Applications  ./scripts/install.sh   # install .app elsewhere
CLI_DIR=~/.local/bin    ./scripts/install.sh   # install shim elsewhere
SKIP_BUILD=1            ./scripts/install.sh   # re-install without rebuilding
SKIP_CLI=1              ./scripts/install.sh   # only the .app, no shim
```

Once installed:

```sh
mde notes.md
mde ~/projects/README.md
mde ~/notes                # opens a folder as a workspace
mde                        # opens an empty editor (welcome screen)
```

Or double-click a `.md` file (or a folder) in Finder.

## Architecture

- **Frontend**: React + Vite + Milkdown Crepe (`@milkdown/crepe`). Crepe is Milkdown's batteries-included preset — slash menu, block handles, toolbar, Notion-like keyboard shortcuts.
- **Backend**: Tauri 2 (Rust). Commands: `read_file`, `write_file`, `list_md_tree` (walks a directory, returning a pruned tree of folders that contain markdown), `reveal_in_finder`, plus pending-open hand-off for the initial CLI args. `RunEvent::Opened` handles macOS open events for both files and folders. `tauri-plugin-single-instance` forwards CLI argv from a second `mde` invocation into the running window.
- **File association**: Declared in `src-tauri/tauri.conf.json` under `bundle.fileAssociations`. Tauri injects `CFBundleDocumentTypes` into `Info.plist` at bundle time.
- **CLI**: `scripts/install.sh` writes a small `mde` shell shim that calls `open -a MDE --args <files>`. macOS routes argv through LaunchServices to the bundled app.

## Saving

Auto-saves to the open file 600ms after the last keystroke. `⌘S` forces an
immediate save (and is the only way to save an Untitled buffer — it opens a
Save dialog).

## Keyboard

- `⌘S` — force save now (or Save As if the file is untitled)
- `⌘O` — open a file
- `⌘⇧O` — open a folder as a workspace
- `⌘\` — toggle the sidebar (only when a workspace is open)
- `⌘Z` / `⌘⇧Z` — undo / redo (also `⌘Y` for redo)
- All Milkdown/Crepe inline-format shortcuts: `⌘B` bold, `⌘I` italic, `⌘K` link, etc.
- `/` on a new line — slash menu (headings, lists, code blocks, tables, …)

## UI elements

- **Welcome screen** — shown when MDE opens with no file and no workspace.
  Buttons for *Open file* and *Open folder*; just start typing if you want a
  scratch buffer.
- **Sidebar** (when a workspace is open) — collapsible tree of `.md` files
  under the workspace root. Folders that contain no markdown are hidden. The
  folder name at the top is a menu: *Open folder…*, *Open file…*,
  *Reveal in Finder*, *Close workspace*. A refresh button next to it re-scans
  the workspace, and the tree auto-refreshes on window focus.
- **Top-left** — sidebar toggle (when a workspace is open) and the filename
  (muted, small). Hover the filename to reveal a copy button that copies the
  full file path to the clipboard.
- **Bottom-left** — a small gear button opens a settings popover with file
  actions and the appearance picker.

The last opened workspace and sidebar visibility are remembered in
`localStorage` and restored on next launch.

## Themes

- **system** (default) — follows macOS appearance.
- **light** — Notion-style pure white (`#ffffff`) with warm-dark text (`#37352f`).
- **sepia** — paper / iA Writer feel, cream (`#faf5ed`) on warm-dark — easier on
  the eyes than pure white in bright rooms.
- **dark** — low-contrast dark gray (`#191919`/`#ebebeb`).

Theme is persisted to `localStorage` under `mde:theme`.
