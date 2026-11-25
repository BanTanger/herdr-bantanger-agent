// agent-deck: the 评审 chip on an agent card (review.js decides what it says and what a click does).
import { chip } from "./chip.js";
import { reviewChip } from "./review.js";

const TONE = { generating: "working", ready: "ansi2" };

// The chip for a terminal's labels, or null without `herdr.review`, or when the state has no word
// on the card (fixing, done, no state). open(chip, cx) on click.
export function reviewChipView(t, address, labels, open) {
  const c = reviewChip(labels);
  if (!c?.text) return null;
  const tone = t[TONE[c.state]] ?? t.accent ?? t.foreground;
  return chip(`review-${address}`, c.text, tone, {
    press: (_e, cx) => { cx.stop_propagation(); open(c, cx); },
  })
    .flex_none()
    .tooltip(`打开评审导览 ${c.review}`);
}
