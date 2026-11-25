// The unread panel: Herdr's right side, next to Files and Changes.
//
// It is a view onto the preview queue the `open` shim writes
// (`~/.cache/herdr-open/queue.json`, newest last) plus the reading progress the
// preview-plus tab keeps in `shared("preview-plus.progress")`. A row is one file:
// its unread dot, its name, the line it was left on, and a bar of how far in the
// reader is. Clicking a row hands the file to the shim, which writes the request,
// appends the queue and shows (or opens) the preview-plus tab — the panel never
// opens a tab itself, so the two cannot disagree about which file is showing.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, exec, home, panes, readTextFile, run, theme, writeTextFile } from "herdr";
import {
  ago, extensionOf, groups, markAllRead, progressFor, requestFile, rowMeta, shortName, splitQueue,
} from "./queue.js";

const STATE = `${home()}/.cache/herdr-open`;
const QUEUE = `${STATE}/queue.json`;
const REQUEST = `${STATE}/request.json`;
const SHIM = `${home()}/.local/bin/open`;
// Written by the preview-plus tab (a file, not shared state: no mod re-renders).
const PROGRESS = `${home()}/.cache/preview-plus/progress.json`;
// Tourist writes this: one row per terminal tab that has a tour (see mods/tourist/tours.js).
const TOURS = () => `${appHome()}/data/tourist/tours.json`;
const REFRESH_MS = 1500; // the queue and the progress both move in seconds, not frames

export default class Unread extends View {
  files = []; // [{ file, at }] the queue, newest last
  store = {}; // absolute path → { block, ratio, line, snippet, at, opened }
  progressText = null; // the progress file as last read (writeTextFile's compare-and-swap)
  seen = ""; // the three files' text as last painted, so an idle poll repaints nothing
  active = null; // the file the preview tab shows
  tours = []; // the tours Tourist saved per tab (tours.json): one row per tab
  loading = true;
  error = "";
  width = 320; // the row's bar, in points, from the panel's own width
  progressTask = null;

  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.refresh(cx);
    this.progressTask = cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  close() {
    // A closed or reloaded panel keeps no timer behind it.
    try { this.progressTask?.cancel?.(); } catch {}
    this.progressTask = null;
  }

  async refresh(cx) {
    try {
      const [queue, request, progress, tours] = await Promise.all([
        readTextFile(QUEUE).catch(() => null),
        readTextFile(REQUEST).catch(() => null),
        readTextFile(PROGRESS).catch(() => null),
        readTextFile(TOURS()).catch(() => null),
      ]);
      try {
        const rows = JSON.parse(tours ?? "[]");
        // A row for a tab that is gone (closed) has nowhere to go: keep it out of the list.
        const live = new Set(panes().map(p => p.tab));
        this.tours = Array.isArray(rows) ? rows.filter(r => r?.tab && live.has(r.tab)) : [];
      } catch { this.tours = []; }
      this.files = splitQueue(queue);
      this.active = requestFile(request);
      try { this.store = JSON.parse(progress ?? "{}") ?? {}; } catch { this.store = {}; }
      this.progressText = progress;
      this.error = "";
      const seen = `${queue ?? ""}\u0000${request ?? ""}\u0000${progress ?? ""}\u0000${tours ?? ""}`;
      if (seen === this.seen) return; // nothing moved: an idle poll repaints nothing
      this.seen = seen;
    } catch (error) {
      this.error = String(error?.message ?? error);
      cx.notify();
    }
    this.loading = false;
    cx.notify();
  }

  // The shim owns the request file and the tab: it writes the click, appends the
  // queue and shows the preview tab (opening one if the last is gone).
  open(file, cx) {
    this.error = "";
    exec(SHIM, [file], { timeout: 15000 }).catch((error) => {
      this.error = String(error?.message ?? error);
      cx.notify();
    });
  }

  async markAll(cx) {
    const next = markAllRead(this.store, this.files, this.active, Date.now());
    const text = JSON.stringify(next);
    try {
      await writeTextFile(PROGRESS, text, this.progressText);
      this.store = next;
      this.progressText = text;
      this.error = "";
    } catch (error) {
      // The preview tab wrote first: re-read and let the next click try again.
      this.error = `保存失败，重试即可：${error?.message ?? error}`;
    }
    cx.notify();
  }

