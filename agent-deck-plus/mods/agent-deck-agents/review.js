// agent-deck: the 评审 chip of a guided review (mods/guided-review). The review's skill labels the
// agent's terminal `herdr.review=<id> herdr.review_state=generating|ready|fixing|done`; the chip
// opens the review's Guide tab (a guided-review mod tab) and records it as `herdr.review_tab=<tab>`.
// The Guide tab's 关闭评审 removes all three (guided-review/review-labels.js: change both).
// No imports, so node can test it (review.test.mjs).

export const MOD = "guided-review";
export const TAB_PREFIX = "评审·";
const TAB_NAME_MAX = 40;
// The card's two words: a review is either still being prepared (预评审) or waiting for the person
// (待评审). `fixing` and `done` are the review tab's own states and draw no card chip; `state` stays
// null for them, which is what the ready toast reads.
const LABELS = { generating: "预评审", ready: "待评审" };

// The chip a terminal's labels call for, or null: no `herdr.review`, no chip. `text` is null when
// the state has no word on the card (review-chip.js draws nothing then).
export function reviewChip(labels) {
  const review = labels?.["herdr.review"];
  if (typeof review !== "string" || !review) return null;
  const s = labels["herdr.review_state"], state = Object.hasOwn(LABELS, s) ? s : null;
  return { review, state, text: state ? LABELS[state] : null, tab: labels["herdr.review_tab"] || null };
}

// Remote ids carry a `machine/` prefix; labels on that machine omit it.
const machineOf = (address) => (address.includes("/") ? address.slice(0, address.lastIndexOf("/")) : null);
export const tabLabel = (id, address) => (machineOf(address) && id.startsWith(machineOf(address) + "/") ? id.slice(machineOf(address).length + 1) : id);
export const tabOfLabel = (value, address) => (value && machineOf(address) && !value.includes("/") ? `${machineOf(address)}/${value}` : value ?? null);

// The click: select the review's tab if it is still there (recorded in the label, or just opened
// by this deck and not labelled yet), else a new tab whose only pane is the Guide. tab.new isn't
// idempotent and takes the focus, so only this click opens one.
export function openReview({ chip, address, tabs, known = null, name, space }) {
  const ids = new Set(tabs.map((t) => t.id));
  const id = [tabOfLabel(chip.tab, address), known].find((x) => x && ids.has(x));
  if (id) return { cmd: "tab.select", args: { id } };
  const short = name.length > TAB_NAME_MAX ? name.slice(0, TAB_NAME_MAX - 1) + "\u2026" : name;
  const on = machineOf(address);
  return {
    cmd: "tab.new",
    args: { name: TAB_PREFIX + short, space, mod: MOD, props: { role: "guide", review: chip.review, agent: name, ...(on ? { on } : {}) } },
  };
}

// run() returns no id: the tab tab.new made is the new one with its name.
export const newTab = (before, tabs, name) => tabs.find((t) => !before.has(t.id) && t.name === name)?.id ?? null;

// One toast per transition into ready, per review id. `seen` (kept across restarts) holds each
// review's last state and when it was last stamped (on a change, or a day on while listed: no
// write per render); reviews gone for 30 days are dropped.
export function readyNotices(seen, reviews, now) {
  const next = { ...seen }, notify = [], listed = new Set();
  for (const { review, state } of reviews) {
    if (listed.has(review)) continue;
    listed.add(review);
    if (state === "ready" && next[review]?.s !== "ready") notify.push(review);
    if (next[review]?.s !== state || now - next[review].at > 86400000) next[review] = { s: state, at: now };
  }
  for (const [k, v] of Object.entries(next)) if (!listed.has(k) && now - v.at > 30 * 86400000) delete next[k];
  return { notify, seen: next };
}
