// Pure reading-progress and preview-queue rules for the preview-plus tab.
//
// No `gpui-kit` import: everything here is a value in, a value out, so
// `node --test tests/` runs it without a window. The tab keeps one record per
// file path in `shared("preview-plus.progress")`; the open shim appends every
// path it hands over to `~/.cache/herdr-open/queue.json`, newest last.

export const QUEUE_MAX = 40; // entries kept; the oldest fall off
export const RAIL_WIDTH = 236; // the files rail, in points

export function shortName(path) {
  const name = String(path ?? "").split(/[\\/]/).pop() ?? "";
  return name.length > 34 ? `${name.slice(0, 32)}…` : name;
}

export function folderOf(path) {
  const at = String(path ?? "").replace(/[\\/][^\\/]*$/, "");
  return at === path ? "" : at;
}

// `now` and `ts` in milliseconds; "" for a record that never happened.
export function ago(now, ts) {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const s = (now - ts) / 1000;
  if (s < 90) return "刚刚";
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}

// The shim's queue.json, or a file it cannot be read: strings, objects, and
// duplicates all fold into one newest-first list, with the open file present.
export function queueEntries(raw, fallback) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.files) ? raw.files : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const file = typeof item === "string" ? item : item?.file;
    const at = typeof item === "string" ? 0 : Number(item?.at) || 0;
    if (typeof file !== "string" || !file || seen.has(file)) continue;
    seen.add(file);
    out.push({ file, at });
  }
  if (typeof fallback === "string" && fallback && !seen.has(fallback)) out.push({ file: fallback, at: 0 });
  return out.slice(-QUEUE_MAX);
}

// One file's record, with every field defaulted: a file nobody opened is unread.
export function progressFor(store, file) {
  const rec = store && typeof store === "object" ? store[file] : null;
  const ratio = Number(rec?.ratio);
  const block = Number(rec?.block);
  return {
    opened: Boolean(rec?.opened),
    ratio: Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0,
    block: Number.isFinite(block) && block > 0 ? Math.floor(block) : 0,
    line: Number.isFinite(Number(rec?.line)) ? Number(rec.line) : null,
    snippet: typeof rec?.snippet === "string" ? rec.snippet : "",
    at: Number(rec?.at) || 0,
  };
}

// A record to write, keeping whatever the file already had.
export function withProgress(store, file, patch, at) {
  const next = { ...(store && typeof store === "object" ? store : {}) };
  next[file] = { ...(next[file] ?? {}), ...patch, opened: true, at };
  return next;
}

// 全部已读: every queued file but the open one, which keeps where the reader is.
export function markAllRead(store, files, open, at) {
  const next = { ...(store && typeof store === "object" ? store : {}) };
  for (const entry of files) {
    if (entry.file === open) continue;
    next[entry.file] = { ...(next[entry.file] ?? {}), opened: true, ratio: 1, at };
  }
  return next;
}

export function unreadCount(store, files) {
  return files.filter((entry) => !progressFor(store, entry.file).opened).length;
}

// The block at a scroll offset: the last one whose top is above the viewport, with a
// line of slack so a block scrolled just past still names the reader's place. The
// column reports no offset, so this is what turns the wheel distance into a position.
export function blockAtOffset(sizes, offset, slack = 8) {
  const list = Array.isArray(sizes) ? sizes : [];
  let block = 0;
  let top = 0;
  while (block < list.length - 1 && top + list[block] <= offset + slack) {
    top += list[block];
    block++;
  }
  return { block, top };
}

// The YAML front matter a note starts with, as `{ meta, body }`. A note without
// one keeps its text and reports `null`; `lineOffset` is how many source lines
// the body starts below, so a block's line number still names a line of the file.
export function splitFrontmatter(text) {
  const source = typeof text === "string" ? text : "";
  if (!source.startsWith("---\n")) return { meta: null, body: source, lineOffset: 0 };
  const end = source.indexOf("\n---", 3);
  if (end === -1) return { meta: null, body: source, lineOffset: 0 };
  const meta = {};
  for (const row of source.slice(4, end).split("\n")) {
    const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(row);
    if (match) meta[match[1]] = match[2].trim();
  }
  // `end` names the newline before the closing fence; the body starts after it,
  // past the blank line that separates the two.
  const head = source.slice(0, end + 4);
  const rest = source.slice(end + 4);
  const body = rest.replace(/^\n+/, "");
  return { meta, body, lineOffset: head.split("\n").length - 1 + (rest.length - body.length) };
}

// A note's body as blocks: each Mermaid fence is a block of its own, and the
// Markdown around it is cut again at every heading, so a reading position inside
// a long section is recoverable. Another language's fence stays in the Markdown,
// and a fence nobody closes is text, which is how Markdown reads it.
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^#{1,3}\s/;

export function documentBlocks(text) {
  const out = [];
  const lines = String(text ?? "").split("\n");
  let md = [];
  const flush = () => {
    // A block of nothing but blank lines would be an empty row; the line count
    // loses them, which moves a stated line by one or two and nothing more.
    if (md.some((line) => line.trim())) out.push({ md: md.join("\n") });
    md = [];
  };
  let i = 0;
  while (i < lines.length) {
    const fence = FENCE.exec(lines[i]);
    // An opening backtick fence's info string cannot hold a backtick.
    if (!fence || (fence[1][0] === "`" && fence[2].includes("`"))) {
      if (HEADING.test(lines[i]) && md.some((line) => line.trim())) flush();
      md.push(lines[i++]);
      continue;
    }
    const marks = fence[1];
    // The closing fence is the same character, at least as long, and nothing else.
    const close = new RegExp("^ {0,3}" + marks[0] + "{" + marks.length + ",}[ \\t]*$");
    let end = i + 1;
    while (end < lines.length && !close.test(lines[end])) end++;
    if (end === lines.length) { md.push(...lines.slice(i)); break; }
    if (fence[2].trim().split(/\s+/)[0].toLowerCase() !== "mermaid") { md.push(...lines.slice(i, end + 1)); i = end + 1; continue; }
    flush();
    out.push({ code: lines.slice(i + 1, end).join("\n") });
    i = end + 1;
  }
  flush();
  return out;
}

export const FRONTMATTER_LABELS = { speaker: "讲者", source: "来源", duration: "时长", absorbed: "日期" };

// The URL in a `source` value, or null: a note names the page and often its original.
export function firstUrl(value) {
  const match = String(value ?? "").match(/https?:\/\/[^\s（）()]+/);
  return match ? match[0] : null;
}

// A block's one-line summary, for the rail: Markdown syntax off, whitespace flat.
export function snippetOf(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => line.replace(/^[#>\s-]+|\*\*|`/g, "").trim())
    .find(Boolean)
    ?.slice(0, 72) ?? "";
}
