# Changelog

## 0.2.0

### Changed
- Rebranded from "Branch Compare" to **WTF Changed**. Command id is now `wtfChanged.open` (palette: `WTF Changed: Compare Branches` — searchable as `compare branches`).

### Added
- **Working tree support**: when comparing against the current branch, the diff now includes uncommitted/unstaged changes and untracked files by default. Toggle between **Committed only** and **Include working tree** in the toolbar; the toggle auto-disables when it isn't applicable.

### Fixed
- **Full file + Side by side blank view**: pure-addition hunks (e.g. appending lines to `.env`, YAML, or lockfiles) crashed `buildSbsFullRows` with a `TypeError` on `rem.oldLineNo` when no preceding removal existed to pair with. The faulty optional-chaining guard (`rem?.oldLineNo !== null` returns `true` for `undefined`) was replaced with an explicit `rem && rem.oldLineNo !== null` check.

## 0.0.1

- Initial release: side-by-side / inline diff, changed / full-file view, file tree, minimap, auto-refresh on save.
