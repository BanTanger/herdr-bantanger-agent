// Read-only preview of the file behind a link clicked in a terminal or in Files.
//
// Herdr.app hands file links to `~/.local/bin/open`, which starts this mod as a
// tab with `{ file }`. Later clicks reach the same tab: the shim has already
// written the click to the request file below, and a shown copy follows it.
// The `files-plus` panel opens and reuses this tab the same way.
//
// A note's reading position is the first block on screen — the body is a virtual
// list cut at every heading — and it is written to `~/.cache/preview-plus/progress.json`
// every couple of seconds, so reopening a file lands where it was left. The unread
// panel (`mods/unread`) reads that record and the shim's queue; this tab draws no
// list of its own. A note's YAML front matter is drawn as a card above the body,
// not as its first paragraph.
//
// Keys (keys.json, section `mod:preview-plus`):
//   cmd-shift-up / cmd-shift-down   font size
//   cmd-shift-/                     preview <-> source (editable)
//   cmd-s                           save (source mode)
//   cmd-shift-enter                 open the file's folder
//   cmd-f                           find in the file
//   cmd-shift-[ / cmd-shift-]       previous / next queued file
//
// A Markdown file's Mermaid fences are drawn, not shown: each block goes out to
// `mmdc` (mermaid-cli), which writes a PNG into the app folder under
// `cache/preview-plus/mermaid/`, named by the diagram's source and the theme
// colors it was drawn with, so the next open reuses it. Without mmdc, or for a
// diagram mmdc refuses, the block stays the code it was.

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Input, InputState, ScrollHandle, Scrollbar, TextView, VirtualListScrollHandle, v_virtual_list } from "gpui-base";
import { appHome, closeOverlay, exec, home, nextCommand, props, readTextFile, settings, setShared, shared, theme, writeTextFile } from "herdr";
import * as fs from "fs/promises";
import { Resize } from "./resize.js";
import {
  FRONTMATTER_LABELS, ago, blockAtOffset, firstUrl, progressFor, documentBlocks,
  queueEntries, shortName, snippetOf, splitFrontmatter, withProgress,
} from "./progress.js";

const REQUEST = `${home()}/.cache/herdr-open/request.json`;
// The shim appends every file it hands over here, newest last: the files rail reads
// it as the preview queue, and a click that reuses this tab adds to it.
const QUEUE = `${home()}/.cache/herdr-open/queue.json`;
const MARKDOWN = new Set(["md", "markdown", "mdown", "mdx"]);
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const LIMIT = 400000;
const FONT_KEY = "preview-plus.font";
const MIN_FONT = 9;
const MAX_FONT = 32;
const DEFAULT_FONT = 12;
const HIT_ROW = 24;
const MAX_HITS = 2000;
// Mermaid fences go out to mmdc. Its pictures live in the app folder, because that is
// the only folder `image()` reads; the name is the diagram and the theme, so a cached
// one is found by name alone. Not inside this mod's own folder: Herdr redraws a mod
// whenever a file under it changes, so a picture written there would reload the mod
// that is drawing it — for ever, when the drawing fails.
const MERMAID_ASSETS = "cache/preview-plus/mermaid"; // under the app folder
const MERMAID_VERSION = 1; // bump when a change here makes old pictures wrong
const MERMAID_SCALE = 2; // picture pixels per point
const MERMAID_PARALLEL = 2; // renderers in flight
const MERMAID_TIMEOUT = 120000;
const MERMAID_KEEP = 300; // pictures kept before the oldest go
// Herdr fits a window to its content when it was opened without a width and height, and
// keeps fitting it as the content changes: this mod's size is its window's size.
const WIN_KEY = "preview-plus.window"; // shared: the size a window was last given
// shared: each open window's overlay id → its file, size, and whether it is in source
// mode, so the mod that opened a window can reopen it in place to bring it to the top.
const OPEN_KEY = "preview-plus.open";
// Absolute path → the block the reader stopped on, and enough to name it in the
// unread panel. A file with no record here has never been opened. Kept in a file,
// not in shared state: `setShared` re-renders every mod, and this is written while
// the reader scrolls — the window would hitch once per section crossed.
const PROGRESS = `${home()}/.cache/preview-plus/progress.json`;
const PROGRESS_KEY_LEGACY = "preview-plus.progress"; // older builds kept positions in shared state
const PROGRESS_MS = 2000; // how often a scroll position is written
const GAP_ROW = 48; // the shortest row the slot pool is sized against
const WIN_DEFAULT = { w: 880, h: 720 }; // a window opened without a size is its content's
const MIN_W = 360, MIN_H = 260;
const MAX_W = 2600, MAX_H = 1800;

function base(path) {
  return path.split(/[\\/]/).pop() ?? path;
}

function folder(path) {
  const at = path.replace(/[\\/][^\\/]*$/, "");
  return at === path ? "" : at;
}

function extension(path) {
  const name = base(path);
  return name.includes(".") ? name.split(".").pop().toLowerCase() : "";
}

