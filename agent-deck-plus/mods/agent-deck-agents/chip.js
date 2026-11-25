// agent-deck: one chip in an agent card's second line (space, requirement, review). Every chip
// shares one box (`CHIP`) and one language: a 1px border in its own tone, the words in that tone,
// nothing filled in — a card's chips were drifting into four sizes and weights before this, and a
// filled chip read louder than the card under it.
import { div } from "gpui-kit";

export const CHIP = { height: 18, padding: 6, radius: 5, size: 11 };

// The prism ink, per appearance: readable on the card surface both ways (5.18:1 dark, 4.96:1
// light — the one orange at 4.5:1 or better on a light card is a darker one).
export const prismInk = (dark = true) => (dark ? "#fa8a0b" : "#c2410c");

// Theme tones may already carry alpha ("#ffffff18"); a plain six-digit one gets it appended.
const ink = (color, alpha) => (typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color) ? color + alpha : color);

// `edge` (default: the tone) is the border colour; `press` makes the chip behave like a control:
// pointer, a wash of its own tone on hover, and the click. Flex is the caller's call — a space chip
// shrinks and truncates, the others stay at their size.
export function chip(id, text, tone, { edge = tone, alpha = "55", press = null } = {}) {
  const box = div().id(id).h(CHIP.height).px(CHIP.padding).rounded(CHIP.radius)
    .flex().items_center().border_1().border_color(ink(edge, alpha))
    .text_size(CHIP.size).font_medium().text_color(tone);
  const live = press ? box.cursor_pointer().hover((x) => x.bg(ink(tone, "1a"))).on_click(press) : box;
  return live.child(text);
}
