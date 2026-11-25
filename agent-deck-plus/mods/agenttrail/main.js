// Agenttrail: the tickets of the repo the focused terminal is in, drawn as a graph.
// Wayfinder maps and to-tickets slates from .wayfinder/ and .scratch/ become cards in
// columns by what blocks them; each card carries its type, its stage, and its checklist.
// Summoned with cmd-shift-m (mod.json's overlay), expandable to a whole tab.
// Read-only: it reads markdown and writes nothing.

import { View, div, svg, image, PathBuilder } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { closeOverlay, exec, focused, home, layout, nextCommand, notify, openOverlay, panes, pickFolder, props, readTextFile, run, settings, setShared, shared, spaces, theme, watchFolder, window as appWindow } from "herdr";
import { Feed, POLL_MS, focusFolder, norm, repoName, stageWord } from "./trail.js";
import { FLOW_PERIOD, boardEdges, boardLayout, chainOf, edgeNear, flowDashes, flowTrack, hostOf, kids, liveCard, openingCard, otherEnd, statusLabel, touched, waysFrom } from "./graph.js";
import { Resize } from "./resize.js";

const MOD = "agenttrail";
const ASSET = `mods/${MOD}`;
const TAB = "Agenttrail"; // the expanded tab's name, how a docked copy finds it again
const VIEW = `${MOD}.view`; // shared: the view handed between overlay and its tab
const FOLDER = `${MOD}.folder`; // shared: the last terminal folder, for a copy that has focus itself
const HOME = `${MOD}.home`; // shared: the last folder that had tickets, so a terminal elsewhere still shows them
const PREVIEW_KEY = `${MOD}.preview`; // a floating ticket window (preview-plus) per file: its name is <this>.<path>
const OPEN_PREVIEWS = "preview-plus.open"; // shared, written by preview-plus: each open window's overlay id → { file, win, editing }
// Herdr fits a window to its content when it was opened without a width and height, and
// keeps fitting it as the content changes. So the board's size is the mod's own: the dot
// and the edges set it, and the window follows within a frame, live.
const WIN_KEY = `${MOD}.window`; // shared: the size the board's window was last given
const WIN_DEFAULT = { w: 1240, h: 900 }; // a window opened without a size is its content's
// A window bigger than the screen gets pushed back into it by Herdr, which moves the
// corner out from under the pointer mid-drag. Staying inside the screen avoids that.
const screen = () => {
  const v = window.viewport_size();
  return { w: v?.width || 1920, h: v?.height || 1080 };
};
const MIN_W = 360, MIN_H = 300;
const MAX_W = 2600, MAX_H = 1800;
const NARROW = 560; // below this the whole graph is unreadable, so open on one card
const AWAY_H = 30;
const SANS = "Geist";
const MONO = "Geist Mono";
const DOT = 24; // the background dot spacing: the dots slide with a pan and never scale
const MIN_ZOOM = 0.1, MAX_ZOOM = 3; // an endless canvas: far out and far in, no page to fit
// A trackpad pinch is only a runtime event since Herdr's on_pinch (PR #788); an older
// build's elements have no such method, so the canvas asks once and keeps working there.
const CAN_PINCH = typeof div().on_pinch === "function";
// Herdr kills a render at 50 ms and never calls it again, so a slow frame must shed
// detail rather than finish. Past this, task rows stop being drawn for that frame.
const RENDER_BUDGET_MS = 28;
// A clicked ticket lights its chain: the rest of the board fades to this, and the chain's
// edges carry dashes that move FLOW_STEP pixels every FLOW_MS (about 24 px a second).
const OFF_CHAIN = 0.28;
const FLOW_MS = 60, FLOW_STEP = 1.5;

