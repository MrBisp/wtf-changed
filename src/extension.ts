import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";

export function activate(context: vscode.ExtensionContext) {
  const cmd = vscode.commands.registerCommand("wtfChanged.open", () => {
    BranchComparePanel.createOrShow(context);
  });
  context.subscriptions.push(cmd);

  const launcher = new LauncherProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("wtfChanged.launcher", launcher),
  );
}

class LauncherProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  getTreeItem(item: vscode.TreeItem) { return item; }
  getChildren(): vscode.TreeItem[] {
    const item = new vscode.TreeItem("Compare branches…", vscode.TreeItemCollapsibleState.None);
    item.command = { command: "wtfChanged.open", title: "Open WTF Changed" };
    item.iconPath = new vscode.ThemeIcon("git-compare");
    return [item];
  }
}

export function deactivate() {}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function exec(cmd: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.exec(cmd, { cwd, maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(stderr || err.message)); }
      else { resolve(stdout.trim()); }
    });
  });
}

async function getRepoRoot(): Promise<string> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) { throw new Error("No workspace folder open."); }
  return exec("git rev-parse --show-toplevel", folders[0].uri.fsPath);
}

async function getBranches(cwd: string): Promise<string[]> {
  const raw = await exec("git branch --sort=-committerdate --format=%(refname:short)", cwd);
  return raw.split("\n").filter(Boolean);
}

async function getCurrentBranch(cwd: string): Promise<string> {
  return exec("git rev-parse --abbrev-ref HEAD", cwd);
}

interface ChangedFile { status: string; path: string; oldPath?: string; }

async function getChangedFiles(cwd: string, base: string, compare: string, includeWorkingTree: boolean): Promise<ChangedFile[]> {
  const parseNameStatus = (raw: string): ChangedFile[] =>
    raw.split("\n").filter(Boolean).map((line) => {
      const parts = line.split("\t");
      const status = parts[0].charAt(0);
      if (status === "R" || status === "C") { return { status, oldPath: parts[1], path: parts[2] }; }
      return { status, path: parts[1] };
    });

  if (includeWorkingTree) {
    // Compare base against working tree (committed + staged + unstaged), then add untracked files
    const [trackedRaw, untrackedRaw] = await Promise.all([
      exec(`git diff --name-status "${base}"`, cwd).catch(() => ""),
      exec(`git ls-files --others --exclude-standard`, cwd).catch(() => ""),
    ]);
    const tracked = parseNameStatus(trackedRaw);
    const untracked: ChangedFile[] = untrackedRaw.split("\n").filter(Boolean).map((p) => ({ status: "A", path: p }));
    // De-duplicate by path (in case the same path somehow appears in both)
    const seen = new Set(tracked.map(f => f.path));
    const all = [...tracked, ...untracked.filter(f => !seen.has(f.path))];
    return all;
  }

  const raw = await exec(`git diff --name-status "${base}".."${compare}"`, cwd);
  if (!raw) { return []; }
  return parseNameStatus(raw);
}

interface DiffLine { type: "context" | "add" | "remove"; content: string; oldLineNo: number | null; newLineNo: number | null; }
interface FileDiff { lines: DiffLine[]; baseLines: string[]; compareLines: string[]; }

async function getFileContent(cwd: string, ref: string, filePath: string): Promise<string> {
  try { return await exec(`git show "${ref}":"${filePath}"`, cwd); }
  catch { return ""; }
}

function readWorkingTreeFile(cwd: string, filePath: string): string {
  try { return fs.readFileSync(path.join(cwd, filePath), "utf8"); }
  catch { return ""; }
}

async function getFileDiff(cwd: string, base: string, compare: string, filePath: string, includeWorkingTree: boolean): Promise<FileDiff> {
  let rawDiff: string;
  let baseContent: string;
  let compareContent: string;

  if (includeWorkingTree) {
    // Diff base against working tree directly; compare side = file on disk
    [rawDiff, baseContent, compareContent] = await Promise.all([
      exec(`git diff --ignore-all-space "${base}" -- "${filePath}"`, cwd).catch(() => ""),
      getFileContent(cwd, base, filePath),
      Promise.resolve(readWorkingTreeFile(cwd, filePath)),
    ]);
    // Untracked file: no diff output from `git diff`. Synthesize one from disk content.
    if (!rawDiff && compareContent && !baseContent) {
      const fileLines = compareContent.split("\n");
      const header = `@@ -0,0 +1,${fileLines.length} @@`;
      rawDiff = header + "\n" + fileLines.map(l => "+" + l).join("\n");
    }
  } else {
    [rawDiff, baseContent, compareContent] = await Promise.all([
      exec(`git diff --ignore-all-space "${base}".."${compare}" -- "${filePath}"`, cwd).catch(() => ""),
      getFileContent(cwd, base, filePath),
      getFileContent(cwd, compare, filePath),
    ]);
  }

  const baseLines = baseContent ? baseContent.split("\n") : [];
  const compareLines = compareContent ? compareContent.split("\n") : [];
  const lines: DiffLine[] = [];
  let oldLine = 0, newLine = 0, inHunk = false;

  for (const line of rawDiff.split("\n")) {
    if (line.startsWith("@@")) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { oldLine = parseInt(m[1]); newLine = parseInt(m[2]); }
      inHunk = true;
      lines.push({ type: "context", content: line, oldLineNo: null, newLineNo: null });
      continue;
    }
    if (!inHunk) { continue; }
    if (line.startsWith("+"))       { lines.push({ type: "add",     content: line.slice(1), oldLineNo: null,    newLineNo: newLine++ }); }
    else if (line.startsWith("-"))  { lines.push({ type: "remove",  content: line.slice(1), oldLineNo: oldLine++, newLineNo: null }); }
    else if (line.startsWith("\\")) { /* no-newline marker */ }
    else                            { lines.push({ type: "context", content: line.slice(1), oldLineNo: oldLine++, newLineNo: newLine++ }); }
  }

  return { lines, baseLines, compareLines };
}

// ---------------------------------------------------------------------------
// Webview panel
// ---------------------------------------------------------------------------

class BranchComparePanel {
  static currentPanel: BranchComparePanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _cwd: string = "";
  // Track what's currently shown so we can auto-refresh on save
  private _currentBase    = "";
  private _currentCompare = "";
  private _currentFile    = "";
  private _currentBranch  = "";
  private _includeWT      = true;

  private _effectiveWT(compare: string): boolean {
    return this._includeWT && compare === this._currentBranch;
  }

  static async createOrShow(context: vscode.ExtensionContext) {
    if (BranchComparePanel.currentPanel) {
      BranchComparePanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
      BranchComparePanel.currentPanel._init();
      return;
    }
    let cwd: string;
    try { cwd = await getRepoRoot(); }
    catch (e: any) { vscode.window.showErrorMessage(`WTF Changed: ${e.message}`); return; }

    const panel = vscode.window.createWebviewPanel(
      "wtfChanged", "WTF Changed", vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "icon.png");
    BranchComparePanel.currentPanel = new BranchComparePanel(panel, cwd);
  }