  head(t, count, cx) {
    return h_flex().flex_none().items_center().justify_between().px(12).pt(10).pb(6)
      .child(h_flex().gap(5).items_center()
        .child(div().text_size(11).text_color(t.dim).child("未读"))
        .child(div().text_size(11).font_semibold().text_color(t.foreground).child(String(count))))
      .when(count > 0, (el) => el.child(div().id("unread-all").px(6).py(2).rounded(4)
        .text_size(10).text_color(t.ansi4).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.markAll(cx))
        .child("全部已读")));
  }

  groupHead(t, label, count) {
    return h_flex().flex_none().items_center().gap(5).px(12).pt(6).pb(4)
      .child(div().text_size(10).text_color(t.dim).child(label))
      .child(div().text_size(10).font_semibold().text_color(t.muted).child(String(count)));
  }

  /** The chip that says what a row is: a previewed file, or a tour. */
  kindTag(t, text) {
    return div().flex_none().px(4).rounded(3).bg(t.raised).text_size(9).text_color(t.dim).child(text);
  }

  /** A tour Tourist saved for a tab: clicking it goes back to that tab. */
  tourRow(t, tour, now) {
    const total = Number(tour.total) || 0, at = Number(tour.idx) || 0, done = total > 0 && at + 1 >= total;
    return v_flex().id(`tour-${tour.tab}`).w_full().gap(3).py(7).pl(10).pr(8).rounded(7)
      .border_l(2).border_color(done ? t.surface : t.ansi4)
      .hover((s) => s.bg(t.hover)).cursor_pointer()
      .on_click((_e, cx) => { run("tab.select", { id: tour.tab }); cx.notify(); })
      .child(h_flex().items_center().gap(6).min_w(0)
        .child(this.kindTag(t, "导览"))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(done ? t.muted : t.foreground).child(tour.title || "导览"))
        .child(div().flex_none().text_size(9).text_color(t.dim).child(total ? `${Math.min(at + 1, total)}/${total}` : "")))
      .child(div().pl(12).text_size(10).text_color(t.dim)
        .child([tour.subject ? String(tour.subject) : "", total ? `停在第 ${Math.min(at + 1, total)} 站` : "", ago(now, Date.parse(tour.at))].filter(Boolean).join(" · ")));
  }

  row(t, entry, store, now, cx) {
    const rec = progressFor(store, entry.file);
    const on = entry.file === this.active;
    return v_flex().id(`unread-${entry.file}`).w_full().gap(3).py(7).pl(10).pr(8).rounded(7)
      .border_l(2).border_color(on ? t.ansi4 : t.surface)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover)).cursor_pointer()
      .on_click((_e, cx) => this.open(entry.file, cx))
      .child(h_flex().items_center().gap(6).min_w(0)
        .child(div().w(6).h(6).flex_none().rounded(6).bg(rec.opened ? t.border : t.ansi4))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5)
          .text_color(rec.opened ? t.muted : t.foreground).child(shortName(entry.file)))
        .child(div().flex_none().text_size(9).text_color(t.dim).child(`.${extensionOf(entry.file) || "txt"}`)))
      .child(h_flex().items_center().gap(4).pl(12).text_size(10).text_color(t.dim)
        .child(this.kindTag(t, "文件"))
        .child(div().child(rowMeta(store, entry.file, now))))
      .child(h_flex().pl(12).pt(2)
        .child(div().h(2).w(this.width).rounded(2).bg(t.border)
          .child(div().h(2).w(Math.round(this.width * rec.ratio)).rounded(2).bg(t.ansi4))));
  }

  render(cx) {
    const t = theme();
    const store = this.store ?? {};
    const { unread, read } = groups(store, this.files);
    const now = Date.now();
    const row = (entry) => this.row(t, entry, store, now, cx);
    return v_flex().id("unread-panel").size_full().min_h(0)
      .bg(t.surface).text_color(t.foreground).text_size(12)
      .on_size_change((size, cx) => {
        const width = Math.max(120, Math.round(size.width) - 36);
        if (width === this.width) return;
        this.width = width;
        cx.notify();
      })
      .child(this.head(t, unread.length, cx))
      .child(v_flex().id("unread-scroll").flex_1().min_h(0).overflow_y_scrollbar()
        .when(this.tours.length > 0, (el) => el
          .child(this.groupHead(t, "导览", this.tours.length))
          .child(v_flex().px(8).children(this.tours.map((tour) => this.tourRow(t, tour, now)))))
        .when(!this.files.length, (el) => el.child(div().px(12).py(16).text_size(11).text_color(t.dim)
          .child(this.loading ? "Reading the preview queue…" : "还没有预览过的文件：⌘ 点击文件链接开始。")))
        .child(v_flex().px(8).pb(6).children(unread.map(row)))
        .when(read.length > 0, (el) => el.child(this.groupHead(t, "已读", read.length)))
        .child(v_flex().px(8).pb(8).children(read.map(row))))
      .child(h_flex().flex_none().justify_between().gap(6).px(12).py(7)
        .border_t(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(this.error ? t.ansi1 : t.dim)
          .child(this.error || "点击文件打开预览 · 点击导览回到那个 tab"))
        .child(div().text_size(10).text_color(t.dim).child("进度随预览保存")));
  }
}