// Every colour comes from the app's theme, so the graph follows the window's look:
// surfaces from the card colours, kinds from the ANSI set, status from the agent colours.
const alpha = (hex, a) => (/^#[0-9a-f]{6}$/i.test(String(hex)) ? `${hex}${a}` : hex);

function palette() {
  const t = theme();
  const light = settings()?.dark === false;
  return {
    bg: t.canvas, // behind the cards
    surface: t.surface,
    card: t.surface,
    cardHover: t.hover,
    cardLive: t.selected,
    raised: t.raised,
    overlay: t.popover,
    hover: t.hover,
    line: t.border,
    text: t.foreground,
    soft: t.foreground,
    dim: t.muted,
    faint: t.dim,
    accent: t.accent,
    accentText: t.accent_foreground,
    danger: t.blocked,
    success: t.done,
    done: t.done,
    onDone: light ? t.background : "#ffffff",
    completeText: t.done,
    completeBg: alpha(t.done, "26"),
    dot: alpha(t.border, "80"),
    // The line someone picks is the one thing on the board that must never be missed, so it
    // takes a violet of its own rather than a slot the ticket kinds already use. Fixed, like
    // the window's dots: it has to stay loud on a dark canvas and on a light one.
    way: "#a78bfa",
    wayPending: "#c4b5fd", // the line the keyboard is on, not yet taken
    key: [t.canvas, t.surface, t.border, t.background, t.accent].join("|"), // palettes change with the theme
    types: { grilling: t.ansi3, research: t.ansi4, prototype: t.ansi5, task: t.ansi6, ticket: t.muted },
  };
}

const lit = () => settings()?.dark === false;

// A window opened with no size is as big as its content: this is that size, in pixels.
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
const shortPath = (p) => { const h = home(); return h && p?.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p ?? ""; };
const hasCards = (b) => Boolean(b?.plan.some((n) => n.level === "component"));
const typeColor = (c, type) => c.types[String(type ?? "").toLowerCase()] ?? c.faint;

// The only folders this mod will ever delete: one slate, never a repo or a parent.
const slateDir = (dir) => /\/\.wayfinder\/maps\/[^/]+$/.test(norm(dir)) || /\/\.scratch\/[^/]+$/.test(norm(dir));
const TYPES = { grilling: "讨论", research: "调研", prototype: "原型", task: "任务", ticket: "票" };
const typeName = (type) => TYPES[String(type ?? "").toLowerCase()] ?? String(type ?? "").toUpperCase();

export default class Agenttrail extends View {
  init(_props, cx) {
    const p = props() ?? {};
    if (p.confirmDelete) { // the dialog that asks before a slate goes
      this.handle = cx.focus_handle();
      this.handle.focus();
      return;
    }
    this.expanded = Boolean(p.expanded);
    this.from = p.from ?? null; // the tab an expanded copy goes back to
    this.fixed = typeof p.folder === "string" && p.folder ? p.folder : null; // a folder to show, instead of the focused terminal's
    // The canvas takes the keyboard itself: the zoom chords are bound in keys.json's
    // `mod:agenttrail` section, which only matches while this mod holds focus.
    this.handle = cx.focus_handle();
    cx.timer.after(80, () => { try { this.handle.focus(); } catch {} });
    this.size = null;
    this.zoom = 1;
    this.minZoom = MIN_ZOOM;
    this.pan = { x: 0, y: 0 };
    this.placed = false;
    this.auto = true; // no one has moved this view yet, so a narrow one follows live work
    this.pending = null;
    this.seenView = this.expanded ? null : shared(VIEW)?.seq ?? null; // a new tab takes the view that opened it
    this.ui = { open: new Set(), closed: new Set() };
    this.press = null;
    this.selected = null; // the clicked ticket whose chain is lit
    this.chain = null; // that chain's ticket ids, or null when nothing is lit
    this.route = null; // the way picked through the chain: {anchor, hops}
    this.cand = null; // the line the keyboard is on, as {from, to}
    this.phase = 0; // how far the chain's dashes have moved, in pixels, within one period
    this.win = windowSize(); // this copy's window size, which the window follows
    this.edges = props()?.overlay ? new Resize({ // a tab has a pane's edges instead
      get: () => this.win,
      set: (w, h) => {
        const s = clampSize(w, h);
        if (s.w === this.win.w && s.h === this.win.h) return false;
        this.win = s;
        return true;
      },
      done: () => setShared(WIN_KEY, { ...this.win }), // the next copy opens at this size
    }) : null;
    this.big = null; // the size the green dot grew from, so a second press restores it
    this.previews = new Map(); // ticket file → overlay id, for the windows this copy opened, the last one on top
    this.stats = { renders: 0, totalMs: 0, maxMs: 0, moves: 0, wheels: 0, pinches: 0, worstNarrow: 0, worstFull: 0 };
    this.feed = new Feed({ exec: (cmd, args, opt) => exec(cmd, args, opt), read: (path) => readTextFile(path), folder: () => this.here() });
    this.feed.home = shared(HOME) ?? null;
    cx.spawn(async (cx) => {
      this.sleep = (ms) => cx.sleep(ms);
      for (;;) {
        if (!this.feed.home && shared(HOME)) this.feed.home = shared(HOME); // another copy found tickets first
        const changed = await this.feed.tick().catch(() => false);
        if (this.feed.at && this.feed.at !== shared(FOLDER)) setShared(FOLDER, this.feed.at);
        if ((this.feed.home ?? null) !== (shared(HOME) ?? null)) setShared(HOME, this.feed.home ?? null);
        if (changed) this.shown();
        // Ages ("13s") move with the clock, so a board with recent work redraws at the poll rate.
        if (changed || this.isLive()) cx.notify();
        await Promise.race([cx.sleep(POLL_MS), this.watch(), new Promise((wake) => { this.wake = wake; })]);
      }
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "zoom-in") this.nudge(1.18);
        else if (command === "zoom-out") this.nudge(0.85);
        else if (command === "fit") { this.auto = false; this.fit(); }
        else if (command === "live") this.goLive();
        // Sent to every shown copy, so each acts only where the word applies to it.
        else if (command === "expand") { if (!this.isExpanded(this.host())) this.toggleSize(); }
        else if (command === "collapse") { if (this.isExpanded(this.host())) this.toggleSize(); }
        else continue;
        cx.notify();
      }
    });
    // Only while a chain is lit: each step redraws, so an idle board costs nothing.
    cx.spawn(async (cx) => {
      for (;;) {
        if (!this.chain) await new Promise((wake) => { this.flowWake = wake; });
        await cx.sleep(FLOW_MS);
        if (!this.chain) continue;
        this.phase = (this.phase + FLOW_STEP) % FLOW_PERIOD;
        cx.notify();
      }
    });
  }

  // Changes under .scratch wake the loop: a ticket written by an agent shows at once.
  // Resolves at the poll rate when there is nothing to watch.
  watch() {
    const repo = this.feed.state.repo;
    if (!repo) return this.sleep(POLL_MS);
    return watchFolder(`${repo}/.scratch`).catch(() => this.sleep(POLL_MS)).then(() => watchFolder(`${repo}/.wayfinder`).catch(() => null));
  }

  // Render runs on every focus change, so this is the follow: no polling of Herdr's data.
  here() {
    return this.fixed ?? focusFolder(focused(), spaces(), shared(FOLDER) ?? null);
  }

  // A different slate is a different world: its cards start fresh, not at the last one's zoom.
  shown() {
    const key = `${this.feed.state.repo}|${this.feed.state.slug}`;
    if (key !== this.mapKey) {
      this.mapKey = key;
      this.ui = { open: new Set(), closed: new Set() };
      Object.assign(this, { placed: false, auto: true, zoom: 1, selected: null, route: null, cand: null });
    }
    this.reshape();
  }

  isLive() {
    const b = this.feed.board;
    return Boolean(b && (b.plan.some((n) => n.level === "component" && n.touchedAt && Date.now() - n.touchedAt < 120000) || b.plan.some((n) => n.level === "component" && n.status === "active")));
  }

  // Everything that does not depend on pan: done again only when the board or an open
  // card changes, never on a drag or a zoom.
  reshape() {
    const b = this.feed.board;
    this.geo = null;
    this.edgeCache = null;
    // The lit chain is worked out again with the board, so a poll that adds or removes a
    // ticket or an edge keeps it right; a ticket that is gone takes its light with it.
    if (this.selected && !b?.plan.some((n) => n.id === this.selected && n.level === "component")) this.selected = null;
    this.chain = this.selected ? chainOf(b, this.selected) : null;
    if (this.chain) this.flowWake?.();
    if (!hasCards(b)) return;
    const now = Date.now();
    const L = boardLayout(b, this.ui, now);
    this.geo = { L, ...boardEdges(b, L), bounds: { w: L.width, h: L.height } };
    this.keepRoute();
    if (!this.placed) this.place();
    else if (this.auto && this.narrow()) { const id = openingCard(b, now); if (id) this.focusCard(id); }
  }

  // Lights a ticket's chain, or none with null. A new anchor starts a new way through it.
  select(id) {
    this.selected = id;
    this.route = id ? { anchor: id, hops: [] } : null;
    this.cand = null;
    this.reshape();
  }

  // ---- a way through the chain, one picked line at a time.

  // Where the route stands now: its last hop's far end, else the ticket it started on.
  routeTip() {
    const r = this.route;
    if (!r) return null;
    return r.hops.length ? r.hops[r.hops.length - 1].node : r.anchor;
  }

  // The lines the next step can take, in reading order.
  ways() {
    const tip = this.routeTip();
    return tip && this.geo ? waysFrom(this.geo, tip) : [];
  }

  // The ways on from the tip, ignoring the ones that lead back: what a bare arrow takes.
  ahead() {
    const tip = this.routeTip();
    return this.ways().filter((e) => e.from === tip);
  }

  // The ways back from the tip: the lines that lead into it.
  behind() {
    const tip = this.routeTip();
    return this.ways().filter((e) => e.to === tip);
  }

  // The line the keyboard is on, resolved against this frame's edges.
  candEdge() {
    if (!this.cand) return null;
    return this.ways().find((e) => e.from === this.cand.from && e.to === this.cand.to) ?? null;
  }

  // Takes one line: the tip moves to its far end and the view follows it there. A line that
  // does not meet the tip starts a new way from that line's own tail.
  take(edge) {
    if (!edge) return false;
    let tip = this.routeTip();
    if (tip == null || (edge.from !== tip && edge.to !== tip)) {
      this.selected = edge.from;
      this.route = { anchor: edge.from, hops: [] };
      this.cand = null;
      this.reshape();
      tip = edge.from;
      if (!this.geo) return false;
    }
    const node = otherEnd(edge, tip);
    this.route.hops.push({ from: edge.from, to: edge.to, node, back: node === edge.from });
    this.cand = null;
    this.auto = false;
    this.focusCard(this.routeTip());
    return true;
  }

  // One step along the way: `dir` 1 goes on, -1 goes back. A step in the opposite direction
  // to the last one is given back rather than taken again, so the arrows walk the graph both
  // ways and undo each other instead of undoing themselves. The view follows every step, so
  // the node the tip moved to is always on screen.
  step(dir) {
    const last = this.route?.hops.length ? this.route.hops[this.route.hops.length - 1] : null;
    if (last && (dir > 0 ? last.back : !last.back)) {
      this.route.hops.pop();
      this.cand = null;
      this.auto = false;
      this.focusCard(this.routeTip());
      return true;
    }
    const tip = this.routeTip();
    const cand = this.candEdge();
    const pending = cand && (dir > 0 ? cand.from === tip : cand.to === tip) ? cand : null;
    const edge = pending ?? (dir > 0 ? this.ahead()[0] : this.behind()[0]);
    return edge ? this.take(edge) : false;
  }

  // Cancels the last hop, whichever way it went: what the button means by undo, and the only
  // way to give back a step that walked backwards.
  drop() {
    if (!this.route?.hops.length) return false;
    this.route.hops.pop();
    this.cand = null;
    this.auto = false;
    this.focusCard(this.routeTip());
    return true;
  }

  // Puts the current ticket in view without deciding anything: the route's tip, else the
  // lit ticket, else where work actually is.
  locate() {
    const b = this.feed.board;
    const id = this.routeTip() ?? this.selected ?? liveCard(b, Date.now()) ?? b?.effort?.current;
    if (!id || !this.geo || !this.size) return false;
    this.auto = false;
    if (this.zoom < 0.6) this.focusCard(id);
    else this.centre(id);
    return true;
  }

  // A poll can add or remove tickets: a route keeps the hops that still exist, in order.
  keepRoute() {
    if (!this.route || !this.geo) return;
    const has = (id) => Boolean(this.geo.L.byId[id] && this.geo.L.pos[id]);
    if (!has(this.route.anchor)) {
      this.route = null;
      this.cand = null;
      return;
    }
    let tip = this.route.anchor;
    const hops = [];
    for (const hop of this.route.hops) {
      const edge = this.geo.edges.find((e) => e.from === hop.from && e.to === hop.to);
      if (!edge || (edge.from !== tip && edge.to !== tip)) break;
      const node = otherEnd(edge, tip);
      hops.push({ from: hop.from, to: hop.to, node, back: node === edge.from });
      tip = node;
    }
    this.route.hops = hops;
    if (this.cand && !this.candEdge()) this.cand = null;
  }

  // ---- a ticket's file, the slate's folder, and deleting the slate.

  // The full markdown, rendered by preview-plus in a window that stays where it is dropped.
  // One window per ticket file, named after it: reopening the same ticket brings its window
  // back into place. The double click that opens a ticket presses the board, and Herdr puts
  // the window pressed last on top, so the board would cover every file opened before. Each
  // of those still open is reopened under its name, in its place and at its size, before the
  // new one. One in source mode is left alone: a reopen is a fresh copy, and would drop its edits.
  preview(p) {
    if (!p?.path) return;
    const open = shared(OPEN_PREVIEWS) ?? {};
    for (const [path, id] of [...this.previews]) {
      const w = open[id];
      if (!w || w.file !== path) { this.previews.delete(path); continue; } // closed since
      if (path === p.path || w.editing) continue;
      this.previews.set(path, this.openPreview(path, w.win));
    }
    const was = open[this.previews.get(p.path)];
    if (was?.editing) return;
    this.previews.delete(p.path); // to the end of the order: it opens last, on top
    this.previews.set(p.path, this.openPreview(p.path, was?.win));
  }

  openPreview(path, win) {
    const key = `${PREVIEW_KEY}.${path}`;
    return openOverlay({ mod: "preview-plus", props: win ? { file: path, win } : { file: path }, kind: "window", key });
  }

  reveal(dir, cx) {
    const platform = appWindow()?.platform;
    const [cmd, args] = platform === "windows" ? ["explorer", [dir]] : platform === "macos" ? ["open", [dir]] : ["xdg-open", [dir]];
    cx.spawn(async () => {
      const r = await exec(cmd, args).catch(() => null);
      if (!r || r.code !== 0) notify({ title: "打不开这个文件夹", body: dir, level: "error" });
    });
  }

  askDelete(b) {
    openOverlay({
      mod: MOD, kind: "dialog", width: 540, height: 236,
      props: { confirmDelete: { dir: b.effort.dir, slug: b.effort.slug, files: b.effort.files, tickets: b.effort.counts.total } },
    });
  }

  remove(cx, slate = props().confirmDelete ?? {}) {
    if (!slateDir(slate.dir)) {
      notify({ title: "这不是清单目录，已拒绝删除", body: String(slate.dir ?? ""), level: "error" });
      closeOverlay(props().overlay);
      return;
    }
    cx.spawn(async () => {
      const r = await exec("rm", ["-rf", "--", slate.dir]).catch(() => null);
      closeOverlay(props().overlay);
      if (!r || r.code !== 0) notify({ title: "删除失败", body: slate.dir, level: "error" });
      else notify({ title: "清单已删除", body: `${slate.slug} · ${slate.dir}`, level: "success" });
    });
  }

  // ---- where this copy lives, and moving between overlay and full size.

  host() {
    const f = focused();
    return hostOf({ layout: layout(), props: props(), panes: panes(), tab: f?.tab, focusedPane: f?.pane, mod: MOD });
  }

  isExpanded(host) {
    return host.kind === "tab" || Boolean(host.zoomed);
  }

  // Everything another copy needs to show the same thing: the world point at the middle
  // of the stage, the open cards, since those move what is below them, and the way picked.
  view() {
    const box = this.stage();
    return {
      zoom: this.zoom, x: (box.width / 2 - this.pan.x) / this.zoom, y: (box.height / 2 - this.pan.y) / this.zoom,
      auto: this.auto, open: [...this.ui.open], closed: [...this.ui.closed],
      selected: this.selected, route: this.route ? { anchor: this.route.anchor, hops: [...this.route.hops] } : null,
    };
  }

  applyView(v) {
    this.ui = { open: new Set(v.open), closed: new Set(v.closed) };
    this.selected = v.selected ?? null;
    this.route = v.route ? { anchor: v.route.anchor, hops: [...v.route.hops] } : null;
    this.cand = null;
    this.auto = false; // reshape must not follow live work before this view lands
    this.reshape();
    const box = this.stage();
    this.zoom = Math.max(this.minZoom, Math.min(MAX_ZOOM, v.zoom));
    this.pan = { x: box.width / 2 - v.x * this.zoom, y: box.height / 2 - v.y * this.zoom };
    this.auto = v.auto;
  }

  sendView(to) {
    this.seenView = Date.now();
    setShared(VIEW, { ...this.view(), to, seq: this.seenView });
  }

  takeView() {
    const v = shared(VIEW);
    if (!v || v.seq === this.seenView) return;
    this.seenView = v.seq;
    if (v.to !== (this.expanded ? "tab" : "dock") || (!this.expanded && this.host().kind !== "block")) return;
    this.pending = v;
    this.placed = false;
    this.place();
  }

  toggleSize() {
    const host = this.host();
    const f = focused();
    if (host.kind === "overlay") { // the summoned copy hands over to a whole tab
      closeOverlay(props().overlay);
      return run("tab.new", { name: TAB, mod: MOD, props: { expanded: true, from: f?.tab ?? null } });
    }
    if (host.kind === "pane") return run("pane.zoom", { pane: host.pane }); // same copy: the resize keeps the view
    if (host.kind === "lone") return null;
    if (host.kind === "tab") {
      this.sendView("dock");
      if (this.from && spaces().some((s) => s.tabs.some((t) => t.id === this.from))) run("tab.select", { id: this.from });
      return run("tab.close", { id: f.tab });
    }
    this.sendView("tab");
    const tabs = spaces().find((s) => s.id === f?.space)?.tabs ?? [];
    const open = tabs.find((t) => t.name === TAB && t.panes === 1 && panes().some((p) => p.tab === t.id && p.mod === MOD));
    if (open) return run("tab.select", { id: open.id });
    return run("tab.new", { name: TAB, mod: MOD, props: { ...props(), expanded: true, from: f?.tab ?? null } });
  }

  // ---- what the view shows.

  narrow() {
    return (this.size?.width ?? 0) < NARROW;
  }

  // First placement: a handed-over view, else the current ticket at 100%, centered.
  place() {
    if (!this.geo || !this.size) return;
    this.placed = true;
    if (this.pending) {
      const v = this.pending;
      this.pending = null;
      this.applyView(v);
      return;
    }
    this.zoom = 1;
    this.centre(openingCard(this.feed.board, Date.now()));
  }

  // Puts one card's middle in the middle of the stage; with no card, the whole content's.
  centre(id) {
    const box = this.stage();
    const pos = id ? this.geo.L.pos[id] : null;
    const { w, h } = this.geo.bounds;
    if (!pos) {
      this.pan = { x: (box.width - w * this.zoom) / 2, y: (box.height - h * this.zoom) / 2 };
      return;
    }
    this.pan = {
      x: box.width / 2 - (pos.nodeX + pos.nodeW / 2) * this.zoom,
      y: box.height / 2 - (pos.nodeY + pos.nodeH / 2) * this.zoom,
    };
  }

  // A card at a readable size: as wide as the panel allows, its top clear of the tools.
  focusCard(id, at = null) {
    const box = this.stage();
    this.zoom = at ?? Math.max(this.minZoom, Math.min(1, (box.width - 32) / 400));
    const pos = this.geo.L.pos[id];
    if (!pos) return;
    const z = this.zoom;
    const top = Math.max(60, (box.height - pos.h * z) / 2);
    this.pan = { x: box.width / 2 - (pos.nodeX + pos.nodeW / 2) * z, y: top - pos.nodeY * z };
  }

  goLive() {
    const b = this.feed.board;
    const id = b && (liveCard(b, Date.now()) ?? b.effort?.current);
    if (!id || !this.geo || !this.size) return;
    this.auto = true;
    this.focusCard(id);
  }

  nudge(factor) {
    this.auto = false;
    this.zoomBy(factor);
  }

  // Every card on screen at once; the canvas goes on past all of it.
  fit() {
    if (!this.geo || !this.size) return;
    const { w, h } = this.geo.bounds;
    const box = this.stage();
    const margin = this.narrow() ? 32 : 96;
    const best = Math.min(2, (box.width - margin) / w, (box.height - margin) / h);
    this.zoom = Math.max(this.minZoom, best);
    this.pan = { x: (box.width - w * this.zoom) / 2, y: (box.height - h * this.zoom) / 2 };
  }

  stage() {
    return { width: this.size?.width ?? 0, height: Math.max(0, (this.size?.height ?? 0) - this.headH()) };
  }

  headH() {
    return (this.narrow() ? 44 : 64)
      + (this.feed.state.away ? AWAY_H : 0)
      + (this.feed.state.efforts.length > 1 ? AWAY_H : 0);
  }

  // The stage changed under a view that is already placed. The canvas keeps its top-left
  // where it is: moving it by half the change made every resize step slide the cards out
  // from under the pointer.
  resized(size) {
    this.size = size;
    if (!this.placed) return this.place();
    if (this.auto && this.narrow() && this.feed.board) {
      const id = openingCard(this.feed.board, Date.now());
      if (id) this.focusCard(id);
    }
  }

  // Around the middle of the stage: the canvas is moved by hand, so the centre is the anchor.
  zoomBy(factor) {
    this.zoomTo(this.zoom * factor);
  }

  // The same anchor, to an exact zoom: the toolbar's 100% is this, not a nudge.
  zoomTo(target) {
    const box = this.stage();
    this.zoomAt(target, { x: box.width / 2, y: box.height / 2 });
  }

  // To an exact zoom around a point: the world point under it stays under it, which is
  // what makes a trackpad pinch feel attached to the fingers.
  zoomAt(target, point) {
    const next = Math.max(this.minZoom, Math.min(MAX_ZOOM, target));
    const wx = (point.x - this.pan.x) / this.zoom, wy = (point.y - this.pan.y) / this.zoom;
    this.pan = { x: point.x - wx * next, y: point.y - wy * next };
    this.zoom = next;
  }

  setOpen(p, open) {
    this.auto = false;
    if (open) { this.ui.closed.delete(p.id); this.ui.open.add(p.id); }
    else { this.ui.open.delete(p.id); this.ui.closed.add(p.id); }
    this.reshape();
  }

  toggle(p) {
    this.setOpen(p, !(this.geo.L.pos[p.id].h > 128));
  }

  // ---- connectors: real GPU paths, built at this zoom and only moved by a pan.

  stroke(c, e) {
    const z = this.zoom;
    const { x1, y1, ax, ay, bx, by, x2, y2 } = e.curve;
    const [width, dash, color] = e.kind === "active" ? [1.5, [5, 8], c.accent] : [1.5, null, c.line];
    let path = PathBuilder.stroke(width);
    if (dash) path = path.dash_array(dash);
    path = path.move_to(x1 * z, y1 * z).cubic_bezier_to(x2 * z, y2 * z, ax * z, ay * z, bx * z, by * z).build();
    return { path, color };
  }

  // With a chain lit, the edges outside it fade and the chain's own are drawn twice: a
  // faint line from the cache, and its moving dashes, cut again on every flow step.
  edgeLayer(c) {
    const chain = this.chain;
    const lit = (e) => Boolean(chain?.has(e.from)); // a chain is a connected group: one end in it means both
    const hops = this.route?.hops ?? [];
    const onWay = (e) => hops.some((h) => h.from === e.from && h.to === e.to);
    const cand = this.candEdge();
    const key = `${this.zoom}|${c.key}|${chain ? [...chain].sort().join(",") : ""}|${hops.map((h) => `${h.from}>${h.to}`).join(",")}|${cand ? `${cand.from}>${cand.to}` : ""}`;
    if (this.edgeCache?.key !== key) {
      const z = this.zoom;
      const lines = this.geo.edges.map((e) => (lit(e)
        ? { ...this.chainStroke(c, e), fade: 0.35 }
        : { ...this.stroke(c, e), fade: chain ? OFF_CHAIN : null }));
      const heads = this.geo.edges.filter((e) => e.arrow).map((e) => {
        const { x2, y2 } = e.curve;
        const s = 7 * 1.5; // the page's marker: 7 units of a 1.5 stroke
        const path = PathBuilder.fill().add_polygon([[(x2 - s) * z, (y2 - s / 2) * z], [x2 * z, y2 * z], [(x2 - s) * z, (y2 + s / 2) * z]], true).build();
        return lit(e) ? { path, color: c.accent, fade: null } : { path, color: c.line, fade: chain ? OFF_CHAIN : null };
      });
      const ways = this.geo.edges.filter(onWay).map((e) => this.wayStroke(c, e, false));
      const pending = cand ? [this.wayStroke(c, cand, true)] : [];
      const tracks = this.geo.edges.filter(lit).map((e) => flowTrack(e.curve, z));
      this.edgeCache = { key, paths: [...lines, ...heads, ...ways, ...pending], tracks };
    }
    const { w, h } = this.geo.bounds;
    const layer = (p) => window.paint_path(p.path, p.color).absolute().left(0).top(0).w(w * this.zoom).h(h * this.zoom)
      .when(p.fade != null, (el) => el.opacity(p.fade));
    const flow = this.flow(c);
    return div().absolute().left(this.pan.x).top(this.pan.y).w(1).h(1).children([...this.edgeCache.paths, ...flow].map(layer));
  }

  chainStroke(c, e) {
    const z = this.zoom;
    const { x1, y1, ax, ay, bx, by, x2, y2 } = e.curve;
    const path = PathBuilder.stroke(2).move_to(x1 * z, y1 * z).cubic_bezier_to(x2 * z, y2 * z, ax * z, ay * z, bx * z, by * z).build();
    return { path, color: c.accent };
  }

  // A line someone picked: violet and solid, so it reads above the chain it belongs to. The
  // keyboard's pending line is a lighter violet, dashed, so it is clear it is not taken yet.
  wayStroke(c, e, pending) {
    const z = this.zoom;
    const { x1, y1, ax, ay, bx, by, x2, y2 } = e.curve;
    let path = PathBuilder.stroke(3).move_to(x1 * z, y1 * z).cubic_bezier_to(x2 * z, y2 * z, ax * z, ay * z, bx * z, by * z);
    if (pending) path = path.dash_array([6, 5]);
    return { path: path.build(), color: pending ? c.wayPending : c.way, fade: null };
  }

  // Every dash of every lit edge in one path, so a flow step is one paint however long the chain.
  flow(c) {
    const tracks = this.edgeCache.tracks;
    if (!tracks.length) return [];
    let path = PathBuilder.stroke(2.5);
    let any = false;
    for (const track of tracks) {
      for (const run of flowDashes(track, this.phase)) {
        path = path.move_to(run[0][0], run[0][1]);
        for (let i = 1; i < run.length; i += 1) path = path.line_to(run[i][0], run[i][1]);
        any = true;
      }
    }
    return any ? [{ path: path.build(), color: c.accent, fade: null }] : [];
  }

  // The dots belong to the world, not the screen: they slide with a pan so an empty canvas
  // still shows that it moves. One path per size, slid by the pan's remainder.
  grid(c) {
    const { width, height } = this.size;
    const w = width + DOT * 2, h = height + DOT * 2;
    const key = `${w}x${h}|${c.key}`;
    if (this.gridCache?.key !== key) {
      let path = PathBuilder.stroke(2).dash_array([2, DOT - 2]);
      for (let y = 1; y < h; y += DOT) path = path.move_to(0, y).line_to(w, y);
      this.gridCache = { key, path: path.build() };
    }
    const wrap = (v) => ((v % DOT) + DOT) % DOT - DOT;
    return window.paint_path(this.gridCache.path, c.dot).absolute().left(wrap(this.pan.x)).top(wrap(this.pan.y)).w(w).h(h);
  }

  // ---- cards: every length is a world length times the zoom, since a mod has no
  // transform to scale a group with.

  text(str, { x, y, size, color, mono = false, weight = 400, right = null }) {
    const z = this.zoom;
    const el = div().absolute().top((y - size * 0.975) * z).whitespace_nowrap().text_size(size * z).line_height(`${size * 1.25 * z}px`)
      .font_family(mono ? MONO : SANS).font_weight(weight).text_color(color).child(str);
    return right == null ? el.left(x * z) : el.right(right * z);
  }

  ring(size, x, y, color, width) {
    const z = this.zoom;
    return div().absolute().left((x - size / 2) * z).top((y - size / 2) * z).w(size * z).h(size * z).rounded(size * z).border(width * z).border_color(color);
  }

  statusIcon(c, p, w) {
    const z = this.zoom, x = w - 26, y = 26;
    const disc = (color) => div().absolute().left((x - 9) * z).top((y - 9) * z).w(18 * z).h(18 * z).rounded(18 * z).bg(color).flex().items_center().justify_center();
    const mark = (color) => disc(color).text_size(12 * z).font_weight(700).font_family(SANS).text_color(color === c.accent ? c.accentText : c.onDone).child("!");
    if (p.status === "done") return [disc(c.done).child(svg(`${ASSET}/check.svg`).w(18 * z).h(18 * z).text_color(c.onDone))];
    if (p.status === "active") return [this.ring(18, x, y, c.line, 2), svg(`${ASSET}/arc-status.svg`).absolute().left((x - 11) * z).top((y - 11) * z).w(22 * z).h(22 * z).text_color(c.accent).spin(1100)];
    if (p.status === "blocked") return [mark(c.danger)];
    return [this.ring(18, x, y, c.faint, 2)];
  }

  // A ticket's lines, for a card someone opened: its checklist, else what it asks.
  detail(c, b, p, pos) {
    const z = this.zoom;
    const list = kids(b, p.id);
    const stageH = this.stage().height;
    const originY = this.pan.y + (pos.nodeY + pos.nodeH + 24) * z;
    const rows = [];
    list.forEach((task, i) => {
      const y = originY + i * 45 * z;
      const onScreen = y < stageH && y + 45 * z > 0;
      const late = Date.now() - this.t0 > RENDER_BUDGET_MS;
      if (late && onScreen) this.shed += 1;
      if (onScreen && !late) rows.push(this.row(c, i, task.status, String(i + 1), task.title));
    });
    (p.rows ?? []).forEach((r, j) => {
      const i = list.length + j;
      const y = originY + i * 45 * z;
      const late = Date.now() - this.t0 > RENDER_BUDGET_MS;
      if (y < stageH && y + 45 * z > 0 && !late) rows.push(this.row(c, i, "note", "", r.label));
    });
    const x = this.pan.x + pos.x * z, y = this.pan.y + (pos.nodeY + pos.nodeH + 24) * z;
    const cx0 = x + pos.nodeW / 2 * z;
    return [
      div().absolute().left(cx0).top(y - 24 * z).w(1).h(24 * z).bg(c.faint),
      div().id(`d-${p.id}`).absolute().left(x).top(y).w(pos.detailW * z).h(pos.detailH * z).rounded(16 * z).bg(c.surface).overflow_hidden()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .children(rows.length ? rows : [this.text("这张票还没有记录内容。", { x: 16, y: 38, size: 12, color: c.dim })]),
    ];
  }

  row(c, index, status, n, copy) {
    const z = this.zoom;
    const note = status === "note"; // a line of the ticket's own words: two lines, then cut
    return h_flex().absolute().left(0).top(index * 45 * z).w(400 * z).h(44 * z).px(8 * z).gap(8 * z).items_center()
      .child(div().w(24 * z).h(24 * z).flex().items_center().justify_center().flex_none().child(this.rowMarker(c, status, n)))
      .child(div().flex_1().min_w(0).text_size(12 * z).font_weight(500).font_family(SANS).text_color(note ? c.soft : c.text)
        .when(note, (el) => el.whitespace_normal().line_height(`${16 * z}px`).max_h(34 * z).overflow_hidden())
        .when(!note, (el) => el.truncate())
        .child(copy));
  }

  card(c, b, p, pos, now) {
    const z = this.zoom, w = pos.nodeW, h = pos.nodeH;
    const list = kids(b, p.id);
    const done = list.filter((n) => n.status === "done").length;
    const total = list.length;
    const open = pos.h > h;
    const live = touched(p, now);
    const tint = typeColor(c, p.type);
    const current = b.effort?.current === p.id;
    const onChain = Boolean(this.chain?.has(p.id));
    const edge = p.status === "blocked" ? c.danger : open || live || p.status === "active" || current || onChain ? c.accent : c.line;
    const strong = edge !== c.line;
    const pin = this.selected === p.id;
    const tip = this.routeTip() === p.id;
    const label = p.title.length > 28 ? `${p.title.slice(0, 27)}…` : p.title;
    const line = p.status === "blocked"
      ? `被 ${p.needs.join("、")} 阻塞`
      : `${total ? `${done}/${total} 项验收` : "无清单"} · ${statusLabel(p.status)}`;
    const barW = (w - 32) * z;
    const chipW = Math.max(18, typeName(p.type).length * 7.4 + 14);
    const ports = [0, w].map((x) => div().absolute().left((x - 4) * z).top((h / 2 - 4) * z).w(8 * z).h(8 * z).rounded(8 * z).bg(c.raised).border(1).border_color(c.faint));
    return div().id(`n-${p.id}`).absolute()
      .left(this.pan.x + pos.nodeX * z).top(this.pan.y + pos.nodeY * z).w(w * z).h(h * z)
      .rounded(12 * z).bg(live && p.status !== "done" ? c.cardLive : c.card).border(pin ? 2.5 : strong ? 1.5 : 1).border_color(edge).cursor_pointer()
      .hover((s) => s.bg(c.cardHover).border_color(strong ? edge : c.faint))
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        // A double click arrives as a click then another: the first one toggled the card,
        // so put it back before preview-plus opens the full file.
        if (e.click_count >= 2) {
          if (this.clicked?.id === p.id) this.setOpen(p, this.clicked.open);
          this.clicked = null;
          this.preview(p);
        } else {
          this.clicked = { id: p.id, open: pos.h > pos.nodeH };
          this.selected = p.id; // lights its chain; the toggle's reshape works the chain out
          this.route = { anchor: p.id, hops: [] }; // and starts a new way through it
          this.cand = null;
          this.toggle(p);
        }
        cx.notify();
      })
      .child(div().absolute().left(0).top(12 * z).w(3 * z).h((h - 24) * z).rounded(2 * z).bg(tint)) // the type's colour, every card
      .child(h_flex().absolute().left(16 * z).top(14 * z).h(20 * z).gap(6 * z).items_center()
        .child(div().h(20 * z).w(chipW * z).rounded(5 * z).bg(tint + "24").flex().items_center().justify_center()
          .text_size(10 * z).font_weight(700).font_family(MONO).text_color(tint).child(typeName(p.type)))
        .child(div().text_size(11 * z).font_family(MONO).font_weight(500).text_color(p.gist ? c.dim : c.faint).child(p.tech)))
      .children(this.statusIcon(c, p, w))
      .when(live && p.status !== "done", (el) => el
        .child(svg(`${ASSET}/arc-live.svg`).absolute().left((w - 41) * z).top(11 * z).w(30 * z).h(30 * z).text_color(tint).spin(1300))
        .child(this.text("编辑中", { right: 46, y: 30, size: 11, color: tint, weight: 600 })))
      .child(this.text(label, { x: 16, y: 52, size: 15, color: c.text, weight: 600 }))
      .child(this.text(line, { x: 16, y: 76, size: 12, color: p.status === "blocked" ? c.danger : c.dim }))
      .when(total > 0, (el) => el
        .child(div().absolute().left(16 * z).top(92 * z).w(barW).h(4 * z).rounded(2 * z).bg(c.hover))
        .child(div().absolute().left(16 * z).top(92 * z).w(barW * done / total).h(4 * z).rounded(2 * z).bg(p.status === "active" ? c.accent : c.soft)))
      .child(this.text(open ? "收起 ▴" : "展开 ▾", { x: 16, y: 116, size: 11, color: open ? c.accent : c.faint, mono: true, weight: 500 }))
      .when(Boolean(p.gist), (el) => el.child(this.text("已定", { right: 16, y: 116, size: 10, color: c.success, mono: true, weight: 700 })))
      .when(current, (el) => el.child(this.text(p.status === "active" ? "当前" : "下一步", { right: 16, y: 116, size: 10, color: c.accent, mono: true, weight: 700 })))
      .when(tip, (el) => el.child(div().absolute().left(0).bottom(0).w(w * z).h(3 * z).bg(c.way))) // where the way stands
      .children(ports);
  }

  rowMarker(c, status, n) {
    const z = this.zoom;
    if (status === "note") return div().w(22 * z).h(22 * z).flex().items_center().justify_center().flex_none().child(div().w(5 * z).h(5 * z).rounded(5 * z).bg(c.faint));
    if (status === "done") return div().w(22 * z).h(22 * z).rounded(22 * z).bg(c.done).flex().items_center().justify_center().flex_none().child(svg(`${ASSET}/check.svg`).w(18 * z).h(18 * z).text_color(c.onDone));
    return div().w(22 * z).h(22 * z).rounded(22 * z).border(1.5 * z).border_color(status === "active" ? c.accent : c.faint).flex().items_center().justify_center().flex_none().text_size(10 * z).font_weight(600).text_color(c.text).child(n);
  }

  // ---- overlays: fixed to the pane.

  tool(c, id, child, action, danger = false) {
    return div().id(id).w(28).h(28).flex().flex_none().items_center().justify_center().rounded(8).text_color(c.dim).text_size(16).cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()) // no window move from a button
      .hover((s) => s.bg(c.hover).text_color(danger ? c.danger : c.text)).on_click(action).child(child);
  }

  tools(c, b, now) {
    const inset = this.narrow() ? 8 : 24;
    const id = liveCard(b, now) ?? b.effort?.current;
    const lit = Boolean(this.route); // a route exists from the moment a ticket is lit
    const ways = this.ways();
    const at = ways.findIndex((w) => w.from === this.cand?.from && w.to === this.cand?.to);
    const glyph = (text, size = 16) => div().text_size(size).font_family(MONO).font_weight(600).child(text);
    const gap = () => div().w(1).h(16).mx(4).bg(c.line); // an element is used once: a factory, not a value
    return h_flex().id("tools").absolute().left(inset).top(inset).p(4).gap(4).items_center().rounded(12).border(1).border_color(c.line).bg(c.overlay).shadow_lg()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(this.tool(c, "zoom-out", glyph("−"), (_e, cx) => { this.nudge(0.85); cx.notify(); }))
      .child(this.tool(c, "zoom-100", glyph(`${Math.round(this.zoom * 100)}%`, 11), (_e, cx) => { this.auto = false; this.zoomTo(1); cx.notify(); }))
      .child(this.tool(c, "zoom-in", glyph("+"), (_e, cx) => { this.nudge(1.18); cx.notify(); }))
      .child(gap())
      .child(this.tool(c, "fit", svg(`${ASSET}/fit.svg`).w(14).h(14), (_e, cx) => { this.auto = false; this.fit(); cx.notify(); }))
      .when(Boolean(id), (el) => el.child(this.tool(c, "live", svg(`${ASSET}/live.svg`).w(14).h(14), (_e, cx) => { this.goLive(); cx.notify(); })))
      .child(gap())
      .when(lit, (el) => el.child(this.tool(c, "route-undo", glyph("↶"), (_e, cx) => { if (this.drop()) cx.notify(); })))
      .when(lit, (el) => el.child(this.tool(c, "route-reset", glyph("↺"), (_e, cx) => { this.select(null); cx.notify(); })))
      .child(this.tool(c, "route-locate", glyph("◎"), (_e, cx) => { this.locate(); cx.notify(); }))
      // Which of the lines on offer the arrows are on: without it the choice is invisible.
      .when(at >= 0, (el) => el.child(div().id("ways").h(28).px(6).flex().items_center().rounded(8).bg(c.raised)
        .text_size(11).font_family(MONO).font_weight(600).text_color(c.wayPending).child(`${at + 1}/${ways.length}`)));
  }

  // Which colour means which kind of ticket: the graph's key, at a glance.
  legend(c, b) {
    const types = b.effort?.types ?? {};
    const names = Object.keys(types).sort((a, z) => types[z] - types[a]);
    if (!names.length) return div();
    return h_flex().id("legend").absolute().left(this.narrow() ? 8 : 24).bottom(8).h(22).px(8).gap(10).items_center().rounded(8).bg(c.overlay).border(1).border_color(c.line)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .children(names.map((name) => h_flex().gap(4).items_center()
        .child(div().w(6).h(6).rounded(6).bg(typeColor(c, name)))
        .child(div().text_size(10.5).font_family(MONO).font_weight(600).text_color(c.dim).child(`${typeName(name)} ${types[name]}`))));
  }

  // What is on screen, in words, whatever the state: never a repo without its name.
  title(b) {
    const s = this.feed.state;
    if (b) return b.project;
    return s.kind === "noeffort" ? repoName(s.repo) : "Agenttrail";
  }

  subtitle(b) {
    const s = this.feed.state;
    const cur = b?.effort?.current ? b.plan.find((n) => n.id === b.effort.current) : null;
    const parts = [s.repo ? shortPath(s.repo) : "跟随聚焦的终端"];
    if (cur) parts.push(`→ ${cur.title}`);
    return parts.join(" · ");
  }

  header(c, b, now) {
    const narrow = this.narrow();
    const host = this.host();
    const e = b?.effort;
    const counts = e?.counts;
    const working = Boolean(b?.plan.some((n) => n.level === "component" && touched(n, now)));
    const stage = e?.stage ?? null;
    const dot = working ? c.success : stage === "complete" ? c.success : stage === "working" ? c.accent : c.faint;
    const chip = e ? (working ? (narrow ? `${counts.done}/${counts.total}` : `${stageWord("working")} · ${counts.done}/${counts.total}`)
      : narrow ? `${counts.done}/${counts.total}` : `${stageWord(stage)} · ${counts.done}/${counts.total}`) : null;
    return h_flex().h(narrow ? 44 : 64).px(narrow ? 12 : 24).gap(narrow ? 8 : 10).items_center().flex_none().bg(c.bg).border_b(1).border_color(c.hover)
      .on_mouse_down("left", (_e, _cx) => this.edges?.claim()) // the title bar moves the window
      .when(host.kind === "overlay", (el) => el.child(this.dots(c)))
      .child(image(`${ASSET}/mark-${lit() ? "light" : "dark"}.svg`).w(narrow ? 22 : 28).h(narrow ? 22 : 28).flex_none())
      .child(v_flex().flex_1().min_w(0).child(div().truncate().text_size(14).font_weight(600).text_color(c.text).child(this.title(b)))
        .when(!narrow, (el) => el.child(div().truncate().text_size(12).text_color(c.dim).child(this.subtitle(b)))))
      .when(Boolean(chip), (el) => el.child(h_flex().flex_none().h(24).px(8).gap(6).items_center().rounded(8).border(1).border_color(c.line).text_size(12).text_color(working || stage === "complete" ? c.success : c.dim)
        .child(div().w(6).h(6).rounded(6).bg(dot).when(working, (el2) => el2.loop("opacity", { from: 0.35, to: 1, period: 1400 })))
        .child(chip)))
      .when(Boolean(b?.effort?.dir) && !narrow, (el) => el
        .child(this.tool(c, "reveal", svg(`${ASSET}/folder.svg`).w(14).h(14), (_e, cx) => this.reveal(b.effort.dir, cx)))
        .child(this.tool(c, "delete", svg(`${ASSET}/trash.svg`).w(14).h(14), (_e, cx) => this.askDelete(b), true)));
  }

  // ---- a window's own controls: what Herdr draws for a dialog, drawn here instead,
  // since a window has no frame.

  // macOS' two: close, then size. Even a cursor knows them by place alone.
  dots(c) {
    const dot = (id, bg, action) => div().id(id).w(12).h(12).flex_none().rounded(12).bg(bg).cursor_pointer()
      .hover((s) => s.opacity(0.8)).on_click(action);
    return h_flex().id("dots").flex_none().gap(8).items_center()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()) // no window drag from a button
      .child(dot("win-close", "#ff5f57", () => closeOverlay(props().overlay)))
      .child(dot("win-size", "#28c840", (_e, cx) => { this.grow(); cx.notify(); }));
  }

  // The green dot, as a window's zoom button: a quarter bigger, or back to what it was.
  grow() {
    if (this.big) {
      const back = this.big;
      this.big = null;
      this.resize(back.w, back.h);
      return;
    }
    this.big = { ...this.win };
    const s = clampSize(this.win.w * 1.25, this.win.h * 1.25);
    this.resize(s.w, s.h);
  }

  // A window made of this mod's content follows it: setting the size here is the resize.
  resize(w, h) {
    this.win = { w, h };
    setShared(WIN_KEY, this.win);
  }

  // The terminal is somewhere with no tickets: say so, and say what is on screen instead.
  awayStrip(c) {
    const s = this.feed.state;
    return h_flex().id("away").h(AWAY_H).px(this.narrow() ? 12 : 24).gap(8).items_center().flex_none().bg(c.surface).border_b(1).border_color(c.hover).text_size(12)
      .child(div().flex_1().min_w(0).truncate().text_color(c.dim).child(`${repoName(s.away)} 没有票 · 正在显示 ${repoName(s.repo)}`))
      .child(div().id("pick").flex_none().text_color(c.accent).cursor_pointer().hover((s2) => s2.text_color(c.text)).child("浏览…")
        .on_click((_e, cx) => this.pick(cx)));
  }

  // Every slate found in this repo, so a second one is one click away.
  efforts(c) {
    const selected = this.feed.state.slug;
    return h_flex().id("efforts").h(AWAY_H).px(this.narrow() ? 12 : 24).gap(6).items_center().flex_none().bg(c.surface).border_b(1).border_color(c.hover)
      .child(div().flex_none().pr(4).text_size(10).font_family(MONO).font_weight(600).text_color(c.faint).child("清单"))
      .children(this.feed.state.efforts.map((e) => h_flex().id(`e-${e.key}`).flex_none().h(20).px(7).gap(5).rounded(6).items_center().cursor_pointer()
        .bg(e.slug === selected ? c.raised : c.surface).border(1).border_color(e.slug === selected ? c.faint : c.hover)
        .hover((s) => s.bg(c.hover))
        .on_click((_e, cx) => { this.feed.choose(e.key); this.wake?.(); cx.notify(); })
        .child(div().text_size(11).text_color(e.slug === selected ? c.text : c.dim).child(e.title))
        .child(div().text_size(10).font_family(MONO).text_color(c.faint).child(`${e.done}/${e.total}${e.map ? " · 地图" : ""}`))));
  }

  // A folder picked by hand, for when the terminal is somewhere else entirely.
  pick(cx) {
    cx.spawn(async (cx) => {
      const folder = await pickFolder({ prompt: "显示它的票" }).catch(() => null);
      if (!folder) return;
      this.feed.pin(folder);
      this.wake?.();
      cx.notify();
    });
  }

  button(c, id, text, action) {
    return div().id(id).h(32).px(12).flex().flex_none().items_center().rounded(8).border(1).border_color(c.accent).text_size(13).font_weight(600).text_color(c.accent)
      .cursor_pointer().hover((s) => s.bg(c.hover)).on_click(action).child(text);
  }

  // A repo with no tickets yet: where they would come from, and any other slate in it.
  notice(c) {
    const s = this.feed.state;
    const repo = repoName(s.repo);
    const words = {
      scanning: ["读取中…", null],
      none: ["没有聚焦的终端", "点一个终端：Agenttrail 显示它所在仓库的票。"],
      noeffort: [`${repo} 里没有票`, "这里还没有 .wayfinder 或 .scratch：/wayfinder 建地图，/to-tickets 写清单。也可以先看别的文件夹。"],
    }[s.kind] ?? ["没有可展示的内容", null];
    return v_flex().id("notice").size_full().min_h(0).p(this.narrow() ? 16 : 24).overflow_y_scrollbar()
      .child(div().text_size(s.kind === "scanning" ? 13 : 15).font_weight(s.kind === "scanning" ? 400 : 600).text_color(s.kind === "scanning" ? c.dim : c.text).child(words[0]))
      .when(Boolean(words[1]), (el) => el.child(div().mt(6).text_size(13).text_color(c.dim).child(words[1])))
      .when(s.kind === "noeffort", (el) => el.child(h_flex().mt(14).child(this.button(c, "pick", "选择文件夹…", (_e, cx) => this.pick(cx)))))
      .child(div().mt(10).text_size(12).font_family(MONO).text_color(c.faint).child(".wayfinder/maps/<slug>/{map.md,tickets/*.md} · .scratch/<slug>/{map.md,issues/*.md}"));
  }

  // A map that has no tickets yet, and what is still fog.
  charted(c, b) {
    const e = b.effort;
    const label = (text) => div().mt(20).pb(6).text_size(11).font_family(MONO).font_weight(500).text_color(c.faint).child(text);
    const line = (text) => h_flex().gap(8).text_size(12.5).text_color(c.dim).child(div().flex_none().text_color(c.faint).child("–")).child(div().flex_1().min_w(0).child(text));
    return v_flex().id("charted").size_full().min_h(0).p(this.narrow() ? 16 : 24).overflow_y_scrollbar()
      .child(v_flex().w_full().max_w(720).flex_none()
        .child(div().text_size(15).font_weight(600).text_color(c.text).child("已建图，还没有票"))
        .when(Boolean(e.destination), (el) => el.child(div().mt(6).text_size(13).text_color(c.dim).child(e.destination)))
        .when(e.fog.length > 0, (el) => el.child(label(`尚未明确 · ${e.fog.length}`)).children(e.fog.map(line)))
        .when(e.out.length > 0, (el) => el.child(label(`范围外 · ${e.out.length}`)).children(e.out.map(line))));
  }

  canvas(c, b, now) {
    const { width, height } = this.stage();
    const z = this.zoom;
    const L = this.geo.L;
    const nodes = L.phases.flatMap((p) => {
      if (Date.now() - this.t0 > RENDER_BUDGET_MS) { this.shed += 1; return []; } // a missing card beats a dead view
      const pos = L.pos[p.id];
      const x = this.pan.x + pos.x * z, y = this.pan.y + pos.y * z;
      if (x > width || y > height || x + pos.w * z < 0 || y + pos.h * z < 0) return []; // a mod pays per element, so off-screen ones go
      const shown = [this.card(c, b, p, pos, now), ...(pos.h > pos.nodeH ? this.detail(c, b, p, pos) : [])];
      return this.chain && !this.chain.has(p.id) ? shown.map((el) => el.opacity(OFF_CHAIN)) : shown;
    });
    this.parts.nodes = Date.now() - this.t0;
    const edges = this.edgeLayer(c);
    this.parts.edges = Date.now() - this.t0;
    // No page and no frame: the cards are the world, and the world goes on past them.
    return [edges, ...nodes];
  }

  // The dialog: one slate, and what goes with it.
  confirmView(c) {
    const d = props().confirmDelete ?? {};
    const button = (id, label, bg, fg, action) => div().id(id).h(30).px(13).flex().flex_none().items_center().rounded(7).bg(bg).text_color(fg).text_size(12.5).font_weight(600)
      .cursor_pointer().hover((s) => s.opacity(0.85)).on_click(action).child(label);
    return v_flex().id("confirm").size_full().p(18).gap(10).bg(c.overlay).text_color(c.text)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") closeOverlay(props().overlay);
        else if (e.key === "enter") this.remove(cx);
        else return;
        cx.stop_propagation();
      })
      .child(h_flex().child(div().flex_1().text_size(15).font_weight(600).child("删除这个清单？")).child(div().text_size(11).text_color(c.dim).child("Esc")))
      .child(div().text_size(12).font_family(MONO).text_color(c.dim).child(d.dir ?? ""))
      .child(div().text_size(12.5).text_color(c.dim).child(`${d.files ?? 0} 个文件 · ${d.tickets ?? 0} 张票 · map.md 与 research/ 都会删掉`))
      .child(h_flex().flex_1())
      .child(h_flex().justify_end().gap(8)
        .child(button("no", "取消", c.raised, c.text, () => closeOverlay(props().overlay)))
        .child(button("yes", "删除", c.danger, c.bg, (_e, cx) => this.remove(cx))));
  }

  render() {
    const given = props() ?? {};
    if (given.confirmDelete) return this.confirmView(palette());
    const started = Date.now();
    this.t0 = started;
    this.parts = {};
    this.shed = 0;
    this.takeView();
    if (!this.fixed && this.here() !== this.feed.at) this.wake?.();
    const c = palette();
    const b = this.feed.board;
    const now = Date.now();
    const ready = Boolean(hasCards(b) && this.geo && this.size);
    const root = v_flex().id("root").min_h(0).bg(c.bg).font_family(SANS)
      .track_focus(this.handle)
      // A window overlay draws no frame of its own, so Esc is how it goes away. A tab's
      // Esc still belongs to the terminal beside it, hence the overlay check.
      .on_key_down((e, cx) => {
        // The canvas takes the plain arrows while this mod holds focus: up/down walk the
        // lines the next step can take, right takes the one it is on, left gives back the
        // last one taken.
        if (e.key === "up" || e.key === "down") {
          // Nothing lit yet: start where work is, so the arrows always have lines to walk
          // rather than doing nothing at all.
          if (!this.route) {
            const id = openingCard(this.feed.board, Date.now());
            if (!id) return;
            this.select(id);
          }
          const ways = this.ways();
          if (!ways.length) return;
          const at = ways.findIndex((w) => w.from === this.cand?.from && w.to === this.cand?.to);
          const step = e.key === "down" ? 1 : -1;
          const next = at < 0 ? (step > 0 ? 0 : ways.length - 1) : (at + step + ways.length) % ways.length;
          this.cand = { from: ways[next].from, to: ways[next].to };
          cx.notify();
          cx.stop_propagation();
          return;
        }
        if (e.key === "right") {
          if (this.step(1)) { cx.notify(); cx.stop_propagation(); }
          return;
        }
        if (e.key === "left") {
          if (this.step(-1)) { cx.notify(); cx.stop_propagation(); }
          return;
        }
        if (e.key !== "escape") return;
        // Esc puts the light out — the route and its chain — and with none lit it closes a
        // window overlay.
        if (this.chain || this.route) this.select(null);
        else if (props()?.overlay) closeOverlay(props().overlay);
        else return;
        cx.stop_propagation();
      })
      .when(Boolean(this.edges), (el) => el
        .on_mouse_down("left", (e, cx) => this.edges.down(e, cx)))
      .when(Boolean(props()?.overlay), (el) => el.w(this.win.w).h(this.win.h).flex_none())
      .when(!props()?.overlay, (el) => el.size_full())
      .on_size_change((size, cx) => {
        if (size.width === this.size?.width && size.height === this.size?.height) return;
        this.resized(size);
        cx.notify();
      })
      .child(this.header(c, b, now))
      .when(Boolean(this.feed.state.away), (el) => el.child(this.awayStrip(c)))
      .when(this.feed.state.efforts.length > 1, (el) => el.child(this.efforts(c)))
      .child(div().id("canvas").relative().flex_1().min_h(0).overflow_hidden().bg(c.bg)
        .when(Boolean(this.press), (el) => el.cursor_grabbing())
        .when(ready && !this.press, (el) => el.cursor_grab())
        .on_mouse_down("left", (e, cx) => {
          // A press the mod stops moves the canvas; an unstopped one would drag the whole
          // window instead, since that is a window overlay's own way of being moved.
          cx.stop_propagation();
          this.handle.focus();
          this.press = { x: e.position.x, y: e.position.y, px: this.pan.x, py: this.pan.y };
          cx.notify();
        })
        .on_mouse_move((e, cx) => {
          if (!this.press) return;
          this.stats.moves += 1;
          this.auto = false;
          this.pan = { x: this.press.px + e.position.x - this.press.x, y: this.press.py + e.position.y - this.press.y };
          cx.notify();
        })
        .on_mouse_up("left", (e, cx) => {
          // A press that did not move the canvas is a click: on a line it takes that way,
          // on empty space it puts the light out.
          const still = this.press && Math.hypot(e.position.x - this.press.x, e.position.y - this.press.y) < 4;
          this.press = null;
          if (still) {
            const at = e.local_position ?? e.position;
            const edge = this.geo ? edgeNear(this.geo, this.zoom, at.x - this.pan.x, at.y - this.pan.y) : null;
            if (edge) this.take(edge);
            else if (this.chain) this.select(null);
          }
          cx.notify();
        })
        .on_hover((hovered, cx) => { if (!hovered && this.press) { this.press = null; cx.notify(); } })
        .on_scroll_wheel((e, cx) => {
          this.stats.wheels += 1;
          this.auto = false;
          // Zoom lives on cmd-shift-up/down, the buttons and a trackpad pinch; a scroll
          // only moves the canvas.
          const d = e.delta ?? { x: 0, y: 0 };
          this.pan = { x: this.pan.x + d.x, y: this.pan.y + d.y };
          cx.notify();
        })
        .when(CAN_PINCH, (el) => el.on_pinch((e, cx) => {
          // A trackpad pinch: one step per event, so the zoom follows the fingers. The
          // pointer is the anchor; without one, a step keeps the view it had.
          this.stats.pinches += 1;
          if (e.delta) {
            this.auto = false;
            const at = e.local_position;
            if (at) this.zoomAt(this.zoom * (1 + e.delta), at);
            else this.zoomBy(1 + e.delta);
          }
          cx.stop_propagation();
          cx.notify();
        }))
        .when(ready, (el) => { const g = el.child(this.grid(c)); this.parts.grid = Date.now() - this.t0; return g; })
        .when(ready, (el) => el.children(this.canvas(c, b, now)).child(this.tools(c, b, now)).child(this.legend(c, b)))
        .when(Boolean(b) && !hasCards(b), (el) => el.child(this.charted(c, b)))
        .when(!b, (el) => el.child(this.notice(c))))
      .when(Boolean(this.edges), (el) => el.children(this.edges.handles({ dim: c.dim, bg: c.overlay, border: c.line, font: MONO })));
    const ms = Date.now() - started;
    this.stats.renders += 1;
    this.stats.totalMs += ms;
    this.stats.shed = (this.stats.shed ?? 0) + (this.shed ? 1 : 0);
    if (ms >= this.stats.maxMs) { this.stats.maxMs = ms; this.stats.worst = { ...this.parts, ms }; }
    const worst = this.narrow() ? "worstNarrow" : "worstFull";
    this.stats[worst] = Math.max(this.stats[worst], ms);
    return root;
  }
}
