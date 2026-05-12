# Changelog

## 0.2.2

### Fixed
- **Horizontal scrolling**: long lines were silently clipped with `…` and could not be scrolled to. Scroll containers now show a horizontal scrollbar, code cells no longer clip with `text-overflow:ellipsis`, and diff tables expand to fit content width instead of being clamped to the viewport.

## 0.2.1

### Added
- **Ctrl+F find bar**: opens a minimal find bar at the top of the diff pane. Case-insensitive substring search with prev/next navigation, match count, and `Enter` / `Shift+Enter` / `Esc` shortcuts. In the sidebar it filters the file list by path. Auto-focused on open.
- **Double-click occurrence highlight**: double-clicking a word highlights all other occurrences in the diff using VS Code's `editor.wordHighlightBackground` color. Clears on single-click or Escape. Does not interfere with drag-to-select.
- **Minimap diff markers**: the minimap rail shows green for added lines and red for removed lines, with a visible viewport indicator that supports click-to-jump and drag-to-scrub.
- **Auto-run on branch selection change**: changing base/compare branch or pressing swap now immediately reruns the diff; the explicit Compare button has been removed.
- **Activity Bar entry**: WTF Changed now has its own Activity Bar icon with a "Compare branches…" launcher.
- **Settings popover**: the "Committed only / Include working tree" toggle moved into a ⚙ popover (top-right of toolbar) with explanatory subtitles.

## 0.2.0

### Changed
- Rebranded from "Branch Compare" to **WTF Changed**. Command id is now `wtfChanged.open` (palette: `WTF Changed: Compare Branches` — searchable as `compare branches`).

### Added
- **Working tree support**: when comparing against the current branch, the diff now includes uncommitted/unstaged changes and untracked files by default. Toggle between **Committed only** and **Include working tree** in the toolbar; the toggle auto-disables when it isn't applicable.

### Fixed
- **Full file + Side by side blank view**: pure-addition hunks (e.g. appending lines to `.env`, YAML, or lockfiles) crashed `buildSbsFullRows` with a `TypeError` on `rem.oldLineNo` when no preceding removal existed to pair with. The faulty optional-chaining guard (`rem?.oldLineNo !== null` returns `true` for `undefined`) was replaced with an explicit `rem && rem.oldLineNo !== null` check.

## 0.0.1

- Initial release: side-by-side / inline diff, changed / full-file view, file tree, minimap, auto-refresh on save.
