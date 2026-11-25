// Resizing a window overlay by its right and bottom edges, and moving it by its header.
//
// Herdr lets a mod set a window's size, never its place: the window follows the mod's
// content, its top left holding still. So only the right and bottom edges (and the corner
// between them) resize: dragging one changes the size and the top left holds. The left and
// top edges can't resize this way — the opposite corner would have to move, and only Herdr
// can move a window. They are not handles.
//
// A hidden native slider takes the press, because a slider's drag runs across the whole
// app and its `release` arrives wherever the button comes up, in the window or outside it.
//
// The header moves the window: the mod's own header claims the press and lets it reach
// Herdr. A press anywhere else is stopped by the root, so nothing else drags the window.
//
// The same file lives in agenttrail/ and preview-plus/: each mod folder stands alone.

import { div } from "gpui-kit";
import { Slider, SliderIndicator, SliderState, SliderThumb, SliderTrack } from "gpui-base";

export const EDGE = 6; // how far in from the edge a press resizes
const CORNER = 16;
const PINNED = ["e", "s", "se"]; // the top left holds still; the pointer is the edge

export class Resize {
  // get(): the size now. set(w, h): a size during a drag, true if it changed (the mod
  // clamps it). done(): once, as a drag ends. Needs a live host, so make it in `init`.
  constructor({ get, set, done }) {
    this.get = get;
    this.set = set;
    this.done = done;
    this.drag = null;
    this.held = false; // a header press, on its way up to Herdr
    this.sliders = {};
    for (const k of PINNED) {
      const s = SliderState.new({ min: 0, max: 1000, value: 500 });
      s.on("change", (_v, cx) => this.follow(k, cx));
      s.on("release", (_v, cx) => this.end(cx));
      this.sliders[k] = s;
    }
  }

  // The header claims the press: Herdr moves the window by it. Put this on the header's
  // own on_mouse_down, after any buttons on it.
  claim() {
    this.held = true;
  }

  // The root's press handler: every press but a header press stops here, so it never
  // drags the window.
  down(e, cx) {
    if (this.held) { this.held = false; return; }
    cx.stop_propagation();
  }

  // The handles, last among the root's children so they sit on top. `look`: { dim, bg,
  // border, font }, for the size shown while dragging.
  handles(look) {
    const { w, h } = this.get();
    const side = Math.max(0, h - 2 * CORNER);
    const run = Math.max(0, w - CORNER);
    const hint = this.drag
      ? [div().id("rz-size").absolute().right(CORNER + 4).bottom(6).px(6).py(2).rounded(6).bg(look.bg).border(1).border_color(look.border)
        .text_size(10).font_family(look.font).text_color(look.dim).child(`${w} × ${h}`)]
      : [];
    return [
      ...hint,
      this.pinned("e", div().right(0).top(CORNER).w(EDGE).h(side).cursor_ew_resize()),
      this.pinned("s", div().bottom(0).left(0).h(EDGE).w(run).cursor_ns_resize()),
      this.pinned("se", div().right(0).bottom(0).w(CORNER).h(CORNER).cursor_nwse_resize()),
    ];
  }

  pinned(k, el) {
    const s = this.sliders[k];
    return el.id(`rz-${k}`).absolute()
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.start(k, cx); })
      .child(Slider.new(s).size_full().child(SliderTrack.new(s).size_full()
        .child(SliderIndicator.new(s).size_full().child(SliderThumb.new(s).size(1)))));
  }

  start(k, cx) {
    const { w, h } = this.get();
    const m = window.mouse_position();
    this.drag = { k, m0: m, w0: w, h0: h };
    cx.notify();
  }

  follow(k, cx) {
    const d = this.drag;
    if (!d || d.k !== k) return;
    const m = window.mouse_position();
    const w = k === "s" ? d.w0 : d.w0 + m.x - d.m0.x;
    const h = k === "e" ? d.h0 : d.h0 + m.y - d.m0.y;
    if (this.set(w, h)) cx.notify();
  }

  end(cx) {
    if (!this.drag) return;
    this.drag = null;
    this.done();
    cx.notify();
  }
}