// A file name for a string: FNV-1a 64, in hex. Pictures are named by one, so two
// diagrams share a file only if their bytes do.
function digest(text) {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

// A PNG's pixel size, read from its IHDR; null for anything else.
function pngSize(bytes) {
  if (!bytes || bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
  const at = (i) => ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
  const w = at(16), h = at(20);
  return w > 0 && h > 0 ? { w, h } : null;
}

// Whether a theme color is dark, so a diagram is drawn on the side of the theme it
// sits in: mmdc has no idea which window it is painting for.
function dark(hex) {
  const n = Number.parseInt(String(hex ?? "").replace("#", "").slice(0, 6), 16);
  if (!Number.isFinite(n)) return true;
  return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255) < 128;
}

// mmdc, once found, stays found: `exec` runs the user's own environment, and a
// Homebrew prefix is not on a GUI app's PATH when the app came from the Finder.
let mmdc; // undefined: never asked; null: nowhere to be found
async function mermaidCommand() {
  if (mmdc !== undefined) return mmdc;
  for (const command of ["mmdc", "/opt/homebrew/bin/mmdc", "/usr/local/bin/mmdc", `${home()}/.local/bin/mmdc`]) {
    try {
      const { code } = await exec(command, ["--version"], { timeout: 30000 });
      if (code === 0) return (mmdc = command);
    } catch {}
  }
  return (mmdc = null);
}

// `tab.new --props` may hand the file over as an object or as its JSON text.
function propFile(given) {
  const raw = given?.file ?? props()?.file;
  if (typeof raw !== "string" || !raw) return null;
  if (raw.startsWith("{")) {
    try { return JSON.parse(raw)?.file ?? null; } catch { return null; }
  }
  return raw;
}

const clampFont = (n) => Math.max(MIN_FONT, Math.min(MAX_FONT, Math.round(n)));

// A window opened with no size is as big as its content: this is that size, in pixels.
const screen = () => {
  const v = window.viewport_size();
  return { w: v?.width || 1920, h: v?.height || 1080 };
};
const clampSize = (w, h) => {
  const v = screen();
  return {
    w: Math.min(MAX_W, v.w - 24, Math.max(MIN_W, Math.round(w))),
    h: Math.min(MAX_H, v.h - 24, Math.max(MIN_H, Math.round(h))),
  };
};
const windowSize = () => {
  const saved = shared(WIN_KEY);
  if (saved?.w >= MIN_W && saved?.h >= MIN_H) return clampSize(saved.w, saved.h);
  return { ...WIN_DEFAULT };
};
// A window reopened by the mod that opened it keeps its own size: `props().win`.
const ownSize = (win) => (win?.w >= MIN_W && win?.h >= MIN_H ? clampSize(win.w, win.h) : null);

export default class Preview extends View {
  file = null;
  text = null;
  error = null;
  code = null;
  token = 0;
  source = false;
  dirty = false;
  saved = null;
  following = false;
  font = DEFAULT_FONT;
  findOpen = false;
  query = "";
  hits = [];
  hit = 0;
  findInput = null;
  hitScroll = null;
  size = null;
  win = null; // the content size, which a window follows
  big = null; // the size the size dot grew from, so a second press restores it
  segments = null; // the document split at its mermaid fences; null when it is not Markdown
  look = null; // the configuration those blocks were last keyed by
  diagrams = new Map(); // diagram key → { status, png, w, h, error }
  queue = []; // diagrams waiting for a renderer
  running = 0; // renderers in flight
  retheming = false; // a theme-driven redraw is already scheduled
  // Reading progress and the files rail. A note's front matter is a card of its own
  // above the body; the body is a list of blocks whose first visible one is the
  // position that gets written.
  files = []; // [{ file, at }] the shim's preview queue, newest last
  meta = null; // the note's front matter, once parsed
  lineOffset = 0; // source lines the body starts below the front matter
  doc = []; // the rendered document's blocks: { kind, key, segment, line, lines }
  measured = new Map(); // block key → the height it reported
  list = null; // the column's scroll handle (reveal a block, not read an offset)
  scrollPx = 0; // how far down the column the reader has wheeled, in points
  viewportH = 0; // the column's own height, for clamping that distance
  restoreTo = null; // block to reveal once the document has laid out
  progress = {}; // absolute path → { block, ratio, snippet, line, at, opened }
  progressText = null; // the file as last read or written (writeTextFile's compare-and-swap)
  writing = false; // a write is in flight; the next tick picks up the newest value
  saving = 0; // timestamp of the last progress write
  readTask = null; // the file read in flight, cancelled by a newer one or by close
  queueTask = null; // the queue read at startup
  followTask = null; // the 1.5 s request-file poll
  progressTask = null; // the 2 s progress write
  focusTask = null; // the one-shot focus after opening
  commandsTask = null; // the mod's command loop

  init(p, cx) {
    this.handle = cx.focus_handle();
    this.win = ownSize(props()?.win) ?? windowSize();
    this.edges = props()?.overlay ? new Resize({ // a tab has a pane's edges instead
      get: () => this.win,
      set: (w, h) => {
        const s = clampSize(w, h);
        if (s.w === this.win.w && s.h === this.win.h) return false;
        this.win = s; // the window follows this before the next frame
        return true;
      },
      done: () => {
        setShared(WIN_KEY, { ...this.win }); // the next window opens at this size
        this.publish();
      },
    }) : null;
    this.font = clampFont(Number(shared(FONT_KEY)) || DEFAULT_FONT);
    this.findInput = InputState.new({ placeholder: "Find in file" });
    this.findInput.on("change", (_e, cx) => this.search(this.findInput.value(), cx));
    this.findInput.on("submit", (e, cx) => this.step(e.shift ? -1 : 1, cx));
    this.hitScroll = VirtualListScrollHandle.new();
    this.list = ScrollHandle.new(); // the plain column's position
    this.show(propFile(p), cx);
    this.publish();
    this.queueTask = cx.spawn(async (cx) => { await this.loadProgress(cx); await this.loadQueue(cx); });
    this.progressTask = cx.timer.every(PROGRESS_MS, (cx) => this.saveProgress(cx));
    // Later clicks rewrite the request file; follow it. Cheap on purpose: it
    // stays alive while the tab is hidden. A window opened by another mod names
    // its file and keeps it: a click in a terminal must not rewrite it.
    // The overlay id is only in `props()`: `init` is handed null for a copy the
    // host opened as an overlay, so `p` cannot tell a window from a tab.
    if (!props()?.overlay) this.followTask = cx.timer.every(1500, (cx) => this.follow(cx));
    this.commandsTask = cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "zoom-in") this.zoom(1, cx);
        else if (c === "zoom-out") this.zoom(-1, cx);
        else if (c === "source") this.toggleSource(cx);
        else if (c === "save") this.save(cx);
        else if (c === "folder") this.openFolder(cx);
        else if (c === "find") this.openFind(cx);
      }
    });
    // The tab is opened to be read: take the keyboard, so the keys work at once.
    this.focusTask = cx.timer.after(80, (cx) => { try { this.handle.focus(); } catch {} });
  }

  async follow(cx) {
    if (this.following) return;
    this.following = true;
    try {
      const request = await readTextFile(REQUEST).catch(() => null);
      let file = null;
      try { file = JSON.parse(request ?? "")?.file ?? null; } catch {}
      if (typeof file === "string" && file && file !== this.file) {
        this.show(file, cx);
        this.loadQueue(cx).catch(() => {});
      }
    } finally {
      this.following = false;
    }
  }

  show(file, cx) {
    if (file && file === this.file && (this.text || this.code)) return;
    // Where the reader was in the outgoing file, before this one replaces it.
    this.saveProgress(cx, { force: true });
    this.code?.release();
    this.code = null;
    this.file = file;
    this.text = null;
    this.error = null;
    this.dirty = false;
    this.saved = null;
    // A new file under an open bar would keep hits from the old one.
    this.query = "";
    this.hits = [];
    this.hit = 0;
    this.findInput?.set_value("");
    if (!file) { this.error = "No file"; return; }
    const token = ++this.token;
    try { this.readTask?.cancel?.(); } catch {}
    this.readTask = cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(file);
        if (token !== this.token) return;
        if (text === null) { this.error = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.error = "Binary file · no text preview"; return; }
        this.saved = text;
        this.text = text.length > LIMIT ? `${text.slice(0, LIMIT)}\n… (file truncated)` : text;
        // The panel's record of this file: opened now, at the block it was left on.
        this.restoreTo = progressFor(this.progress, file).block;
        this.progress = withProgress(this.progress, file, {}, Date.now());
        this.writeProgress(cx, { force: true });
        this.scrollPx = 0;
        this.build(cx);
      } catch {
        if (token === this.token) this.error = "Cannot preview this file (binary, too large, or unreadable)";
      } finally {
        if (token === this.token) cx.notify();
      }
    });
  }

  // The text as it stands: the editor's buffer while editing, else what was read.
  liveText() {
    return this.source && this.code ? this.code.value() : this.text;
  }

  // The rendered markdown needs no retained state; everything else (code, and a
  // source-mode markdown file) is an Editor, editable only in source mode.
  build(cx) {
    const keep = this.liveText();
    this.code?.release();
    this.code = null;
    if (keep != null) this.text = keep;
    if (!this.text) return;
    const rendered = !this.source && MARKDOWN.has(extension(this.file));
    this.segments = null;
    this.meta = null;
    this.lineOffset = 0;
    this.doc = [];
    if (rendered) {
      // A note's front matter becomes a card of its own: the body is what the
      // page draws, and the card stands in for the lines above it.
      const split = splitFrontmatter(this.text);
      this.meta = split.meta;
      this.lineOffset = split.lineOffset;
      this.segments = documentBlocks(split.body);
      this.doc = this.blocksOf();
      this.measured.clear();
      this.scrollPx = 0;
      this.sketch(cx);
      return;
    }
    const t = theme();
    const ext = extension(this.file);
    this.code = EditorState.new({
      language: LANG[ext] ?? (ext || "txt"),
      value: this.text,
      readonly: !this.source,
      soft_wrap: true,
      font_family: settings().font_family,
      font_size: this.font,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 },
    });
    this.code.on("change", (_e, cx) => {
      this.dirty = this.code.value() !== this.saved;
      if (this.findOpen) this.search(this.query, cx);
      cx.notify();
    });
  }

  // Each mermaid block gets a picture, named by the diagram and the theme colors it
  // is drawn with: a picture already on disk is measured, not drawn again.
  sketch(cx) {
    const look = this.diagramLook();
    this.look = look;
    const themed = digest(look);
    for (const segment of this.segments) {
      if (!segment.code) continue;
      segment.key = digest(`${MERMAID_VERSION}:${themed}:${segment.code}`);
      if (this.diagrams.has(segment.key)) continue;
      this.diagrams.set(segment.key, {
        status: "pending",
        png: `${appHome()}/${MERMAID_ASSETS}/${segment.key}.png`,
        w: 0,
        h: 0,
        config: look,
      });
      this.queue.push({ key: segment.key, code: segment.code });
    }
    this.pump(cx);
  }

  // How mmdc draws: the theme's own colors on a transparent background, so a
  // diagram sits in the page instead of in a light box on it.
  diagramLook() {
    const t = theme();
    return JSON.stringify({
      theme: "base",
      themeVariables: {
        darkMode: dark(t.background),
        background: "transparent",
        // `surface` is the page itself in Herdr's themes; `raised` is the step above
        // it, which is what a node should look like.
        primaryColor: t.raised,
        primaryTextColor: t.foreground,
        primaryBorderColor: t.muted,
        secondaryColor: t.popover,
        tertiaryColor: t.chrome,
        lineColor: t.muted,
        textColor: t.foreground,
        edgeLabelBackground: t.background,
        clusterBkg: t.canvas,
        clusterBorder: t.muted,
        noteBkgColor: t.popover,
        noteTextColor: t.foreground,
        noteBorderColor: t.raised,
        fontFamily: "system-ui, -apple-system, 'PingFang SC', 'Segoe UI', sans-serif",
        fontSize: "16px",
      },
      flowchart: { htmlLabels: false },
    });
  }

  pump(cx) {
    while (this.running < MERMAID_PARALLEL && this.queue.length) {
      const job = this.queue.shift();
      this.running++;
      cx.spawn(async (cx) => {
        try {
          await this.paint(job);
        } finally {
          this.running--;
          this.pump(cx);
          cx.notify();
        }
      });
    }
  }

  // One picture: a file already on disk is measured; otherwise mmdc draws it. No
  // mmdc, or a diagram it refuses, leaves the block the code it was.
  async paint(job) {
    const rec = this.diagrams.get(job.key);
    if (!rec) return;
    const dir = `${appHome()}/${MERMAID_ASSETS}`;
    try {
      await fs.mkdir(dir, { recursive: true });
      let size = pngSize(await fs.readFile(rec.png).catch(() => null));
      if (!size) {
        const command = await mermaidCommand();
        if (!command) { rec.status = "missing"; return; }
        rec.status = "rendering";
        const config = `${dir}/theme-${digest(rec.config)}.json`;
        if (!(await fs.exists(config))) await fs.writeFile(config, rec.config);
        const input = `${dir}/${job.key}.mmd`;
        await fs.writeFile(input, job.code);
        const result = await exec(command, ["-i", input, "-o", rec.png, "-b", "transparent", "-s", String(MERMAID_SCALE), "-c", config, "-q"], { timeout: MERMAID_TIMEOUT });
        size = result.code === 0 ? pngSize(await fs.readFile(rec.png).catch(() => null)) : null;
        if (!size) {
          rec.status = "failed";
          // The first line is the error; what follows is a stack of frames.
          const said = (result.stderr || result.stdout || "").split("\n").map((line) => line.trim()).find(Boolean) ?? "";
          rec.error = said.slice(0, 200) || `mmdc exited ${result.code}`;
          return;
        }
        this.prune(dir);
      }
      Object.assign(rec, { status: "ready", w: size.w, h: size.h, error: null });
    } catch (error) {
      rec.status = "failed";
      rec.error = String(error?.message ?? error);
    }
  }

  // The cache keeps the newest pictures; the oldest go, with their inputs.
  prune(dir) {
    const quoted = `'${dir.replace(/'/g, `'\\''`)}'`;
    const script = `cd ${quoted} && ls -t *.png 2>/dev/null | tail -n +${MERMAID_KEEP + 1}`
      + ` | while read -r f; do rm -f "$f" "\${f%.png}.mmd"; done`;
    exec("/bin/sh", ["-c", script], { timeout: 30000 }).catch(() => {});
  }

  // The document as blocks: the front matter's card, then one TextView per stretch
  // of Markdown with a picture between them. A diagram still being drawn keeps its
  // code, so the page is never blank in place.
  blocksOf() {
    const out = [];
    if (this.meta) out.push({ kind: "fm", key: `${this.file}#fm`, line: 1, lines: this.lineOffset });
    let line = this.lineOffset;
    (this.segments ?? []).forEach((segment, i) => {
      const lines = segment.code ? segment.code.split("\n").length + 2 : segment.md.split("\n").length;
      out.push({ kind: segment.code ? "mmd" : "md", key: `${this.file}#${i}`, segment, line: line + 1, lines });
      line += lines;
    });
    return out;
  }

  // The height to place a block at before it has drawn: the list corrects it with
  // the height the block reports.
  sizeOf(block) {
    const measured = this.measured.get(block.key);
    if (measured) return measured;
    if (block.kind === "fm") return 132;
    if (block.kind === "mmd") return 220;
    return Math.min(3200, Math.max(24, Math.round(block.lines * this.font * 1.62) + 16));
  }

  // One block: the front matter card, a rendered Markdown stretch, or a diagram.
  blockView(block, t, cx) {
    const body = block.kind === "fm" ? this.frontmatterCard(t)
      : block.kind === "mmd" ? this.diagram(block.segment, t)
        : TextView.markdown(`preview-${block.key}`, block.segment.md).selectable().text_size(this.font);
    return v_flex().id(`preview-blk-${block.key}`).w_full().flex_none()
      .on_size_change((size, cx) => this.blockSized(block, size, cx))
      .child(body);
  }

  // A block reported the height it drew at: keep it, so the column's offsets — and the
  // position the unread panel reads — are the heights on screen, not estimates.
  blockSized(block, size) {
    const height = Math.round(size.height);
    if (!(height > 0) || Math.abs((this.measured.get(block.key) ?? -1) - height) <= 1) return;
    this.measured.set(block.key, height);
  }

  // Where the top of a block sits in the column, in points.
  offsetOf(index) {
    let top = 0;
    for (let i = 0; i < index; i++) top += this.sizeOf(this.doc[i]);
    return top;
  }

  // The column's height in points, from the blocks that have measured themselves.
  contentHeight() {
    return (this.doc ?? []).reduce((sum, block) => sum + this.sizeOf(block), 0);
  }

  // A plain column reports no offset: the wheel distance is what there is, clamped to
  // the measured height. A dragged bar or a paged keyboard is not seen, so a position
  // is an estimate — the snippet and line are what a reader recognises.
  wheeled(event) {
    const max = Math.max(0, this.contentHeight() - (this.viewportH || 0));
    this.scrollPx = Math.max(0, Math.min(max, (this.scrollPx ?? 0) - event.delta.y));
  }

  // The front matter, as a card: the note's own title, its status, and the fields a
  // reader scans for. Its lines are what the card stands in for.
  frontmatterCard(t) {
    const meta = this.meta ?? {};
    const keys = ["speaker", "source", "duration", "absorbed"].filter((key) => meta[key]);
    return v_flex().id("preview-fm").mb(16).rounded(10).border_1().border_color(t.border).bg(t.raised).overflow_hidden()
      .child(h_flex().items_start().gap(10).px(14).pt(12).pb(9)
        .child(div().flex_1().min_w(0).text_size(16).font_semibold().child(meta.title ?? ""))
        .when(Boolean(meta.status), (el) => el.child(div().flex_none().mt(3).px(8).py(1).rounded(9)
          .border_1().border_color(t.ansi3).text_size(9).text_color(t.ansi3).child(meta.status.toUpperCase()))))
      .child(v_flex().border_t(1).border_color(t.border).px(14).pt(6).pb(10).gap(2)
        .children(keys.map((key) => this.frontmatterRow(t, key, meta[key]))));
  }

  frontmatterRow(t, key, value) {
    const url = key === "source" ? firstUrl(value) : null;
    return h_flex().gap(8).text_size(11)
      .child(div().w(46).flex_none().text_color(t.dim).child(FRONTMATTER_LABELS[key] ?? key))
      .child(div().flex_1().min_w(0).truncate().text_color(url ? t.ansi4 : t.muted).child(url ?? value));
  }

  // A diagram, at the width the document was laid out to (the rail takes its own).
  diagram(segment, t) {
    const width = Math.max(240, (this.size?.width ?? 760) - 28);
    const rec = this.diagrams.get(segment.key);
    const id = `preview-mermaid-${segment.key}`;
    if (rec?.status === "ready") {
      const w = Math.round(Math.min(width, rec.w / MERMAID_SCALE));
      const h = Math.round((w * rec.h) / rec.w);
      return v_flex().id(id).flex_none().w_full().items_center().my(8)
        .child(image(`${MERMAID_ASSETS}/${segment.key}.png`).w(w).h(h));
    }
    const note = rec?.status === "missing"
      ? "Mermaid diagrams need mermaid-cli: npm install -g @mermaid-js/mermaid-cli"
      : rec?.status === "failed"
        ? `Diagram: ${rec.error ?? "mermaid-cli could not draw this"}`
        : "Rendering diagram…";
    return v_flex().id(id).flex_none().w_full().my(8).p(10).gap(6).rounded(6)
      .border_1().border_color(t.border).bg(t.surface)
      .child(div().text_size(11).text_color(rec?.status === "failed" ? t.accent : t.dim).child(note))
      .child(div().font_family(settings().font_family).text_size(Math.max(9, this.font - 2)).text_color(t.dim).child(segment.code));
  }

  // The document: a plain scrolling column of blocks. It was a virtual list, but a list
  // row may not register the size handler that keeps its heights honest, and a window
  // that lagged a fast scroll showed as blank rows; a note is small enough to build
  // whole, and a column keeps every block in its place.
  docView(cx) {
    const blocks = this.doc;
    const t = theme();
    if (this.restoreTo != null && blocks.length) {
      const block = Math.min(this.restoreTo, blocks.length - 1);
      this.restoreTo = null;
      cx.timer.after(0, (cx) => {
        try { this.list.scroll_to_item(block); } catch {}
        this.scrollPx = this.offsetOf(block);
        cx.notify();
      });
    }
    return v_flex().id("preview-doc").flex_1().min_h(0).overflow_y_scrollbar()
      .track_scroll(this.list)
      .on_size_change((size) => { this.viewportH = Math.round(size.height); })
      .on_scroll_wheel((event) => this.wheeled(event))
      .px(14).pt(14).pb(72)
      .children(blocks.map((block) => this.blockView(block, t, cx)));
  }

  // ---- reading progress and the files rail ---------------------------------------------------------
  // The shim's queue plus whatever this tab has opened: the rail's files, newest last.
  queued() {
    const files = [...this.files];
    if (this.file && !files.some((entry) => entry.file === this.file)) files.push({ file: this.file, at: 0 });
    return files;
  }

  async loadQueue(cx) {
    try {
      const raw = await readTextFile(QUEUE);
      this.files = queueEntries(raw ? JSON.parse(raw) : null, this.file);
    } catch {
      this.files = queueEntries(null, this.file);
    }
    cx.notify();
  }

  // Where the reader is: the first visible block, its line, and its first line of
  // text, so the rail can say `第 41 行 · 62%` and quote it. Written in one place.
  saveProgress(cx, opts = {}) {
    if (!this.file || !this.doc?.length) return;
    if (this.restoreTo != null) return; // still landing on the restored block
    const blocks = this.doc;
    const sizes = blocks.map((block) => this.sizeOf(block));
    const total = sizes.reduce((sum, n) => sum + n, 0);
    const { block, top: before } = blockAtOffset(sizes, this.scrollPx ?? 0);
    const ratio = total > 0 ? Math.min(1, Math.max(0, before / total)) : 0;
    const target = blocks[block];
    const snippet = target?.kind === "fm"
      ? (this.meta?.title ?? "")
      : snippetOf(target?.segment?.code ?? target?.segment?.md);
    const current = progressFor(this.progress, this.file);
    if (!opts.force && current.opened && current.block === block && current.snippet === snippet) return;
    if (!opts.force && Date.now() - this.saving < 250) return;
    this.saving = Date.now();
    this.progress = withProgress(this.progress, this.file, {
      block, ratio, snippet, line: target?.line ?? null,
    }, Date.now());
    this.writeProgress(cx);
    cx.notify();
  }

  // The positions live in a file, never in shared state: `setShared` re-renders every
  // mod, and this runs while the reader scrolls. The unread panel reads the same file,
  // so the two can never disagree about where a file was left.
  writeProgress(cx, opts = {}) {
    const text = JSON.stringify(this.progress);
    if (text === this.progressText || (!opts.force && this.writing)) return;
    this.writing = true;
    const expected = this.progressText;
    const mine = this.progress[this.file];
    cx.spawn(async (cx) => {
      try {
        await writeTextFile(PROGRESS, text, expected);
        this.progressText = text;
      } catch {
        // 全部已读 in the panel moved the file: keep its records, ours for this file.
        const raw = await readTextFile(PROGRESS).catch(() => null);
        let theirs = {};
        try { theirs = JSON.parse(raw ?? "{}") ?? {}; } catch {}
        this.progress = mine ? { ...theirs, [this.file]: mine } : theirs;
        this.progressText = raw;
      } finally {
        this.writing = false;
        cx.notify();
      }
    });
  }

  async loadProgress(cx) {
    let raw = await readTextFile(PROGRESS).catch(() => null);
    if (raw === null) {
      // A one-time move from the shared record older builds wrote: losing it would
      // drop every reading position the reader had.
      const legacy = shared(PROGRESS_KEY_LEGACY);
      if (legacy && typeof legacy === "object" && Object.keys(legacy).length) {
        raw = JSON.stringify(legacy);
        await writeTextFile(PROGRESS, raw, null).catch(() => {});
      }
    }
    try { this.progress = JSON.parse(raw ?? "{}") ?? {}; } catch { this.progress = {}; }
    this.progressText = raw;
    // The document was placed before this arrived: land it where the reader left it.
    this.restoreTo = progressFor(this.progress, this.file).block;
    cx.notify();
  }

  // 全部已读: every queued file but the open one, which keeps where the reader is.
  openFromRail(file, cx) {
    if (file === this.file) return;
    this.show(file, cx);
    cx.notify();
  }

  zoom(step, cx) {
    const next = clampFont((this.font || DEFAULT_FONT) + step);
    if (next === this.font) return;
    this.font = next;
    setShared(FONT_KEY, next);
    this.build(cx);
    cx.notify();
  }

  toggleSource(cx) {
    if (!this.text) return;
    if (this.source && this.code) this.text = this.code.value();
    this.source = !this.source;
    this.build(cx);
    this.publish();
    cx.notify();
  }

  // Herdr raises only the window pressed last, and has no call to raise one. A mod that
  // opened this window brings it back to the top by opening its name again, which is a
  // fresh copy: so it must not do that to one in source mode, where unsaved text lives.
  publish() {
    const id = props()?.overlay;
    if (!id) return;
    const all = shared(OPEN_KEY) ?? {};
    const was = all[id];
    const now = { file: this.file, win: { ...this.win }, editing: this.source };
    if (was && was.file === now.file && was.editing === now.editing && was.win?.w === now.win.w && was.win?.h === now.win.h) return;
    setShared(OPEN_KEY, { ...all, [id]: now });
  }

  close() {
    // A reloaded or closed tab gets 250 ms; every task this view started is cancelled
    // here, so a hot reload does not leave timers writing progress for a view nobody
    // can see (the host warns about stranded tasks when it happens).
    for (const task of [this.followTask, this.progressTask, this.focusTask, this.commandsTask, this.queueTask, this.readTask]) {
      try { task?.cancel?.(); } catch {}
    }
    this.followTask = this.progressTask = this.focusTask = this.commandsTask = this.queueTask = this.readTask = null;
    const id = props()?.overlay;
    const all = shared(OPEN_KEY);
    if (!id || !all?.[id]) return;
    const { [id]: _gone, ...rest } = all;
    setShared(OPEN_KEY, rest);
  }

  save(cx) {
    if (!this.source || !this.code || !this.file) return;
    const text = this.code.value();
    const token = this.token;
    cx.spawn(async (cx) => {
      try {
        await writeTextFile(this.file, text, this.saved);
        if (token !== this.token) return;
        this.saved = text;
        this.text = text;
        this.dirty = false;
      } catch {
        if (token === this.token) this.error = "Save failed: the file changed on disk";
      } finally {
        if (token === this.token) cx.notify();
      }
    });
  }

  openFolder(cx) {
    const dir = this.file ? folder(this.file) : "";
    if (!dir) return;
    cx.spawn(async () => { await exec("open", [dir]).catch(() => {}); });
  }

  // The size dot, as a window's zoom button: a quarter bigger, or back to what it was.
  // A tab copy has no window of its own to resize and no dot.
  expand() {
    if (!props()?.overlay) return;
    if (this.big) {
      const back = this.big;
      this.big = null;
      this.win = clampSize(back.w, back.h);
    } else {
      this.big = { ...this.win };
      this.win = clampSize(this.win.w * 1.25, this.win.h * 1.25);
    }
    setShared(WIN_KEY, { ...this.win });
    this.publish();
  }

  // Search lists the hits rather than scrolling to them: neither TextView nor
  // Editor reports a scroll offset, so a hit cannot be brought into view inside
  // the document. The bar leaves the page intact until something is typed; then
  // the hits cover it, each naming its line and showing it for context.
  openFind(cx) {
    this.findOpen = true;
    this.findInput.focus();
    // The element behind the state is drawn on the next frame.
    cx.timer.after(60, () => { if (this.findOpen) this.findInput.focus(); });
    if (this.query) this.search(this.query, cx);
    else cx.notify();
  }

  closeFind(cx) {
    this.findOpen = false;
    this.query = "";
    this.hits = [];
    this.hit = 0;
    this.findInput.set_value("");
    // The input goes away with the bar; the pane's own handle takes the keyboard back.
    try { this.handle.focus(); } catch {}
    cx.notify();
  }

  // Case-insensitive; one hit per occurrence, carrying the line it sits on.
  search(query, cx) {
    this.query = query;
    this.hits = [];
    this.hit = 0;
    const needle = query.toLowerCase();
    if (needle) {
      const lines = (this.liveText() ?? "").split("\n");
      for (let i = 0; i < lines.length && this.hits.length < MAX_HITS; i++) {
        const line = lines[i], lower = line.toLowerCase();
        for (let at = lower.indexOf(needle); at !== -1 && this.hits.length < MAX_HITS; at = lower.indexOf(needle, at + needle.length)) {
          this.hits.push({ line: i + 1, start: at, end: at + needle.length, text: line });
        }
      }
    }
    if (this.hits.length) this.hitScroll.scroll_to_item(0);
    cx.notify();
  }

  step(dir, cx) {
    if (!this.hits.length) return;
    this.hit = (this.hit + dir + this.hits.length) % this.hits.length;
    this.hitScroll.scroll_to_item(this.hit, "center");
    cx.notify();
  }

  tally() {
    if (!this.query) return "";
    if (!this.hits.length) return "No matches";
    return `${this.hit + 1}/${this.hits.length}${this.hits.length >= MAX_HITS ? "+" : ""}`;
  }

  hitRow(t, h, index) {
    const raw = h.text;
    const cut = h.start > 32 ? "…" : "";
    const pre = raw.slice(Math.max(0, h.start - 32), h.start).replace(/\t/g, "    ");
    const mid = raw.slice(h.start, Math.min(h.end, h.start + 48)).replace(/\t/g, "    ");
    const post = raw.slice(Math.min(h.end, h.start + 48), h.end + 64).replace(/\t/g, "    ");
    return h_flex().h(HIT_ROW).flex_none().px(12).gap(8).items_center()
      .when(index === this.hit, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .child(div().w(48).flex_none().text_size(11).text_color(t.dim).child(String(h.line)))
      .child(div().flex_none().max_w(220).whitespace_nowrap().text_ellipsis_start().text_size(12).text_color(t.dim).child(cut + pre))
      .child(div().flex_none().max_w(320).truncate().text_size(12).font_semibold().text_color(t.accent).child(mid || " "))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(post));
  }

  button(t, id, label, onClick, opts = {}) {
    return div().id(id).px(8).py(2).rounded(5).text_size(12).cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()) // no window move from a button
      .when(Boolean(opts.active), (el) => el.bg(t.selected).text_color(t.foreground))
      .when(!opts.active, (el) => el.text_color(t.muted))
      .when(Boolean(opts.accent), (el) => el.text_color(t.accent))
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(onClick)
      .child(label);
  }

  // A window draws no frame of its own, so it carries its own controls: macOS' two dots,
  // on the left where the platform keeps them. A tab has a pane frame around it instead.
  dots(given) {
    const dot = (id, bg, action) => div().id(id).w(12).h(12).flex_none().rounded(12).bg(bg).cursor_pointer()
      .hover((s) => s.opacity(0.8)).on_click(action);
    return h_flex().id("win-dots").flex_none().gap(8).items_center().mr(4)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()) // no window drag from a button
      .child(dot("win-close", "#ff5f57", () => closeOverlay(given.overlay)))
      .child(dot("win-size", "#28c840", (_e, cx) => { this.expand(); cx.notify(); }));
  }

  // The next or previous queued file, in the order the rail lists them.
  stepFile(dir, cx) {
    const files = this.queued();
    if (files.length < 2) return;
    const at = files.findIndex((entry) => entry.file === this.file);
    const next = files[((at < 0 ? 0 : at) + dir + files.length) % files.length];
    if (next.file !== this.file) this.openFromRail(next.file, cx);
  }

  // The same chords keys.json binds to this mod. That binding needs the pane's
  // own focus handle; this one also fires while the editor below has the keyboard.
  keys(e, cx) {
    const m = e.modifiers ?? {};
    const chord = (key, shift) => m.platform && Boolean(m.shift) === shift && !m.control && !m.alt && e.key === key;
    const plain = !m.platform && !m.control && !m.alt;
    // A window another mod opened has no frame of its own: Esc is how it goes away.
    if (plain && e.key === "escape" && !this.findOpen && props()?.overlay) {
      closeOverlay(props().overlay);
      cx.stop_propagation();
      return;
    }
    if (this.findOpen) {
      // Escape and the arrows are the search bar's; the input keeps the rest.
      if (e.key === "escape" && plain) { this.closeFind(cx); cx.stop_propagation(); return; }
      if (e.key === "down" && plain && !m.shift) { this.step(1, cx); cx.stop_propagation(); return; }
      if (e.key === "up" && plain && !m.shift) { this.step(-1, cx); cx.stop_propagation(); return; }
    }
    if (chord("f", false)) this.openFind(cx);
    else if (chord("s", false)) this.save(cx);
    else if (this.findOpen) return;
    else if (chord("up", true)) this.zoom(1, cx);
    else if (chord("down", true)) this.zoom(-1, cx);
    else if (chord("[", true)) this.stepFile(-1, cx);
    else if (chord("]", true)) this.stepFile(1, cx);
    else if (chord("/", true)) this.toggleSource(cx);
    else if (chord("enter", true)) this.openFolder(cx);
    else return;
    cx.stop_propagation();
  }

  // The find bar's hits, covering the page rather than replacing it.
  hitsOverlay(t, cx) {
    if (!this.hits.length) {
      return v_flex().absolute().inset_0().bg(t.background)
        .child(div().p(14).text_color(t.dim).child(`No matches for “${this.query}”`));
    }
    return v_flex().absolute().inset_0().bg(t.background)
      .child(div().flex_1().min_h(0).relative()
        .child(v_virtual_list("preview-hits", this.hits.length, HIT_ROW, (i) => String(i),
          // No handlers in a row: `on_item_click` on the list is where a press lands.
          (range) => this.hits.slice(range.start, range.end).map((h, k) => this.hitRow(t, h, range.start + k)))
          .size_full().track_scroll(this.hitScroll)
          .on_item_click((key, cx) => {
            const i = Number(key);
            if (!Number.isFinite(i)) return;
            this.hit = i;
            this.hitScroll.scroll_to_item(i, "center");
            cx.notify();
          }))
        .child(Scrollbar.vertical("preview-hits").absolute().inset_0()));
  }

  render(cx) {
    // props() names the file the tab was opened with; the request file names the
    // one clicked last. Seeding from props on every render pulled a followed file
    // back, and the poll pulled it forward again: a visible flip every 1.5 s.
    if (!this.file) {
      const seeded = propFile();
      if (seeded) this.show(seeded, cx);
    }
    const t = theme();
    const given = props() ?? {};
    // A theme change repaints every picture: its colors are part of the name. The
    // redraw starts on a timer, because spawning during a render is too late for it.
    if (this.segments && this.look !== this.diagramLook() && !this.retheming) {
      this.retheming = true;
      cx.timer.after(0, (cx) => {
        this.retheming = false;
        if (this.segments) this.sketch(cx);
      });
    }
    const searching = this.findOpen && this.query.length > 0 && Boolean(this.text || this.code);
    return v_flex().id("preview-plus").min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      // Keys, from wherever the keyboard is inside this pane (`keys.json` handles
      // the same chords while the pane's own handle has it).
      .on_key_down((e, cx) => this.keys(e, cx))
      // A diagram's picture is laid out to this width, so a resize is a redraw.
      .on_size_change((size, cx) => {
        if (this.size?.width === size.width && this.size?.height === size.height) return;
        this.size = size;
        cx.notify();
      })
      .when(Boolean(this.edges), (el) => el
        .on_mouse_down("left", (e, cx) => this.edges.down(e, cx)))
      .when(Boolean(given.overlay), (el) => el.w(this.win.w).h(this.win.h).flex_none())
      .when(!given.overlay, (el) => el.size_full())
      .child(h_flex().h(42).flex_none().px(14).gap(6).items_center().border_b(1).border_color(t.border)
        .on_click((_e, cx) => this.handle.focus())
        .on_mouse_down("left", (_e, _cx) => this.edges?.claim()) // the title bar moves the window
        .when(Boolean(given.overlay), (el) => el.child(this.dots(given)))
        .child(div().font_semibold().child(this.file ? base(this.file) : "Preview"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(this.file ? folder(this.file) : ""))
        .when(this.dirty, (el) => el.child(div().text_size(11).text_color(t.accent).child("●")))
        .child(this.button(t, "pp-zoom-out", "A−", (_e, cx) => this.zoom(-1, cx)))
        .child(div().text_size(11).text_color(t.dim).child(String(this.font)))
        .child(this.button(t, "pp-zoom-in", "A+", (_e, cx) => this.zoom(1, cx)))
        .child(this.button(t, "pp-source", this.source ? "Preview" : "Source", (_e, cx) => this.toggleSource(cx), { active: this.source }))
        .when(this.source, (el) => el.child(this.button(t, "pp-save", "Save", (_e, cx) => this.save(cx), { accent: this.dirty })))
        .child(this.button(t, "pp-find", "Find", (_e, cx) => this.openFind(cx), { active: this.findOpen }))
        .child(this.button(t, "pp-folder", "Folder", (_e, cx) => this.openFolder(cx))))
      .when(this.findOpen, (el) => el.child(h_flex().h(36).flex_none().px(14).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).h(26).px(8).flex().items_center().rounded(6).border_1().border_color(t.border)
          .child(Input.new(this.findInput).h_full().text_size(12).text_color(t.foreground)))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(this.tally()))
        .child(this.button(t, "pp-find-prev", "‹", (_e, cx) => this.step(-1, cx)))
        .child(this.button(t, "pp-find-next", "›", (_e, cx) => this.step(1, cx)))
        .child(this.button(t, "pp-find-close", "×", (_e, cx) => this.closeFind(cx)))))
      .child(v_flex().flex_1().min_h(0).relative()
        .child(v_flex().flex_1().min_h(0)
          .when(Boolean(this.segments), (el) => el.child(this.docView(cx)))
          .when(Boolean(this.code), (el) => el.child(Editor.new(this.code).flex_1().min_h(0)))
          .when(!this.text && !this.code, (el) => el.child(div().p(14).text_color(t.dim).child(this.error || "Loading file…"))))
        // The hits cover the page rather than replace it: an Editor keeps its
        // buffer and its keyboard, and closing the bar gives the page back as it was.
        .when(Boolean(searching), (el) => el.child(this.hitsOverlay(t, cx))))
      .when(Boolean(this.edges), (el) => el.children(this.edges.handles({ dim: t.dim, bg: t.popover, border: t.border, font: settings().font_family })));
  }
}
