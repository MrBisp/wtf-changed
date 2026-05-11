# WTF Changed – Feature Requests

Captured 2026-05-11.

## Search / navigation

- ~~**Ctrl+F not supported.**~~ ✅ Done. Ctrl+F opens a minimal find bar at the top of whichever pane has focus: in the diff it does case-insensitive substring search with prev/next nav, match count, and `Enter` / `Shift+Enter` / `Esc` shortcuts; in the sidebar it filters the file list by path. Input is auto-focused on open.
- ~~**Selection highlight for matching occurrences.**~~ ✅ Done. **Double-click** a word (mirrors VS Code editor behaviour) to highlight all other occurrences in the visible diff using VS Code's `editor.wordHighlightBackground` color. Single-drag selection is left alone so reading-aloud selections don't get interfered with. Clears on any single-click or Escape. Only matches text in code cells (line numbers/gutter excluded).
- ~~**Scrollbar diff markers.**~~ ✅ Done. A minimap rail (already in the codebase) was widened, brightened, and given a visible viewport indicator. It shows green for added lines, red for removed lines, and supports click-to-jump and drag-to-scrub.

## Layout / discoverability

- ~~**Auto-run on selection change.**~~ ✅ Done. Changing base/compare (or pressing swap) now auto-runs Compare; the explicit Compare button has been removed.
- ~~**Activity Bar entry.**~~ ✅ Done. WTF Changed now appears in the Activity Bar with a single "Compare branches…" launcher item.
- ~~**Confusing: "Committed only" vs "Include working tree" toggle.**~~ ✅ Done. Moved into a ⚙ settings popover (top-right of the toolbar) with explanatory subtitles and a contextual hint about when the option applies.

## Deferred / not now

- **"Changed" + side-by-side combination.** Works on Frederik's machine, broken on Jacob's. Defer until reproducible.
- **Slow file switching.** Acceptable for now.
