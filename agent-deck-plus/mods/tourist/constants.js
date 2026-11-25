// Fixed lists and tables Tourist reads from. No state lives here.

export const SCOPES = [
  { key: "b", id: "branch", label: "分支改动", hint: "从本分支离开基点以来的改动，加上未提交的编辑" },
  { key: "c", id: "commit", label: "最后一次提交", hint: "仅 HEAD" },
  { key: "p", id: "pr", label: "拉取请求", hint: "选一个打开的 PR 做引导式评审" },
  { key: "r", id: "repo", label: "整个仓库", hint: "较慢，agent 会通览代码库" },
  { key: "f", id: "feature", label: "某个功能", hint: "描述它，agent 去找代码" },
  { key: "n", id: "requirement", label: "某个需求", hint: "选一个 prism 需求，看它横跨的各工程分支、提交和 diff" },
];
export const DEPTHS = [
  { key: "1", id: "overview", label: "概览", text: "用非常简单的说法，面向刚接触这段代码的人。每个站点 1 到 2 句短句：这部分做什么、为什么在这里。不用行话，不提函数名。" },
  { key: "2", id: "normal", label: "常规", text: "用简单的说法和短句。每个站点 2 到 3 句：这段代码做什么，以及它和上一个站点怎么接上。只在读者需要跟上时才提函数名。读者可以要求更多细节。" },
  { key: "3", id: "deep", label: "深入", text: "偏技术。讲清机制、数据流、边界情况和取舍。每个站点最多 10 句。" },
];
// The re-review step, shown for a PR you reviewed before at an older head.
export const PASSES = [
  { key: "s", id: "since", label: "你上次评审以来的改动" },
  { key: "w", id: "whole", label: "整个 PR", hint: "全部改动，与首次评审一样" },
];
/**
 * The keys a user can turn off or change in the settings. A letter that does different things on
 * different screens has an entry per thing. The arrows, the letters and numbers that pick a row,
 * enter, tab, esc, b for back, q, y and n always work, and so does every button. A row marked
 * `fixed` stands for several keys, so its keys cannot be changed.
 * @type {import("./kit/shortcuts.js").Shortcut[]}
 */
export const SHORTCUTS = [
  { id: "next", key: "j", what: "下一个站点" },
  { id: "prev", key: "k", what: "上一个站点" },
  { id: "scroll-down", key: "shift-j", what: "向下滚动代码" },
  { id: "scroll-up", key: "shift-k", what: "向上滚动代码" },
  { id: "deeper", key: "d", what: "在这个站点上更深入" },
  { id: "technical", key: "t", what: "用更技术的方式解释" },
  { id: "ask", key: "a  /", what: "就这个站点提问", fixed: true },
  { id: "explain", key: "e", what: "解释这个文件，或某个检查为什么失败" },
  { id: "open", key: "o", what: "打开文件、PR、检查或评审" },
  { id: "split", key: "s", what: "代码在文字旁边或上方" },
  { id: "files", key: "b", what: "显示或隐藏文件列表（PR 导览）" },
  { id: "viewed", key: "v", what: "把文件标为已读" },
  { id: "review", key: "p", what: "评审 PR，并发布评审" },
  { id: "fix", key: "f", what: "修复你的评论" },
  { id: "checks", key: "c", what: "打开检查" },
  { id: "merge", key: "m", what: "合并界面，并在那里合并" },
  { id: "replan", key: "r", what: "重新规划已保存的导览" },
  { id: "guide", key: "g", what: "开始导览（需求视图）" },
  { id: "refresh", key: "r", what: "刷新检查" },
  { id: "reply", key: "r a /", what: "回复修复 agent", fixed: true },
  { id: "push", key: "p", what: "推送修复" },
  { id: "discard", key: "x", what: "放弃修复" },
  { id: "agent", key: "a", what: "切换 agent（设置）" },
  { id: "model", key: "m", what: "选 omp 的模型（设置）" },
  { id: "zoom", key: "z", what: "缩放此窗格" },
];
// Read-only tools. Claude can look at the repo but never change it.
export const TOOLS = ["--allowedTools", "Read", "Grep", "Glob", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(git status:*)"];
// A fix run may also edit files. It runs in its own worktree, and still can't run other commands.
export const FIX_TOOLS = ["--allowedTools", "Read", "Grep", "Glob", "Edit", "MultiEdit", "Write", "Bash(git diff:*)", "Bash(git status:*)"];
// omp runs the same job with tool names instead of Claude's patterns: it has no per-command
// Bash filter, so a tour trusts the prompt to keep it read-only.
export const OMP_TOOLS = ["--tools", "read,grep,glob,bash", "--auto-approve"];
// A fix run may also edit files, in its own worktree.
export const OMP_FIX_TOOLS = ["--tools", "read,grep,glob,bash,edit,write", "--auto-approve"];
// The agents a tour can use, in the order Tourist prefers them: omp first, then the CLIs it borrows.
export const AGENTS = [{ id: "omp", name: "omp" }, { id: "claude", name: "Claude" }, { id: "codex", name: "Codex" }];
// File extensions the editor highlights with another language's grammar.
export const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
// Panes at least this wide put the code beside the explanation.
export const SPLIT_WIDTH = 1100;
