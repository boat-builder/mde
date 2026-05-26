# MDE — Markdown Editor

A minimal Tauri 2 desktop app for editing markdown files with a Notion-style WYSIWYG editor (Milkdown / Crepe). Files are stored as plain markdown on disk.

## What it does

- Open one `.md` file at a time
- Live block-style editing: type `# foo` and it becomes an H1, type `**bold**` and it bolds inline, slash menu for blocks, drag handles, etc.
- Save back to the same `.md` file (lossless markdown round-trip via remark)
- Launches from:
  - Double-click on a `.md` file in Finder
  - `mde path/to/file.md` from the terminal (via a shim)
  - Existing window if already running (single-instance, file routes to the open window)

## Develop

```sh
pnpm install
pnpm tauri dev
```

## Build a release

```sh
pnpm tauri build
```

The app bundle is written to `src-tauri/target/release/bundle/macos/MDE.app`.
Install (or re-install) it with the helper script — it resolves paths
relative to the repo, so it works from any clone location:

```sh
./scripts/install-app.sh                 # default: installs to /Applications
./scripts/install-app.sh ~/Applications  # or any other directory
```

The script removes any existing bundle at the destination, copies the freshly
built one in, and refreshes LaunchServices so Finder picks up the `.md`
association. It re-runs itself under `sudo` only when the destination requires
it (e.g. `/Applications` on locked-down systems).

If you'd rather do it by hand, the equivalent commands are:

```sh
rm -rf /Applications/MDE.app
cp -R src-tauri/target/release/bundle/macos/MDE.app /Applications/
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f /Applications/MDE.app
```

The `rm -rf` step matters: macOS caches the previous bundle's file
associations even after `cp -R` overwrites the binary.

## Install the `mde` CLI shim

After the app is in `/Applications`:

```sh
./scripts/install-cli.sh                # tries /usr/local/bin, falls back to ~/.local/bin
sudo ./scripts/install-cli.sh           # if /usr/local/bin needs sudo
./scripts/install-cli.sh ~/.local/bin   # explicit target
```

Then:

```sh
mde notes.md
mde ~/projects/README.md
```

## Architecture

- **Frontend**: React + Vite + Milkdown Crepe (`@milkdown/crepe`). Crepe is Milkdown's batteries-included preset — slash menu, block handles, toolbar, Notion-like keyboard shortcuts.
- **Backend**: Tauri 2 (Rust). Two commands: `read_file` and `write_file`. `RunEvent::Opened` handles macOS file-open events (double-click on `.md`). `tauri-plugin-single-instance` forwards CLI argv from a second `mde` invocation into the running window.
- **File association**: Declared in `src-tauri/tauri.conf.json` under `bundle.fileAssociations`. Tauri injects `CFBundleDocumentTypes` into `Info.plist` at bundle time.
- **CLI**: `scripts/install-cli.sh` writes a small shell shim that calls `open -a MDE --args <files>`. macOS routes argv through LaunchServices to the bundled app.

## Saving

Auto-saves to the open file 600ms after the last keystroke. `⌘S` forces an
immediate save (and is the only way to save an Untitled buffer — it opens a
Save dialog).

## Keyboard

- `⌘S` — force save now (or Save As if the file is untitled)
- `⌘Z` / `⌘⇧Z` — undo / redo (also `⌘Y` for redo)
- All Milkdown/Crepe inline-format shortcuts: `⌘B` bold, `⌘I` italic, `⌘K` link, etc.
- `/` on a new line — slash menu (headings, lists, code blocks, tables, …)

To open a file: double-click a `.md` in Finder, or `mde path/to/file.md` from
the terminal.

## UI elements

- **Top-left** — the filename (muted, small). Hover it to reveal a copy
  button that copies the full file path to the clipboard.
- **Bottom-left** — a small gear button opens a settings popover. Currently
  exposes the appearance picker.

## Themes

- **system** (default) — follows macOS appearance.
- **light** — Notion-style pure white (`#ffffff`) with warm-dark text (`#37352f`).
- **sepia** — paper / iA Writer feel, cream (`#faf5ed`) on warm-dark — easier on
  the eyes than pure white in bright rooms.
- **dark** — low-contrast dark gray (`#191919`/`#ebebeb`).

Theme is persisted to `localStorage` under `mde:theme`.