  private constructor(panel: vscode.WebviewPanel, cwd: string) {
    this._panel = panel;
    this._cwd   = cwd;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage((msg) => this._handleMessage(msg), null, this._disposables);

    // Auto-refresh: when a file is saved, silently re-fetch diff if it's the currently viewed file
    const saveWatcher = vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!this._currentBase || !this._currentCompare) { return; }
      const rel = vscode.workspace.asRelativePath(doc.uri, false).replace(/\\/g, "/");
      // Always refresh the file list (new files might appear) and re-fetch the diff if visible
      this._refreshAfterSave(rel);
    });
    this._disposables.push(saveWatcher);

    // Watch .git/HEAD so we react to branch switches (checkout). The file's content
    // changes from "ref: refs/heads/old" to "ref: refs/heads/new" on checkout.
    const headPattern = new vscode.RelativePattern(this._cwd, ".git/HEAD");
    const headWatcher = vscode.workspace.createFileSystemWatcher(headPattern);
    const onHeadChange = () => this._onBranchSwitch();
    headWatcher.onDidChange(onHeadChange, null, this._disposables);
    headWatcher.onDidCreate(onHeadChange, null, this._disposables);
    this._disposables.push(headWatcher);

    this._init();
  }

  // Debounce branch-switch handling — git often touches HEAD multiple times in quick succession.
  private _branchSwitchTimer: NodeJS.Timeout | undefined;
  private _onBranchSwitch() {
    if (this._branchSwitchTimer) { clearTimeout(this._branchSwitchTimer); }
    this._branchSwitchTimer = setTimeout(() => this._handleBranchSwitch(), 250);
  }

  private async _handleBranchSwitch() {
    try {
      const newBranch = await getCurrentBranch(this._cwd);
      if (newBranch === this._currentBranch) { return; }

      const prevBranch  = this._currentBranch;
      const wasFollowing = this._currentCompare === prevBranch;
      this._currentBranch = newBranch;

      const branches = await getBranches(this._cwd);

      if (wasFollowing && this._currentBase !== newBranch) {
        // Compare was tracking the old current branch — follow to the new one and re-run.
        this._currentCompare = newBranch;
        const wt = this._effectiveWT(this._currentCompare);
        const files = await getChangedFiles(this._cwd, this._currentBase, this._currentCompare, wt);
        this._panel.webview.postMessage({
          type: "branchSwitched",
          branches,
          base: this._currentBase,
          compare: this._currentCompare,
          currentBranch: newBranch,
          files,
        });
        if (this._currentFile) {
          const diff = await getFileDiff(this._cwd, this._currentBase, this._currentCompare, this._currentFile, wt);
          this._panel.webview.postMessage({ type: "diff", filePath: this._currentFile, diff, silent: true });
        }
      } else {
        // Not following — just update state so the working-tree toggle reasoning stays correct,
        // and silently refresh the file list (working-tree contents changed with the checkout).
        this._panel.webview.postMessage({
          type: "branchSwitched",
          branches,
          base: this._currentBase,
          compare: this._currentCompare,
          currentBranch: newBranch,
        });
        if (this._currentBase && this._currentCompare) {
          const wt = this._effectiveWT(this._currentCompare);
          const files = await getChangedFiles(this._cwd, this._currentBase, this._currentCompare, wt);
          this._panel.webview.postMessage({ type: "files", files, preserveSelection: true });
          if (this._currentFile) {
            const diff = await getFileDiff(this._cwd, this._currentBase, this._currentCompare, this._currentFile, wt);
            this._panel.webview.postMessage({ type: "diff", filePath: this._currentFile, diff, silent: true });
          }
        }
      }
    } catch { /* ignore — repo might be in a transient state mid-checkout */ }
  }

  private async _refreshAfterSave(savedRelPath: string) {
    try {
      const wt = this._effectiveWT(this._currentCompare);
      const files = await getChangedFiles(this._cwd, this._currentBase, this._currentCompare, wt);
      this._panel.webview.postMessage({ type: "files", files, preserveSelection: true });
      // If the saved file is the one being viewed, re-fetch its diff
      if (this._currentFile && (savedRelPath === this._currentFile || savedRelPath.endsWith(this._currentFile))) {
        const diff = await getFileDiff(this._cwd, this._currentBase, this._currentCompare, this._currentFile, wt);
        this._panel.webview.postMessage({ type: "diff", filePath: this._currentFile, diff, silent: true });
      }
    } catch { /* ignore */ }
  }

  private async _init() {
    const [branches, current] = await Promise.all([getBranches(this._cwd), getCurrentBranch(this._cwd)]);
    this._currentBranch = current;
    const base    = branches.includes("main") ? "main" : branches.includes("master") ? "master" : branches[0];
    const compare = current === base ? base : current;

    if (this._panel.webview.html) {
      this._panel.webview.postMessage({ type: "init", branches, base, compare, currentBranch: current, includeWT: this._includeWT });
    } else {
      this._panel.webview.html = getWebviewHtml();
      setTimeout(() => {
        this._panel.webview.postMessage({ type: "init", branches, base, compare, currentBranch: current, includeWT: this._includeWT });
      }, 120);
    }
  }

  private async _handleMessage(msg: any) {
    switch (msg.type) {
      case "compare": {
        this._currentBase    = msg.base;
        this._currentCompare = msg.compare;
        if (typeof msg.includeWT === "boolean") { this._includeWT = msg.includeWT; }
        try {
          const files = await getChangedFiles(this._cwd, msg.base, msg.compare, this._effectiveWT(msg.compare));
          this._panel.webview.postMessage({ type: "files", files });
        } catch (e: any) {
          this._panel.webview.postMessage({ type: "error", message: e.message });
        }
        break;
      }
      case "diff": {
        this._currentFile = msg.filePath;
        try {
          const diff = await getFileDiff(this._cwd, msg.base, msg.compare, msg.filePath, this._effectiveWT(msg.compare));
          this._panel.webview.postMessage({ type: "diff", filePath: msg.filePath, diff });
        } catch (e: any) {
          this._panel.webview.postMessage({ type: "error", message: e.message });
        }
        break;
      }
      case "openFile": {
        try {
          const root = this._cwd;
          const full = vscode.Uri.file(path.join(root, msg.filePath));
          const doc  = await vscode.workspace.openTextDocument(full);
          await vscode.window.showTextDocument(doc, { preview: false });
        } catch (e: any) {
          vscode.window.showErrorMessage(`WTF Changed: cannot open file — ${e.message}`);
        }
        break;
      }
      case "refresh": {
        // Manual refresh button: re-run full compare
        try {
          const wt = this._effectiveWT(this._currentCompare);
          const files = await getChangedFiles(this._cwd, this._currentBase, this._currentCompare, wt);
          this._panel.webview.postMessage({ type: "files", files, preserveSelection: true });
          if (this._currentFile) {
            const diff = await getFileDiff(this._cwd, this._currentBase, this._currentCompare, this._currentFile, wt);
            this._panel.webview.postMessage({ type: "diff", filePath: this._currentFile, diff, silent: true });
          }
        } catch (e: any) {
          this._panel.webview.postMessage({ type: "error", message: e.message });
        }
        break;
      }
    }
  }

  dispose() {
    BranchComparePanel.currentPanel = undefined;
    this._panel.dispose();
    for (const d of this._disposables) { d.dispose(); }
    this._disposables = [];
  }
}

// ---------------------------------------------------------------------------
// Webview HTML
// ---------------------------------------------------------------------------

