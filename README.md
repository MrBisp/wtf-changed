# WTF Changed

A focused diff viewer for figuring out *what the f\*\*\* changed* between two git branches — in a single panel, without leaving your editor or pushing to a browser. Built for code review, pre-PR sanity checks, and answering "wait, what's actually different here?"

## Why

The built-in `git diff` view in VS Code shows one file at a time and is awkward for browsing many files across two branches. Web-based tools (GitHub, Azure DevOps) require pushing first and break your local flow. WTF Changed gives you a permanent side-by-side or inline view of every changed file, with first-class support for uncommitted work.

## Features

### Compare any two branches
- Pick a base and a compare branch from dropdowns sorted by most recent commit
- Swap them with one click
- Defaults to `main` (or `master`) vs your current branch on open

### Working tree included by default
- When comparing against your **current** branch, the diff includes:
  - **Committed** changes
  - **Staged** changes
  - **Unstaged** changes in tracked files
  - **Untracked** files (rendered as additions)
- Toggle between **Committed only** and **Include working tree** in the toolbar
- The toggle auto-disables when it doesn't apply (i.e. when neither branch is your current checkout)

### Two view modes × two layouts
| | Inline | Side by side |
|---|---|---|
| **Changed** | Unified diff, changed hunks only | Two-pane view, only the changed regions |
| **Full file** | Full file with diff hunks highlighted | Two-pane view with full file context on both sides |

### Quality-of-life
- **Auto-refresh on save** — edit a file in the same workspace and the diff updates silently
- **Manual refresh** button that re-runs the comparison
- **Open file** button jumps to the file in a regular editor tab
- **Minimap** down the side of each diff pane shows where adds (green) and removes (red) are concentrated; click anywhere on it to jump
- **Synchronized scrolling** between the left and right panes in side-by-side mode
- **Draggable divider** between the two panes
- **Resizable sidebar** for the file tree
- **Folder tree** view with expand/collapse and per-folder counts
- **Auto-scroll** to the first change in each file

## Usage

1. Open the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Run **WTF Changed: Compare Branches** (or just type `compare branches`)
3. Pick branches in the toolbar, click **Compare**
4. Click a file in the sidebar to view its diff

The view persists when hidden (the webview is retained), so you can flip between it and your editor without losing state.

## Requirements

- Git installed and available on `PATH`
- The workspace must be inside a git repository

## Known limitations

- Binary files are not rendered (git's "Binary files differ" output is shown as no textual diff)
- Renames are detected by `git diff --name-status` but the rename pair is shown as two entries
- Very large files (multi-MB) may take a moment to render because the full file content is sent to the webview

## Installation (sideload)

```bash
# from the extension folder
pnpm install
pnpm compile
pnpm package    # produces wtf-changed-0.2.0.vsix
```

Then in VS Code: `Extensions` → `...` menu → `Install from VSIX...` → pick the file.

## Changelog

See `CHANGELOG.md` in the repository root for version history.
