// Pure rules for the unread panel: the preview queue, and the reading progress
// preview-plus writes. No `gpui-kit` import, so `node --test` runs it alone.
//
// The queue belongs to the `open` shim (`~/.local/bin/open`): every click appends
// one entry, newest last, and the panel is a view onto it. The progress record
// belongs to the preview-plus tab (`shared("preview-plus.progress")`), keyed by
// absolute path; a file with no record there has never been opened.

export const QUEUE_MAX = 40; // the shim keeps the same number

export function shortName(path) {
  const name = String(path ?? "").split(/[\\/]/).pop() ?? "";
  return name.length > 40 ? `${name.slice(0, 38)}…` : name;
}

export function extensionOf(path) {
  const name = String(path ?? "").split(/[\\/]/).pop() ?? "";
  return name.includes(".") ? name.split(".").pop().toLowerCase() : "";
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

// The shim's queue.json as `[{ file, at }]`: strings, objects and duplicates all
// fold into one list, newest last, and an unreadable queue is an empty one.
export function splitQueue(raw) {
  let parsed = raw;
  if (typeof raw === "string") {
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.files) ? parsed.files : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const file = typeof item === "string" ? item : item?.file;
    const at = typeof item === "string" ? 0 : Number(item?.at) || 0;
    if (typeof file !== "string" || !file || seen.has(file)) continue;
    seen.add(file);
    out.push({ file, at });
  }
  return out.slice(-QUEUE_MAX);
}

// The file the preview tab was last asked to show, or null.
export function requestFile(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const file = JSON.parse(raw)?.file;
    return typeof file === "string" && file ? file : null;
  } catch {
    return null;
  }
}

// One file's record, every field defaulted: a file nobody opened is unread.
export function progressFor(store, file) {
  const rec = store && typeof store === "object" ? store[file] : null;
  const ratio = Number(rec?.ratio);
  const line = Number(rec?.line);
  return {
    opened: Boolean(rec?.opened),
    ratio: Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0,
    line: Number.isFinite(line) && line > 0 ? Math.floor(line) : null,
    snippet: typeof rec?.snippet === "string" ? rec.snippet : "",
    at: Number(rec?.at) || 0,
  };
}

// The panel's two groups: what nobody opened, then what was read, most recent first.
export function groups(store, files) {
  const unread = files.filter((entry) => !progressFor(store, entry.file).opened);
  const read = files.filter((entry) => progressFor(store, entry.file).opened)
    .sort((a, b) => progressFor(store, b.file).at - progressFor(store, a.file).at);
  return { unread, read };
}

// 全部已读: every queued file but the one on screen, which keeps where the reader is.
export function markAllRead(store, files, open, at) {
  const next = { ...(store && typeof store === "object" ? store : {}) };
  for (const entry of files) {
    if (entry.file === open) continue;
    next[entry.file] = { ...(next[entry.file] ?? {}), opened: true, ratio: 1, at };
  }
  return next;
}

// The row's one line of progress, for a panel that has to say it in a few words.
export function rowMeta(store, file, now) {
  const rec = progressFor(store, file);
  if (!rec.opened) return "未读 · 点击开始";
  const pct = Math.round(rec.ratio * 100);
  return `第 ${rec.line ?? 1} 行 · ${pct}% · ${ago(now, rec.at)}`;
}