function getWebviewHtml(): string {
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>WTF Changed</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg:             var(--vscode-editor-background);
  --fg:             var(--vscode-editor-foreground);
  --border:         var(--vscode-panel-border, #333);
  --input-bg:       var(--vscode-input-background);
  --input-fg:       var(--vscode-input-foreground);
  --input-border:   var(--vscode-input-border, #555);
  --btn-bg:         var(--vscode-button-background);
  --btn-fg:         var(--vscode-button-foreground);
  --btn-hover:      var(--vscode-button-hoverBackground);
  --list-hover:     var(--vscode-list-hoverBackground);
  --list-active:    var(--vscode-list-activeSelectionBackground);
  --list-active-fg: var(--vscode-list-activeSelectionForeground);
  --badge-bg:       var(--vscode-badge-background);
  --badge-fg:       var(--vscode-badge-foreground);
  --tree-indent:    var(--vscode-tree-indentGuidesStroke, rgba(128,128,128,0.2));
  --add-bg:         rgba(70,149,74,0.15);
  --add-fg:         #4ec769;
  --del-bg:         rgba(218,54,51,0.15);
  --del-fg:         #f14c4c;
  --hunk-bg:        rgba(30,100,200,0.10);
  --hunk-fg:        var(--vscode-textLink-foreground, #4daafc);
  --font:           var(--vscode-font-family, system-ui, sans-serif);
  --mono:           var(--vscode-editor-font-family, "Menlo","Consolas",monospace);
  --font-size:      var(--vscode-font-size, 13px);
  --mono-size:      var(--vscode-editor-font-size, 12px);
  --radius:         5px;
}

body { background:var(--bg); color:var(--fg); font-family:var(--font); font-size:var(--font-size); height:100vh; display:flex; flex-direction:column; overflow:hidden; }

/* ── Toolbar ── */
.toolbar { display:flex; align-items:center; gap:10px; padding:8px 14px; border-bottom:1px solid var(--border); flex-shrink:0; flex-wrap:wrap; row-gap:6px; }
.toolbar-title { font-size:13px; font-weight:600; opacity:0.8; white-space:nowrap; }
.branch-group { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.branch-group label { font-size:10px; opacity:0.55; text-transform:uppercase; letter-spacing:0.07em; white-space:nowrap; }

select { background:var(--input-bg); color:var(--input-fg); border:1px solid var(--input-border); border-radius:var(--radius); padding:4px 26px 4px 9px; font-size:var(--font-size); font-family:var(--font); appearance:none; -webkit-appearance:none; background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23888'/%3E%3C/svg%3E"); background-repeat:no-repeat; background-position:right 8px center; cursor:pointer; min-width:140px; max-width:240px; }
select:focus { outline:1px solid var(--btn-bg); }

.icon-btn { background:none; border:1px solid var(--input-border); border-radius:var(--radius); color:var(--fg); padding:4px 7px; cursor:pointer; font-size:13px; line-height:1; opacity:0.65; transition:opacity 0.12s,background 0.12s; }
.icon-btn:hover { opacity:1; background:var(--list-hover); }
.icon-btn.spin-anim { animation: spin 0.6s linear infinite; opacity:1; }

.primary-btn { background:var(--btn-bg); color:var(--btn-fg); border:none; border-radius:var(--radius); padding:5px 14px; font-size:var(--font-size); font-family:var(--font); cursor:pointer; font-weight:500; transition:background 0.12s; white-space:nowrap; }
.primary-btn:hover { background:var(--btn-hover); }
.primary-btn:disabled { opacity:0.45; cursor:default; }

.toolbar-sep { width:1px; height:22px; background:var(--border); margin:0 2px; flex-shrink:0; }

.toggle-group { display:flex; border:1px solid var(--input-border); border-radius:var(--radius); overflow:hidden; flex-shrink:0; }
.toggle-btn { background:none; border:none; border-right:1px solid var(--input-border); color:var(--fg); padding:4px 11px; font-size:11px; font-family:var(--font); cursor:pointer; opacity:0.55; transition:background 0.1s,opacity 0.1s; white-space:nowrap; }
.toggle-btn:last-child { border-right:none; }
.toggle-btn:hover { background:var(--list-hover); opacity:0.85; }
.toggle-btn.active { background:var(--btn-bg); color:var(--btn-fg); opacity:1; }

/* ── Settings popover ── */
.settings-wrap { position:relative; }
.popover { position:absolute; right:0; top:calc(100% + 6px); z-index:50; background:var(--vscode-menu-background, var(--bg)); color:var(--vscode-menu-foreground, var(--fg)); border:1px solid var(--vscode-menu-border, var(--border)); border-radius:6px; box-shadow:0 6px 20px rgba(0,0,0,0.35); min-width:280px; padding:8px 4px; }
.popover[hidden] { display:none; }
.popover-section { display:flex; flex-direction:column; gap:2px; }
.popover-label { font-size:10px; text-transform:uppercase; letter-spacing:0.07em; opacity:0.55; padding:4px 12px 6px; }
.popover-radio { display:grid; grid-template-columns:auto 1fr; grid-template-rows:auto auto; column-gap:10px; align-items:center; padding:7px 12px; cursor:pointer; border-radius:4px; }
.popover-radio:hover { background:var(--list-hover); }
.popover-radio input { grid-row:1 / span 2; margin:0; cursor:pointer; }
.popover-radio-main { font-size:12px; }
.popover-radio-sub { font-size:11px; opacity:0.6; }
.popover-radio.disabled { opacity:0.4; cursor:not-allowed; }
.popover-radio.disabled input { cursor:not-allowed; }
.popover-hint { font-size:11px; opacity:0.6; padding:4px 12px 4px; font-style:italic; }
.popover-hint:empty { display:none; }

/* ── Main ── */
.main { display:flex; flex:1; overflow:hidden; }

/* ── Sidebar ── */
.sidebar { width:260px; min-width:160px; border-right:1px solid var(--border); display:flex; flex-direction:column; overflow:hidden; flex-shrink:0; position:relative; }
.sidebar-head { padding:6px 11px; font-size:10px; text-transform:uppercase; letter-spacing:0.07em; opacity:0.5; border-bottom:1px solid var(--border); flex-shrink:0; display:flex; align-items:center; justify-content:space-between; gap:6px; }
.badge { background:var(--badge-bg); color:var(--badge-fg); border-radius:10px; padding:1px 6px; font-size:10px; font-weight:600; }
.file-tree { flex:1; overflow-y:auto; padding:3px 0; }

/* tree nodes */
.tree-folder { display:flex; align-items:center; gap:5px; padding:4px 8px; cursor:pointer; user-select:none; transition:background 0.08s; }
.tree-folder:hover { background:var(--list-hover); }
.tree-folder-icon { font-size:11px; opacity:0.6; transition:transform 0.15s; flex-shrink:0; width:14px; text-align:center; }
.tree-folder-icon.open { transform:rotate(90deg); }
.tree-folder-name { font-size:11.5px; font-family:var(--mono); opacity:0.7; }
.tree-folder-badge { margin-left:auto; background:var(--badge-bg); color:var(--badge-fg); border-radius:8px; padding:0 5px; font-size:9px; font-weight:600; flex-shrink:0; }
.tree-children { display:none; }
.tree-children.open { display:block; }

.file-item { display:flex; align-items:center; gap:7px; padding:4px 8px; cursor:pointer; transition:background 0.08s; user-select:none; }
.file-item:hover { background:var(--list-hover); }
.file-item.active { background:var(--list-active); color:var(--list-active-fg); }

.fstatus { font-size:9px; font-weight:700; padding:1px 4px; border-radius:3px; flex-shrink:0; text-transform:uppercase; letter-spacing:0.05em; }
.s-A { background:rgba(70,149,74,0.25);  color:#4ec769; }
.s-M { background:rgba(200,150,30,0.25); color:#d4a632; }
.s-D { background:rgba(218,54,51,0.25);  color:#f14c4c; }
.s-R { background:rgba(80,120,200,0.25); color:#6eabf0; }
.s-C { background:rgba(80,180,180,0.25); color:#4dcbcb; }
.s-U { background:rgba(200,80,200,0.25); color:#d46ad4; }

.fname { font-size:11.5px; font-family:var(--mono); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; min-width:0; }

.sidebar-resize { position:absolute; right:-3px; top:0; bottom:0; width:6px; cursor:col-resize; z-index:10; }
.sidebar-resize:hover, .sidebar-resize.dragging { background:var(--btn-bg); opacity:0.4; }

/* ── Diff area ── */
.diff-area { flex:1; display:flex; flex-direction:column; overflow:hidden; min-width:0; }

.diff-bar { padding:5px 12px; border-bottom:1px solid var(--border); flex-shrink:0; display:flex; align-items:center; gap:8px; min-height:31px; }
.diff-filepath { font-family:var(--mono); font-size:11.5px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
.open-btn { background:none; border:1px solid var(--input-border); border-radius:var(--radius); color:var(--fg); padding:3px 9px; font-size:11px; font-family:var(--font); cursor:pointer; opacity:0.65; white-space:nowrap; transition:opacity 0.12s,background 0.12s; flex-shrink:0; }
.open-btn:hover { opacity:1; background:var(--list-hover); }

/* ── Find bar ── */
.find-bar { display:none; align-items:center; gap:6px; padding:5px 8px; border-bottom:1px solid var(--border); background:var(--vscode-editorWidget-background, var(--bg)); flex-shrink:0; }
.find-bar.open { display:flex; }
.find-bar input { flex:1; min-width:0; background:var(--vscode-input-background, var(--bg)); color:var(--vscode-input-foreground, var(--fg)); border:1px solid var(--input-border); border-radius:var(--radius); padding:3px 7px; font-size:12px; font-family:var(--font); outline:none; }
.find-bar input:focus { border-color:var(--vscode-focusBorder, var(--input-border)); }
.find-bar .find-count { font-size:11px; opacity:0.65; min-width:50px; text-align:center; white-space:nowrap; }
.find-bar .find-count.no-match { color:var(--vscode-errorForeground, #f48771); opacity:1; }
.find-bar button { background:none; border:1px solid transparent; border-radius:var(--radius); color:var(--fg); padding:2px 6px; cursor:pointer; font-size:13px; line-height:1; opacity:0.7; }
.find-bar button:hover { opacity:1; background:var(--list-hover); }
.find-bar button:disabled { opacity:0.3; cursor:default; }

mark.find-match { background:var(--vscode-editor-findMatchHighlightBackground, rgba(234,200,0,0.35)); color:inherit; border-radius:1px; padding:0; }
mark.find-match.current { background:var(--vscode-editor-findMatchBackground, rgba(255,140,0,0.55)); outline:1px solid var(--vscode-editor-findMatchBorder, rgba(255,140,0,0.9)); }

.diff-viewport { flex:1; display:flex; overflow:hidden; }

/* ── Inline diff ── */
.inline-wrap { flex:1; display:flex; overflow:hidden; position:relative; }
.inline-scroll { flex:1; overflow:auto; scrollbar-width:none; -ms-overflow-style:none; }
.inline-scroll::-webkit-scrollbar { display:none; width:0; height:0; }

.diff-table { width:100%; border-collapse:collapse; font-family:var(--mono); font-size:var(--mono-size); line-height:1.55; table-layout:fixed; }
.diff-table colgroup col.c-ln  { width:44px; }
.diff-table colgroup col.c-ln2 { width:44px; }
.diff-table colgroup col.c-gt  { width:20px; }
.diff-table colgroup col.c-code{ width:auto; }
.diff-table td { padding:0 3px; white-space:pre; vertical-align:top; }
.ln  { color:var(--fg); opacity:0.28; text-align:right; padding-right:10px; user-select:none; font-size:10px; }
.gt  { text-align:center; user-select:none; font-size:12px; width:18px; }
.code{ padding-left:6px; overflow:hidden; text-overflow:ellipsis; tab-size:4; }

tr.add-row { background:var(--add-bg); }
tr.add-row .gt { color:var(--add-fg); }
tr.del-row { background:var(--del-bg); }
tr.del-row .gt { color:var(--del-fg); }
tr.hunk-row td { background:var(--hunk-bg); color:var(--hunk-fg); font-size:10px; padding:2px 10px; }

/* Selection-occurrence highlight (mirrors VS Code's editor.wordHighlightBackground) */
mark.occ { background:var(--vscode-editor-wordHighlightBackground, rgba(255,200,0,0.30)); color:inherit; border-radius:2px; padding:0; }
mark.occ.strong { background:var(--vscode-editor-wordHighlightStrongBackground, rgba(255,200,0,0.45)); }

/* ── SBS diff ── */
.sbs-container { flex:1; display:flex; overflow:hidden; }
.sbs-pane { display:flex; flex-direction:column; overflow:hidden; min-width:80px; position:relative; }
.sbs-pane-label { padding:3px 10px; font-size:10px; opacity:0.45; text-transform:uppercase; letter-spacing:0.07em; border-bottom:1px solid var(--border); flex-shrink:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.sbs-pane-body { flex:1; display:flex; flex-direction:row; overflow:hidden; min-height:0; }
.sbs-scroll { flex:1; overflow:auto; min-width:0; scrollbar-width:none; -ms-overflow-style:none; }
.sbs-scroll::-webkit-scrollbar { display:none; width:0; height:0; }
.sbs-table { width:100%; border-collapse:collapse; font-family:var(--mono); font-size:var(--mono-size); line-height:1.55; table-layout:fixed; }
.sbs-table colgroup col.c-ln   { width:44px; }
.sbs-table colgroup col.c-code { width:auto; }
.sbs-table td { padding:0 3px; white-space:pre; vertical-align:top; tab-size:4; }
.sbs-table .ln   { color:var(--fg); opacity:0.28; text-align:right; padding-right:10px; user-select:none; font-size:10px; }
.sbs-table .code { padding-left:6px; }
tr.sbs-add   { background:var(--add-bg); }
tr.sbs-del   { background:var(--del-bg); }
tr.sbs-empty td { background:rgba(128,128,128,0.04); }
tr.sbs-hunk td  { background:var(--hunk-bg); color:var(--hunk-fg); font-size:10px; padding:2px 10px; }

.sbs-divider { width:5px; background:var(--border); cursor:col-resize; flex-shrink:0; transition:background 0.1s; }
.sbs-divider:hover, .sbs-divider.dragging { background:var(--btn-bg); }

/* ── Scrollbar minimap ── */
.diff-minimap { width:14px; flex-shrink:0; position:relative; background:rgba(128,128,128,0.12); cursor:pointer; border-left:1px solid var(--border); }
.diff-minimap:hover { background:rgba(128,128,128,0.20); }
.diff-minimap canvas { position:absolute; top:0; left:0; width:100%; height:100%; }
.diff-minimap-viewport { position:absolute; left:0; right:0; background:rgba(128,128,128,0.18); border:1px solid rgba(128,128,128,0.35); border-radius:2px; pointer-events:none; box-sizing:border-box; }

/* ── States ── */
.placeholder { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; opacity:0.38; padding:32px; text-align:center; }
.placeholder .ico { font-size:36px; }
.placeholder p { font-size:12px; line-height:1.5; }
.spinner { width:22px; height:22px; border:2px solid var(--border); border-top-color:var(--btn-bg); border-radius:50%; animation:spin 0.65s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
.err { padding:14px; color:var(--del-fg); font-family:var(--mono); font-size:11px; white-space:pre-wrap; }

::-webkit-scrollbar { width:6px; height:6px; }
::-webkit-scrollbar-track { background:transparent; }
::-webkit-scrollbar-thumb { background:rgba(128,128,128,0.28); border-radius:3px; }
::-webkit-scrollbar-thumb:hover { background:rgba(128,128,128,0.5); }
</style>
</head>
<body>

<div class="toolbar">
  <span class="toolbar-title">⎇ WTF Changed</span>
  <div class="branch-group">
    <label>Base</label>
    <select id="baseSelect"></select>
    <button class="icon-btn" id="swapBtn" title="Swap branches">⇄</button>
    <label>Compare</label>
    <select id="compareSelect"></select>
  </div>
  <div class="toolbar-sep"></div>
  <div class="toggle-group">
    <button class="toggle-btn" id="btnChanged">Changed</button>
    <button class="toggle-btn active" id="btnFull">Full file</button>
  </div>
  <div class="toggle-group">
    <button class="toggle-btn" id="btnInline">Inline</button>
    <button class="toggle-btn active" id="btnSbs">Side by side</button>
  </div>
  <div class="toolbar-sep"></div>
  <button class="icon-btn" id="refreshBtn" title="Refresh (also auto-refreshes on save)">↻</button>
  <div class="settings-wrap">
    <button class="icon-btn" id="btnSettings" title="Settings" aria-haspopup="true" aria-expanded="false">⚙</button>
    <div class="popover" id="settingsPopover" role="menu" hidden>
      <div class="popover-section">
        <div class="popover-label">When comparing against the current branch</div>
        <label class="popover-radio">
          <input type="radio" name="wtMode" id="rdWorkTree" value="wt">
          <span class="popover-radio-main">Include working tree</span>
          <span class="popover-radio-sub">Show uncommitted + unstaged changes</span>
        </label>
        <label class="popover-radio">
          <input type="radio" name="wtMode" id="rdCommitted" value="committed">
          <span class="popover-radio-main">Committed only</span>
          <span class="popover-radio-sub">Ignore your working tree</span>
        </label>
        <div class="popover-hint" id="wtPopoverHint"></div>
      </div>
    </div>
  </div>
</div>

<div class="main">
  <div class="sidebar" id="sidebar">
    <div class="sidebar-head">
      <span>Changed files</span>
      <span class="badge" id="fileCount" style="display:none"></span>
    </div>
    <div class="find-bar" id="sidebarFind">
      <input type="text" placeholder="Filter files…" id="sidebarFindInput" />
      <span class="find-count" id="sidebarFindCount"></span>
      <button id="sidebarFindClose" title="Close (Esc)">×</button>
    </div>
    <div class="file-tree" id="fileTree">
      <div class="placeholder"><div class="ico">⎇</div><p>Pick two branches to compare</p></div>
    </div>
    <div class="sidebar-resize" id="sidebarResize"></div>
  </div>

  <div class="diff-area">
    <div class="diff-bar" id="diffBar" style="visibility:hidden">
      <span class="diff-filepath" id="diffFilepath"></span>
      <button class="open-btn" id="openFileBtn">↗ Open file</button>
    </div>
    <div class="find-bar" id="diffFind">
      <input type="text" placeholder="Find in diff…" id="diffFindInput" />
      <span class="find-count" id="diffFindCount"></span>
      <button id="diffFindPrev" title="Previous (Shift+Enter)">↑</button>
      <button id="diffFindNext" title="Next (Enter)">↓</button>
      <button id="diffFindClose" title="Close (Esc)">×</button>
    </div>
    <div class="diff-viewport" id="diffViewport">
      <div class="placeholder"><div class="ico">📄</div><p>Select a file to view its diff</p></div>
    </div>
  </div>
</div>

<script>
(function() {
  const vscode = acquireVsCodeApi();

  let viewMode = 'full', layout = 'sbs';
  let includeWT = true, currentBranch = '';
  let currentBase = '', currentCompare = '', currentFilePath = null, currentDiff = null;
  let activeFileItem = null;
  let allFiles = [];

  const baseSelect   = document.getElementById('baseSelect');
  const compareSelect= document.getElementById('compareSelect');
  const swapBtn      = document.getElementById('swapBtn');
  const fileTree     = document.getElementById('fileTree');
  const fileCount    = document.getElementById('fileCount');
  const diffBar      = document.getElementById('diffBar');
  const diffFilepath = document.getElementById('diffFilepath');
  const diffViewport = document.getElementById('diffViewport');
  const sidebar      = document.getElementById('sidebar');
  const sidebarResize= document.getElementById('sidebarResize');
  const refreshBtn   = document.getElementById('refreshBtn');
  const openFileBtn  = document.getElementById('openFileBtn');

  // ── Messages ───────────────────────────────────────────────────────────────
  window.addEventListener('message', ({ data: msg }) => {
    switch (msg.type) {
      case 'init':  onInit(msg);  break;
      case 'files': onFiles(msg); break;
      case 'diff':  onDiff(msg);  break;
      case 'error': onError(msg); break;
      case 'branchSwitched': onBranchSwitched(msg); break;
    }
  });

  function onBranchSwitched({ branches, base, compare, currentBranch: cb, files }) {
    currentBranch = cb || '';
    if (Array.isArray(branches)) {
      populateSelect(baseSelect,    branches, base);
      populateSelect(compareSelect, branches, compare);
    } else {
      baseSelect.value    = base;
      compareSelect.value = compare;
    }
    currentBase = base; currentCompare = compare;
    updateWTToggleEnabled();
    if (files) {
      // 'follow' case: files arrived alongside the switch — render them with selection preserved
      onFiles({ files, preserveSelection: true });
    }
  }

  function onInit({ branches, base, compare, currentBranch: cb, includeWT: iw }) {
    populateSelect(baseSelect,    branches, base);
    populateSelect(compareSelect, branches, compare);
    currentBase = base; currentCompare = compare;
    currentBranch = cb || '';
    if (typeof iw === 'boolean') {
      includeWT = iw;
    }
    syncWTRadios();
    updateWTToggleEnabled();
    runCompare();
  }

  function syncWTRadios() {
    document.getElementById('rdWorkTree').checked  = includeWT;
    document.getElementById('rdCommitted').checked = !includeWT;
  }

  function updateWTToggleEnabled() {
    const applicable = currentCompare === currentBranch;
    const rdWT = document.getElementById('rdWorkTree');
    const rdC  = document.getElementById('rdCommitted');
    const lblWT = rdWT.closest('.popover-radio');
    const lblC  = rdC.closest('.popover-radio');
    rdWT.disabled = !applicable;
    rdC.disabled  = !applicable;
    lblWT.classList.toggle('disabled', !applicable);
    lblC.classList.toggle('disabled', !applicable);
    document.getElementById('wtPopoverHint').textContent = applicable
      ? ''
      : 'Only applies when comparing against the current branch (' + currentBranch + ').';
  }

  function populateSelect(sel, branches, selected) {
    const prev = sel.value || selected;
    sel.innerHTML = branches.map(b =>
      \`<option value="\${esc(b)}" \${b === prev ? 'selected':''}>\${esc(b)}</option>\`
    ).join('');
    sel.value = branches.includes(prev) ? prev : branches[0];
  }

  // ── Controls ───────────────────────────────────────────────────────────────
  swapBtn.addEventListener('click', () => {
    const t=baseSelect.value; baseSelect.value=compareSelect.value; compareSelect.value=t;
    runCompare();
  });
  baseSelect.addEventListener('change', runCompare);
  compareSelect.addEventListener('change', runCompare);

  refreshBtn.addEventListener('click', () => {
    if (!currentBase) return;
    refreshBtn.classList.add('spin-anim');
    vscode.postMessage({ type: 'refresh' });
    setTimeout(() => refreshBtn.classList.remove('spin-anim'), 700);
  });

  openFileBtn.addEventListener('click', () => {
    if (currentFilePath) vscode.postMessage({ type: 'openFile', filePath: currentFilePath });
  });

  function runCompare() {
    currentBase    = baseSelect.value;
    currentCompare = compareSelect.value;
    currentFilePath = null; activeFileItem = null; allFiles = [];
    fileTree.innerHTML = '<div class="placeholder"><div class="spinner"></div></div>';
    fileCount.style.display = 'none';
    diffBar.style.visibility = 'hidden';
    diffViewport.innerHTML = '<div class="placeholder"><div class="ico">📄</div><p>Select a file to view its diff</p></div>';
    updateWTToggleEnabled();
    vscode.postMessage({ type: 'compare', base: currentBase, compare: currentCompare, includeWT });
  }

  // ── View toggles ───────────────────────────────────────────────────────────
  document.getElementById('btnChanged').addEventListener('click', () => setViewMode('changed'));
  document.getElementById('btnFull').addEventListener('click',    () => setViewMode('full'));
  document.getElementById('btnInline').addEventListener('click',  () => setLayout('inline'));
  document.getElementById('btnSbs').addEventListener('click',     () => setLayout('sbs'));
  document.getElementById('rdWorkTree').addEventListener('change',  () => setIncludeWT(true));
  document.getElementById('rdCommitted').addEventListener('change', () => setIncludeWT(false));

  // Settings popover open/close
  const settingsBtn = document.getElementById('btnSettings');
  const settingsPop = document.getElementById('settingsPopover');
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !settingsPop.hidden;
    settingsPop.hidden = isOpen;
    settingsBtn.setAttribute('aria-expanded', String(!isOpen));
  });
  document.addEventListener('click', (e) => {
    if (settingsPop.hidden) return;
    if (settingsPop.contains(e.target) || settingsBtn.contains(e.target)) return;
    settingsPop.hidden = true;
    settingsBtn.setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !settingsPop.hidden) {
      settingsPop.hidden = true;
      settingsBtn.setAttribute('aria-expanded', 'false');
    }
  });

  function setIncludeWT(v) {
    if (includeWT === v) return;
    includeWT = v;
    syncWTRadios();
    if (currentBase && currentCompare) runCompare();
  }

  function setViewMode(m) {
    viewMode = m;
    document.getElementById('btnChanged').classList.toggle('active', m==='changed');
    document.getElementById('btnFull').classList.toggle('active',    m==='full');
    if (currentDiff) renderCurrentDiff();
  }
  function setLayout(l) {
    layout = l;
    document.getElementById('btnInline').classList.toggle('active', l==='inline');
    document.getElementById('btnSbs').classList.toggle('active',    l==='sbs');
    if (currentDiff) renderCurrentDiff();
  }

  // ── File list ──────────────────────────────────────────────────────────────
  function onFiles({ files, preserveSelection }) {
    allFiles = files || [];
    if (!allFiles.length) {
      fileTree.innerHTML = '<div class="placeholder"><div class="ico">✓</div><p>No differences between these branches</p></div>';
      fileCount.style.display = 'none';
      return;
    }
    fileCount.textContent = allFiles.length;
    fileCount.style.display = '';
    renderTree(allFiles, preserveSelection);
  }

  // ── Tree rendering ─────────────────────────────────────────────────────────
  function renderTree(files, preserveSelection) {
    const prevPath = currentFilePath;
    // Build folder structure
    const root = {}; // { children: {}, files: [] }
    files.forEach(f => {
      const parts = f.path.split('/');
      const fname = parts.pop();
      let node = root;
      parts.forEach(seg => {
        if (!node[seg]) node[seg] = { _files: [], _open: true };
        node = node[seg];
      });
      if (!node._files) node._files = [];
      node._files.push({ ...f, fname });
    });

    fileTree.innerHTML = '';
    activeFileItem = null;

    function renderNode(node, container, depth) {
      // files at this level
      if (node._files) {
        node._files.forEach(f => {
          const item = document.createElement('div');
          item.className = 'file-item';
          item.style.paddingLeft = (8 + depth * 16) + 'px';
          const st = (f.status || 'M').charAt(0).toUpperCase();
          item.innerHTML =
            \`<span class="fstatus s-\${st}">\${st}</span>\` +
            \`<span class="fname">\${esc(f.fname)}</span>\`;
          item.title = f.path;
          item.dataset.path = f.path;
          item.addEventListener('click', () => selectFile(item, f.path));
          container.appendChild(item);
          if (preserveSelection && f.path === prevPath) {
            // re-select silently
            item.classList.add('active');
            activeFileItem = item;
          }
        });
      }
      // sub-folders
      Object.keys(node).filter(k => k !== '_files' && k !== '_open').sort().forEach(seg => {
        const child = node[seg];
        const folder = document.createElement('div');
        folder.className = 'tree-folder';
        folder.style.paddingLeft = (8 + depth * 16) + 'px';
        const isOpen = child._open !== false;
        folder.innerHTML =
          \`<span class="tree-folder-icon \${isOpen ? 'open' : ''}">›</span>\` +
          \`<span class="tree-folder-name">\${esc(seg)}</span>\` +
          \`<span class="tree-folder-badge">\${countFiles(child)}</span>\`;
        container.appendChild(folder);

        const childContainer = document.createElement('div');
        childContainer.className = 'tree-children' + (isOpen ? ' open' : '');
        container.appendChild(childContainer);

        renderNode(child, childContainer, depth + 1);

        folder.addEventListener('click', () => {
          child._open = !child._open;
          folder.querySelector('.tree-folder-icon').classList.toggle('open', child._open);
          childContainer.classList.toggle('open', child._open);
        });
      });
    }

    renderNode(root, fileTree, 0);

    // auto-select: re-select previous file if preserving, else select first
    if (!preserveSelection || !prevPath) {
      const first = fileTree.querySelector('.file-item');
      if (first) first.click();
    }
  }

  function countFiles(node) {
    let n = (node._files || []).length;
    Object.keys(node).filter(k => k !== '_files' && k !== '_open').forEach(k => n += countFiles(node[k]));
    return n;
  }

  // ── File selection ─────────────────────────────────────────────────────────
  function selectFile(item, filePath) {
    if (activeFileItem) activeFileItem.classList.remove('active');
    item.classList.add('active');
    activeFileItem = item;
    currentFilePath = filePath;
    currentDiff = null;

    diffBar.style.visibility = 'visible';
    diffFilepath.textContent = filePath;
    diffViewport.innerHTML = '<div class="placeholder"><div class="spinner"></div></div>';

    vscode.postMessage({ type:'diff', base:currentBase, compare:currentCompare, filePath, includeWT });
  }

  function onDiff({ diff, silent }) {
    currentDiff = diff;
    renderCurrentDiff(silent);
  }

  function onError({ message }) {
    fileTree.innerHTML = \`<div class="err">\${esc(message)}</div>\`;
    diffViewport.innerHTML = \`<div class="err">\${esc(message)}</div>\`;
  }

  // ── Render dispatcher ──────────────────────────────────────────────────────
  function renderCurrentDiff(silent) {
    if (!currentDiff) return;
    diffViewport.innerHTML = '';
    if (layout === 'inline') renderInline(currentDiff, silent);
    else                     renderSbs(currentDiff, silent);
  }

  // ── Inline ─────────────────────────────────────────────────────────────────
  function renderInline(diff, silent) {
    const rows = viewMode === 'full' ? buildFullInlineRows(diff) : buildChangedInlineRows(diff);
    if (!rows.length) { diffViewport.innerHTML = noChanges(); return; }

    const wrap   = document.createElement('div'); wrap.className = 'inline-wrap';
    const scroll = document.createElement('div'); scroll.className = 'inline-scroll';
    const table  = mkTable(['c-ln','c-ln2','c-gt','c-code']);
    const tbody  = document.createElement('tbody');

    let firstChangedRow = null;
    const changePositions = []; // fractional 0-1

    rows.forEach((row, i) => {
      const tr = document.createElement('tr');
      if (row.isHunk) { tr.className='hunk-row'; tr.innerHTML='<td colspan="4">'+esc(row.content)+'</td>'; }
      else {
        if (row.type==='add')    { tr.className='add-row'; }
        if (row.type==='remove') { tr.className='del-row'; }
        const gt = row.type==='add' ? '+' : row.type==='remove' ? '−' : '';
        tr.innerHTML =
          '<td class="ln">'+(row.oldNo??'')+'</td>'+
          '<td class="ln">'+(row.newNo??'')+'</td>'+
          '<td class="gt">'+gt+'</td>'+
          '<td class="code">'+esc(row.content)+'</td>';
        if ((row.type==='add'||row.type==='remove') && !firstChangedRow) firstChangedRow = tr;
        if (row.type==='add'||row.type==='remove') changePositions.push(i / rows.length);
      }
      tbody.appendChild(tr);
    });

    table.appendChild(tbody); scroll.appendChild(table); wrap.appendChild(scroll);
    const minimap = mkMinimap(scroll, changePositions);
    wrap.appendChild(minimap);
    diffViewport.appendChild(wrap);

    if (!silent && firstChangedRow) requestAnimationFrame(() => firstChangedRow.scrollIntoView({ block:'center' }));
  }

  function buildChangedInlineRows(diff) {
    const { lines } = diff;
    const rows = [];
    lines.forEach(l => {
      if (l.oldLineNo===null && l.newLineNo===null) { rows.push({ isHunk:true, content:l.content }); return; }
      if (l.type !== 'context') rows.push({ type:l.type, oldNo:l.oldLineNo, newNo:l.newLineNo, content:l.content });
    });
    return rows;
  }

  function buildFullInlineRows(diff) {
    const { lines, compareLines } = diff;
    const rows = [];
    let prevNewLine = 0;
    const chunks = groupHunks(lines);

    for (const chunk of chunks) {
      // fill gap
      if (chunk.firstNew !== null) {
        for (let n = prevNewLine+1; n < chunk.firstNew; n++)
          rows.push({ type:'context', oldNo:null, newNo:n, content: compareLines[n-1]??'' });
      }
      chunk.lines.forEach(l => {
        if (l.oldLineNo===null && l.newLineNo===null) return; // skip hunk header in full mode
        rows.push({ type:l.type, oldNo:l.oldLineNo, newNo:l.newLineNo, content:l.content });
        if (l.newLineNo!==null) prevNewLine = l.newLineNo;
      });
    }
    for (let n = prevNewLine+1; n <= compareLines.length; n++)
      rows.push({ type:'context', oldNo:null, newNo:n, content: compareLines[n-1]??'' });

    return rows;
  }

  // ── Side-by-side ───────────────────────────────────────────────────────────
  function renderSbs(diff, silent) {
    const pairs = viewMode === 'full' ? buildSbsFullRows(diff) : buildSbsChangedRows(diff);
    if (!pairs.length) { diffViewport.innerHTML = noChanges(); return; }

    const container = document.createElement('div'); container.className = 'sbs-container';
    const leftPane  = mkSbsPane(currentBase);
    const divider   = document.createElement('div'); divider.className = 'sbs-divider';
    const rightPane = mkSbsPane(currentCompare);
    leftPane.style.flex = '1 1 50%'; rightPane.style.flex = '1 1 50%';

    container.appendChild(leftPane); container.appendChild(divider); container.appendChild(rightPane);
    diffViewport.appendChild(container);

    const leftTbody  = buildSbsTableBody(leftPane);
    const rightTbody = buildSbsTableBody(rightPane);

    let firstChangedIdx = null;
    const changePositions = [];

    pairs.forEach((pair, i) => {
      leftTbody.appendChild(mkSbsRow(pair.left));
      rightTbody.appendChild(mkSbsRow(pair.right));
      const isChanged = (pair.left && (pair.left.type==='remove'||pair.left.type==='add'))
                     || (pair.right && (pair.right.type==='add'||pair.right.type==='remove'));
      if (isChanged) {
        if (firstChangedIdx===null) firstChangedIdx = i;
        changePositions.push(i / pairs.length);
      }
    });

    const ls = leftPane.querySelector('.sbs-scroll');
    const rs = rightPane.querySelector('.sbs-scroll');

    // append minimaps
    const lm = mkMinimap(ls, changePositions);
    const rm = mkMinimap(rs, changePositions);
    leftPane.appendChild(lm); rightPane.appendChild(rm);

    // sync scroll
    let syncing = false;
    ls.addEventListener('scroll', () => { if (!syncing) { syncing=true; rs.scrollTop=ls.scrollTop; syncing=false; } });
    rs.addEventListener('scroll', () => { if (!syncing) { syncing=true; ls.scrollTop=rs.scrollTop; syncing=false; } });

    // scroll to first change
    if (!silent && firstChangedIdx !== null) {
      requestAnimationFrame(() => {
        const rows = leftTbody.querySelectorAll('tr');
        if (rows[firstChangedIdx]) rows[firstChangedIdx].scrollIntoView({ block:'center' });
      });
    }

    makeDraggable(divider, leftPane, rightPane, container);
  }

  function buildSbsChangedRows(diff) {
    const { lines } = diff;
    const pairs = [];
    let buf = [];
    lines.forEach(l => {
      if (l.oldLineNo===null && l.newLineNo===null) {
        while (buf.length) { const r=buf.shift(); pairs.push({ left:{type:'remove',lineNo:r.oldLineNo,content:r.content}, right:null }); }
        pairs.push({ left:{isHunk:true,content:l.content}, right:{isHunk:true,content:l.content} });
        return;
      }
      if (l.type==='remove') { buf.push(l); }
      else if (l.type==='add') {
        const rem = buf.shift();
        pairs.push({ left: rem?{type:'remove',lineNo:rem.oldLineNo,content:rem.content}:null, right:{type:'add',lineNo:l.newLineNo,content:l.content} });
      }
    });
    while (buf.length) { const r=buf.shift(); pairs.push({ left:{type:'remove',lineNo:r.oldLineNo,content:r.content}, right:null }); }
    return pairs;
  }

  function buildSbsFullRows(diff) {
    const { lines, baseLines, compareLines } = diff;
    const pairs = [];
    let prevNewLine=0, prevOldLine=0;
    const chunks = groupHunks(lines);

    for (const chunk of chunks) {
      if (chunk.firstNew!==null && chunk.firstOld!==null) {
        const gapLen = chunk.firstNew - 1 - prevNewLine;
        for (let i=0; i<gapLen; i++) {
          const newNo = prevNewLine+1+i, oldNo = prevOldLine+1+i;
          pairs.push({ left:{type:'context',lineNo:oldNo,content:baseLines[oldNo-1]??''}, right:{type:'context',lineNo:newNo,content:compareLines[newNo-1]??''} });
        }
        prevNewLine = chunk.firstNew-1; prevOldLine = chunk.firstOld-1;
      }

      const buf = [];
      chunk.lines.forEach(l => {
        if (l.oldLineNo===null && l.newLineNo===null) return;
        if (l.type==='remove') { buf.push(l); }
        else if (l.type==='add') {
          const rem = buf.shift();
          pairs.push({ left: rem?{type:'remove',lineNo:rem.oldLineNo,content:rem.content}:null, right:{type:'add',lineNo:l.newLineNo,content:l.content} });
          if (l.newLineNo!==null) prevNewLine=l.newLineNo;
          if (rem && rem.oldLineNo!==null) prevOldLine=rem.oldLineNo;
        } else {
          while (buf.length) { const r=buf.shift(); pairs.push({ left:{type:'remove',lineNo:r.oldLineNo,content:r.content}, right:null }); if(r.oldLineNo!==null) prevOldLine=r.oldLineNo; }
          pairs.push({ left:{type:'context',lineNo:l.oldLineNo,content:l.content}, right:{type:'context',lineNo:l.newLineNo,content:l.content} });
          if (l.newLineNo!==null) prevNewLine=l.newLineNo;
          if (l.oldLineNo!==null) prevOldLine=l.oldLineNo;
        }
      });
      while (buf.length) { const r=buf.shift(); pairs.push({ left:{type:'remove',lineNo:r.oldLineNo,content:r.content}, right:null }); if(r.oldLineNo!==null) prevOldLine=r.oldLineNo; }
    }

    const tailLen = compareLines.length - prevNewLine;
    for (let i=0; i<tailLen; i++) {
      const newNo=prevNewLine+1+i, oldNo=prevOldLine+1+i;
      pairs.push({ left:{type:'context',lineNo:oldNo,content:baseLines[oldNo-1]??''}, right:{type:'context',lineNo:newNo,content:compareLines[newNo-1]??''} });
    }
    return pairs;
  }

  function mkSbsPane(label) {
    const pane = document.createElement('div'); pane.className='sbs-pane';
    const lbl  = document.createElement('div'); lbl.className='sbs-pane-label'; lbl.textContent=label; pane.appendChild(lbl);
    const body = document.createElement('div'); body.className='sbs-pane-body'; pane.appendChild(body);
    const scroll = document.createElement('div'); scroll.className='sbs-scroll'; body.appendChild(scroll);
    return pane;
  }

  function buildSbsTableBody(pane) {
    const scroll = pane.querySelector('.sbs-scroll');
    const table  = document.createElement('table'); table.className='sbs-table';
    const cg = document.createElement('colgroup'); cg.innerHTML='<col class="c-ln"><col class="c-code">'; table.appendChild(cg);
    const tbody = document.createElement('tbody'); table.appendChild(tbody); scroll.appendChild(table);
    return tbody;
  }

  function mkSbsRow(cell) {
    const tr = document.createElement('tr');
    if (!cell) { tr.className='sbs-empty'; tr.innerHTML='<td class="ln"></td><td class="code"> </td>'; return tr; }
    if (cell.isHunk) { tr.className='sbs-hunk'; tr.innerHTML='<td colspan="2">'+esc(cell.content)+'</td>'; return tr; }
    if (cell.type==='add')    tr.className='sbs-add';
    if (cell.type==='remove') tr.className='sbs-del';
    tr.innerHTML='<td class="ln">'+(cell.lineNo??'')+'</td><td class="code">'+esc(cell.content)+'</td>';
    return tr;
  }

  // ── Scrollbar minimap ──────────────────────────────────────────────────────
  // changePositions: array of 0..1 fractions indicating where changes are
  function mkMinimap(scrollEl, changePositions) {
    const wrap = document.createElement('div'); wrap.className='diff-minimap';
    const canvas = document.createElement('canvas'); wrap.appendChild(canvas);

    function paint() {
      const h = wrap.clientHeight || 200;
      const w = wrap.clientWidth  || 10;
      canvas.width  = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0,0,w,h);
      changePositions.forEach(pos => {
        const y = Math.round(pos * h);
        // colour: we don't know add vs remove here so use a neutral accent
        ctx.fillStyle = 'rgba(200,140,30,0.7)';
        ctx.fillRect(1, y, w-2, Math.max(2, Math.round(h/changePositions.length * 0.6)));
      });
    }

    // Separate add/remove positions for proper colouring
    // Override: pass {adds, removes} instead of flat array when available
    if (changePositions && changePositions._adds) {
      // typed minimap
    }

    requestAnimationFrame(paint);
    new ResizeObserver(paint).observe(wrap);

    // click on minimap to jump
    wrap.addEventListener('click', e => {
      const frac = e.offsetY / wrap.clientHeight;
      const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
      scrollEl.scrollTop = frac * maxScroll;
    });

    return wrap;
  }

  // Better minimap that gets called with typed positions
  function mkMinimapTyped(scrollEl, addPositions, removePositions, totalRows) {
    const wrap = document.createElement('div'); wrap.className='diff-minimap';
    const canvas = document.createElement('canvas'); wrap.appendChild(canvas);
    const viewport = document.createElement('div'); viewport.className='diff-minimap-viewport';
    wrap.appendChild(viewport);

    function paint() {
      const h = wrap.clientHeight || 200;
      const w = wrap.clientWidth  || 14;
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0,0,w,h);
      // Bars span the full minimap width (minus 1px border on each side), thick enough to be obvious.
      const barH = Math.max(3, Math.min(8, Math.round(h / Math.max(totalRows, 1) * 2)));
      removePositions.forEach(pos => {
        ctx.fillStyle = 'rgba(218,54,51,0.85)';
        ctx.fillRect(1, Math.round(pos*h), w-2, barH);
      });
      addPositions.forEach(pos => {
        ctx.fillStyle = 'rgba(70,149,74,0.85)';
        ctx.fillRect(1, Math.round(pos*h), w-2, barH);
      });
    }

    function paintViewport() {
      const scrollH = scrollEl.scrollHeight;
      const clientH = scrollEl.clientHeight;
      if (scrollH <= clientH) { viewport.style.display='none'; return; }
      viewport.style.display='';
      const h = wrap.clientHeight || 200;
      const top = (scrollEl.scrollTop / scrollH) * h;
      const height = Math.max(20, (clientH / scrollH) * h);
      viewport.style.top = top + 'px';
      viewport.style.height = height + 'px';
    }

    requestAnimationFrame(() => { paint(); paintViewport(); });
    new ResizeObserver(() => { paint(); paintViewport(); }).observe(wrap);
    scrollEl.addEventListener('scroll', paintViewport);

    // Click jumps; drag scrubs.
    function jumpTo(clientY) {
      const rect = wrap.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
      const max = scrollEl.scrollHeight - scrollEl.clientHeight;
      scrollEl.scrollTop = frac * max;
    }
    wrap.addEventListener('mousedown', e => {
      jumpTo(e.clientY);
      const onMove = (ev) => jumpTo(ev.clientY);
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
    return wrap;
  }

  // Rebuild inline with typed minimap
  function renderInlineFull2(diff, silent) {
    const rows = buildFullInlineRows(diff);
    if (!rows.length) { diffViewport.innerHTML = noChanges(); return; }

    const wrap   = document.createElement('div'); wrap.className='inline-wrap';
    const scroll = document.createElement('div'); scroll.className='inline-scroll';
    const table  = mkTable(['c-ln','c-ln2','c-gt','c-code']);
    const tbody  = document.createElement('tbody');

    let firstChangedRow = null;
    const addPos=[], removePos=[];

    rows.forEach((row, i) => {
      const tr = document.createElement('tr');
      if (row.isHunk) { tr.className='hunk-row'; tr.innerHTML='<td colspan="4">'+esc(row.content)+'</td>'; }
      else {
        if (row.type==='add')    { tr.className='add-row';    addPos.push(i/rows.length); }
        if (row.type==='remove') { tr.className='del-row'; removePos.push(i/rows.length); }
        const gt = row.type==='add'?'+':row.type==='remove'?'−':'';
        tr.innerHTML='<td class="ln">'+(row.oldNo??'')+'</td><td class="ln">'+(row.newNo??'')+'</td><td class="gt">'+gt+'</td><td class="code">'+esc(row.content)+'</td>';
        if ((row.type==='add'||row.type==='remove') && !firstChangedRow) firstChangedRow=tr;
      }
      tbody.appendChild(tr);
    });

    table.appendChild(tbody); scroll.appendChild(table); wrap.appendChild(scroll);
    wrap.appendChild(mkMinimapTyped(scroll, addPos, removePos, rows.length));
    diffViewport.appendChild(wrap);
    if (!silent && firstChangedRow) requestAnimationFrame(() => firstChangedRow.scrollIntoView({ block:'center' }));
  }

  // Patch renderInline to use the typed minimap version
  function renderInline(diff, silent) {
    renderInlineFull2(diff, silent);
  }

  // Patch renderSbs to use typed minimap
  function renderSbs(diff, silent) {
    const pairs = viewMode==='full' ? buildSbsFullRows(diff) : buildSbsChangedRows(diff);
    if (!pairs.length) { diffViewport.innerHTML = noChanges(); return; }

    const container = document.createElement('div'); container.className='sbs-container';
    const leftPane  = mkSbsPane(currentBase);
    const divider   = document.createElement('div'); divider.className='sbs-divider';
    const rightPane = mkSbsPane(currentCompare);
    leftPane.style.flex='1 1 50%'; rightPane.style.flex='1 1 50%';
    container.appendChild(leftPane); container.appendChild(divider); container.appendChild(rightPane);
    diffViewport.appendChild(container);

    const leftTbody  = buildSbsTableBody(leftPane);
    const rightTbody = buildSbsTableBody(rightPane);

    let firstChangedIdx = null;
    const addPos=[], removePos=[];

    pairs.forEach((pair, i) => {
      leftTbody.appendChild(mkSbsRow(pair.left));
      rightTbody.appendChild(mkSbsRow(pair.right));
      if (pair.left?.type==='remove')  { removePos.push(i/pairs.length); if(firstChangedIdx===null) firstChangedIdx=i; }
      if (pair.right?.type==='add')    { addPos.push(i/pairs.length);    if(firstChangedIdx===null) firstChangedIdx=i; }
    });

    const ls = leftPane.querySelector('.sbs-scroll');
    const rs = rightPane.querySelector('.sbs-scroll');

    leftPane.querySelector('.sbs-pane-body').appendChild(mkMinimapTyped(ls, [], removePos, pairs.length));
    rightPane.querySelector('.sbs-pane-body').appendChild(mkMinimapTyped(rs, addPos, [], pairs.length));

    let syncing=false;
    ls.addEventListener('scroll', ()=>{ if(!syncing){syncing=true;rs.scrollTop=ls.scrollTop;syncing=false;} });
    rs.addEventListener('scroll', ()=>{ if(!syncing){syncing=true;ls.scrollTop=rs.scrollTop;syncing=false;} });

    if (!silent && firstChangedIdx!==null) {
      requestAnimationFrame(() => {
        const rows=leftTbody.querySelectorAll('tr');
        if(rows[firstChangedIdx]) rows[firstChangedIdx].scrollIntoView({ block:'center' });
      });
    }

    makeDraggable(divider, leftPane, rightPane, container);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function groupHunks(lines) {
    const chunks=[]; let cur=null;
    lines.forEach(l => {
      if (l.oldLineNo===null && l.newLineNo===null) { cur={type:'hunk',lines:[l],firstOld:null,firstNew:null}; chunks.push(cur); }
      else {
        if (!cur) { cur={type:'hunk',lines:[],firstOld:null,firstNew:null}; chunks.push(cur); }
        if (cur.firstNew===null && l.newLineNo!==null) cur.firstNew=l.newLineNo;
        if (cur.firstOld===null && l.oldLineNo!==null) cur.firstOld=l.oldLineNo;
        cur.lines.push(l);
      }
    });
    return chunks;
  }

  function mkTable(cols) {
    const t=document.createElement('table'); t.className='diff-table';
    const cg=document.createElement('colgroup'); cg.innerHTML=cols.map(c=>'<col class="'+c+'">').join(''); t.appendChild(cg);
    return t;
  }

  function makeDraggable(divider, leftPane, rightPane, container) {
    let startX, startLeftW, totalW;
    divider.addEventListener('mousedown', e => {
      startX=e.clientX; startLeftW=leftPane.getBoundingClientRect().width;
      totalW=container.getBoundingClientRect().width - divider.offsetWidth;
      divider.classList.add('dragging');
      document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
    function onMove(e) { const nl=Math.max(80,Math.min(totalW-80,startLeftW+e.clientX-startX)); leftPane.style.flex='0 0 '+nl+'px'; rightPane.style.flex='0 0 '+(totalW-nl)+'px'; }
    function onUp()  { divider.classList.remove('dragging'); document.removeEventListener('mousemove',onMove); document.removeEventListener('mouseup',onUp); }
  }

  // ── Occurrence highlight on double-click ───────────────────────────────────
  // Mirrors VS Code editor behaviour: double-click a word, all other occurrences light up.
  // Single-drag selection is left alone so users can mouse-highlight while reading.
  (function occurrenceHighlight() {
    let activeMarks = [];
    let lastTerm = null;

    function clearMarks() {
      if (!activeMarks.length) { lastTerm = null; return; }
      for (const m of activeMarks) {
        const parent = m.parentNode;
        if (!parent) continue;
        parent.replaceChild(document.createTextNode(m.textContent), m);
        parent.normalize();
      }
      activeMarks = [];
      lastTerm = null;
    }

    function highlight(term, skipNode) {
      if (term === lastTerm) return;
      clearMarks();
      lastTerm = term;
      if (!term) return;

      const walker = document.createTreeWalker(diffViewport, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (node === skipNode) return NodeFilter.FILTER_REJECT;
          let p = node.parentNode;
          while (p && p !== diffViewport) {
            if (p.classList && p.classList.contains('code')) return NodeFilter.FILTER_ACCEPT;
            p = p.parentNode;
          }
          return NodeFilter.FILTER_REJECT;
        }
      });

      const toProcess = [];
      let n;
      while ((n = walker.nextNode())) toProcess.push(n);

      for (const textNode of toProcess) {
        const text = textNode.nodeValue;
        if (!text || text.indexOf(term) === -1) continue;
        const frag = document.createDocumentFragment();
        let i = 0;
        let idx;
        while ((idx = text.indexOf(term, i)) !== -1) {
          if (idx > i) frag.appendChild(document.createTextNode(text.slice(i, idx)));
          const mark = document.createElement('mark');
          mark.className = 'occ';
          mark.textContent = term;
          frag.appendChild(mark);
          activeMarks.push(mark);
          i = idx + term.length;
        }
        if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)));
        textNode.parentNode.replaceChild(frag, textNode);
      }
    }

    // Double-click: browser auto-selects the word under the cursor.
    diffViewport.addEventListener('dblclick', () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const term = sel.toString();
      if (!term || term.length < 2 || term.length > 200) return;
      if (term.indexOf('\\n') !== -1) return;
      if (!diffViewport.contains(sel.anchorNode) || !diffViewport.contains(sel.focusNode)) return;
      // Skip the text node that contains the current selection so the native selection
      // highlight isn't fighting with our <mark> on the same chars.
      const skip = sel.anchorNode && sel.anchorNode.nodeType === Node.TEXT_NODE ? sel.anchorNode : null;
      highlight(term, skip);
    });

    // Clicking anywhere in the diff (single click) clears highlights, so reading-selection
    // doesn't get cluttered. Escape also clears.
    diffViewport.addEventListener('mousedown', (e) => {
      if (e.detail >= 2) return; // part of a double-click — leave it
      clearMarks();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') clearMarks();
    });
    // Find widget asks us to step aside when it activates.
    document.addEventListener('wtf:find-opened', clearMarks);

    // Reset tracking when the diff is re-rendered.
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const removed of m.removedNodes) {
          if (activeMarks.length && (removed === diffViewport || (removed.contains && activeMarks.some(mk => removed.contains(mk))))) {
            activeMarks = [];
            lastTerm = null;
            return;
          }
        }
      }
    }).observe(diffViewport, { childList: true, subtree: true });
  })();

  (function sidebarDrag() {
    let startX, startW;
    sidebarResize.addEventListener('mousedown', e => {
      startX=e.clientX; startW=sidebar.getBoundingClientRect().width;
      sidebarResize.classList.add('dragging');
      document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp); e.preventDefault();
    });
    function onMove(e) { sidebar.style.width=Math.max(140,Math.min(520,startW+e.clientX-startX))+'px'; }
    function onUp()    { sidebarResize.classList.remove('dragging'); document.removeEventListener('mousemove',onMove); document.removeEventListener('mouseup',onUp); }
  })();

  // ── Find (Ctrl+F) ──────────────────────────────────────────────────────────
  (function find() {
    const diffBar     = document.getElementById('diffFind');
    const diffInput   = document.getElementById('diffFindInput');
    const diffCount   = document.getElementById('diffFindCount');
    const diffPrev    = document.getElementById('diffFindPrev');
    const diffNext    = document.getElementById('diffFindNext');
    const diffClose   = document.getElementById('diffFindClose');

    const sideBar     = document.getElementById('sidebarFind');
    const sideInput   = document.getElementById('sidebarFindInput');
    const sideCount   = document.getElementById('sidebarFindCount');
    const sideClose   = document.getElementById('sidebarFindClose');

    let diffMarks = [];      // <mark> nodes in the diff
    let diffIndex = -1;      // current match index
    let sideFilter = '';

    function clearDiffMarks() {
      for (const m of diffMarks) {
        const p = m.parentNode; if (!p) continue;
        p.replaceChild(document.createTextNode(m.textContent), m);
        p.normalize();
      }
      diffMarks = [];
      diffIndex = -1;
    }

    function searchDiff(term) {
      clearDiffMarks();
      if (!term) { updateDiffCount(); return; }
      const lo = term.toLowerCase();
      const walker = document.createTreeWalker(diffViewport, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          let p = node.parentNode;
          while (p && p !== diffViewport) {
            if (p.classList && p.classList.contains('code')) return NodeFilter.FILTER_ACCEPT;
            p = p.parentNode;
          }
          return NodeFilter.FILTER_REJECT;
        }
      });
      const nodes = [];
      let n; while ((n = walker.nextNode())) nodes.push(n);
      for (const textNode of nodes) {
        const text = textNode.nodeValue;
        if (!text) continue;
        const lowerText = text.toLowerCase();
        if (lowerText.indexOf(lo) === -1) continue;
        const frag = document.createDocumentFragment();
        let i = 0, idx;
        while ((idx = lowerText.indexOf(lo, i)) !== -1) {
          if (idx > i) frag.appendChild(document.createTextNode(text.slice(i, idx)));
          const mark = document.createElement('mark');
          mark.className = 'find-match';
          mark.textContent = text.slice(idx, idx + lo.length);
          frag.appendChild(mark);
          diffMarks.push(mark);
          i = idx + lo.length;
        }
        if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)));
        textNode.parentNode.replaceChild(frag, textNode);
      }
      if (diffMarks.length) { diffIndex = 0; setCurrent(); }
      updateDiffCount();
    }

    function setCurrent() {
      diffMarks.forEach((m, i) => m.classList.toggle('current', i === diffIndex));
      const cur = diffMarks[diffIndex];
      if (cur) cur.scrollIntoView({ block:'center', inline:'nearest' });
    }

    function updateDiffCount() {
      if (!diffMarks.length) {
        diffCount.textContent = diffInput.value ? 'No results' : '';
        diffCount.classList.toggle('no-match', !!diffInput.value);
        diffPrev.disabled = diffNext.disabled = true;
      } else {
        diffCount.textContent = (diffIndex + 1) + ' / ' + diffMarks.length;
        diffCount.classList.remove('no-match');
        diffPrev.disabled = diffNext.disabled = false;
      }
    }

    function openDiff() {
      document.dispatchEvent(new CustomEvent('wtf:find-opened'));
      diffBar.classList.add('open');
      diffInput.focus();
      diffInput.select();
      if (diffInput.value) searchDiff(diffInput.value);
    }
    function closeDiff() {
      diffBar.classList.remove('open');
      clearDiffMarks();
      updateDiffCount();
    }

    function openSide() {
      sideBar.classList.add('open');
      sideInput.focus();
      sideInput.select();
    }
    function closeSide() {
      sideBar.classList.remove('open');
      sideInput.value = '';
      sideFilter = '';
      applySideFilter();
    }

    function applySideFilter() {
      const term = sideFilter.toLowerCase();
      if (!term) {
        renderTree(allFiles, true);
        sideCount.textContent = '';
        return;
      }
      const filtered = allFiles.filter(f => f.path.toLowerCase().indexOf(term) !== -1);
      sideCount.textContent = filtered.length + ' / ' + allFiles.length;
      if (filtered.length) {
        renderTree(filtered, true);
      } else {
        fileTree.innerHTML = '<div class="placeholder"><div class="ico">∅</div><p>No matching files</p></div>';
      }
    }

    // Wire events
    diffInput.addEventListener('input', () => searchDiff(diffInput.value));
    diffInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) prev(); else next(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeDiff(); }
    });
    diffPrev.addEventListener('click', prev);
    diffNext.addEventListener('click', next);
    diffClose.addEventListener('click', closeDiff);

    sideInput.addEventListener('input', () => { sideFilter = sideInput.value; applySideFilter(); });
    sideInput.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); closeSide(); }
    });
    sideClose.addEventListener('click', closeSide);

    function next() {
      if (!diffMarks.length) return;
      diffIndex = (diffIndex + 1) % diffMarks.length;
      setCurrent(); updateDiffCount();
    }
    function prev() {
      if (!diffMarks.length) return;
      diffIndex = (diffIndex - 1 + diffMarks.length) % diffMarks.length;
      setCurrent(); updateDiffCount();
    }

    // Track which area the user last interacted with. The sidebar's file rows aren't
    // focusable, so checking document.activeElement alone misses "I just clicked a file,
    // now I want to filter the list". A pointermove on the sidebar also counts as intent.
    let lastArea = 'diff';
    sidebar.addEventListener('mousedown',  () => { lastArea = 'sidebar'; });
    sidebar.addEventListener('mouseenter', () => { lastArea = 'sidebar'; });
    diffViewport.addEventListener('mousedown',  () => { lastArea = 'diff'; });
    diffViewport.addEventListener('mouseenter', () => { lastArea = 'diff'; });

    // Ctrl+F handler — open whichever find matches the current intent
    document.addEventListener('keydown', e => {
      const isFindKey = (e.key === 'f' || e.key === 'F') && (e.ctrlKey || e.metaKey);
      if (!isFindKey) return;
      e.preventDefault();
      // Focus wins if it's inside one of the two areas; otherwise fall back to lastArea.
      const ae = document.activeElement;
      let scope;
      if (sidebar.contains(ae))           scope = 'sidebar';
      else if (diffViewport.contains(ae)) scope = 'diff';
      else                                scope = lastArea;
      if (scope === 'sidebar') openSide();
      else                     openDiff();
    });

    // When the diff is re-rendered, drop our tracking (the marks were detached anyway).
    new MutationObserver((mutations) => {
      if (!diffMarks.length) return;
      for (const m of mutations) {
        for (const removed of m.removedNodes) {
          if (removed === diffViewport || (removed.contains && diffMarks.some(mk => removed.contains(mk)))) {
            diffMarks = [];
            diffIndex = -1;
            // Re-run search on the new content if find is open.
            if (diffBar.classList.contains('open') && diffInput.value) {
              requestAnimationFrame(() => searchDiff(diffInput.value));
            } else {
              updateDiffCount();
            }
            return;
          }
        }
      }
    }).observe(diffViewport, { childList: true, subtree: true });
  })();

  function noChanges() { return '<div class="placeholder"><div class="ico">✓</div><p>No textual diff</p></div>'; }

  function esc(s) {
    return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
})();
</script>
</body>
</html>`;
}
