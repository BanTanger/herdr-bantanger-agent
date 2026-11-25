// node --test review.test.mjs  (from this folder)
import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewChip, tabLabel, tabOfLabel, openReview, newTab, readyNotices, MOD } from "./review.js";

// --- the chip -----------------------------------------------------------------------------------

test("the two card states have their words", () => {
  const want = { generating: "预评审", ready: "待评审" };
  for (const [state, text] of Object.entries(want)) {
    const c = reviewChip({ "herdr.review": "gr-1", "herdr.review_state": state });
    assert.deepEqual([c.review, c.state, c.text], ["gr-1", state, text]);
  }
});

test("the review tab's own states draw no card chip", () => {
  for (const state of ["fixing", "done"]) {
    const c = reviewChip({ "herdr.review": "gr-1", "herdr.review_state": state });
    assert.deepEqual([c.review, c.state, c.text], ["gr-1", null, null], state);
  }
});

test("no herdr.review: no chip, whatever else is there", () => {
  for (const l of [undefined, null, {}, { "herdr.review": "" }, { "herdr.review_state": "ready", "herdr.review_tab": "tb1" }, { req: "123" }]) {
    assert.equal(reviewChip(l), null, JSON.stringify(l));
  }
});

test("a review without a (known) state has no word of its own", () => {
  for (const s of [undefined, "", "weird"]) {
    const c = reviewChip({ "herdr.review": "gr-1", ...(s === undefined ? {} : { "herdr.review_state": s }) });
    assert.deepEqual([c.state, c.text], [null, null]);
  }
});

test("the chip carries the recorded tab, or null", () => {
  assert.equal(reviewChip({ "herdr.review": "gr-1", "herdr.review_tab": "tb4" }).tab, "tb4");
  assert.equal(reviewChip({ "herdr.review": "gr-1", "herdr.review_tab": "" }).tab, null);
});

// --- tab ids in labels: a remote machine's labels omit its prefix ---------------------------------

test("tab label values: local as is; remote without the machine prefix, and back", () => {
  assert.equal(tabLabel("tb3", "t7"), "tb3");
  assert.equal(tabLabel("mac/tb3", "mac/t7"), "tb3");
  assert.equal(tabOfLabel("tb3", "t7"), "tb3");
  assert.equal(tabOfLabel("tb3", "mac/t7"), "mac/tb3");
  assert.equal(tabOfLabel(null, "mac/t7"), null);
});

// --- open or select -------------------------------------------------------------------------------

const tabs = [{ id: "tb1", name: "1" }, { id: "tb2", name: "评审·claude" }];
const chip = (tab) => reviewChip({ "herdr.review": "gr-1", "herdr.review_state": "ready", ...(tab ? { "herdr.review_tab": tab } : {}) });

test("the recorded tab still exists: select it", () => {
  assert.deepEqual(openReview({ chip: chip("tb2"), address: "t7", tabs, name: "claude", space: "sp1" }),
    { cmd: "tab.select", args: { id: "tb2" } });
});

test("a tab this deck just opened (label not back yet) is selected too", () => {
  assert.deepEqual(openReview({ chip: chip(null), known: "tb2", address: "t7", tabs, name: "claude", space: "sp1" }),
    { cmd: "tab.select", args: { id: "tb2" } });
});

test("no tab, or a stale one: a new mod tab named 评审·<agent> in the agent's space", () => {
  for (const c of [chip(null), chip("tb9")]) {
    assert.deepEqual(openReview({ chip: c, address: "t7", tabs, name: "claude", space: "sp1" }), {
      cmd: "tab.new",
      args: { name: "评审·claude", space: "sp1", mod: MOD, props: { role: "guide", review: "gr-1", agent: "claude" } },
    });
  }
});

test("a remote agent: its tab is found with the machine prefix, and the Guide reads on that machine", () => {
  const remote = [{ id: "mac/tb2", name: "评审·x" }];
  assert.deepEqual(openReview({ chip: chip("tb2"), address: "mac/t7", tabs: remote, name: "x", space: "mac/sp1" }),
    { cmd: "tab.select", args: { id: "mac/tb2" } });
  assert.deepEqual(openReview({ chip: chip(null), address: "mac/t7", tabs: remote, name: "x", space: "mac/sp1" }).args.props,
    { role: "guide", review: "gr-1", agent: "x", on: "mac" });
});

test("the tab is a mod pane, never a terminal: no argv or task (mod panes don't report as agents)", () => {
  const a = openReview({ chip: chip(null), address: "t7", tabs, name: "claude", space: "sp1" }).args;
  assert.equal(a.mod, "guided-review");
  assert.ok(!("argv" in a) && !("task" in a) && !("folder" in a));
});

test("a long agent name is cut in the tab name", () => {
  const a = openReview({ chip: chip(null), address: "t7", tabs, name: "x".repeat(80), space: "sp1" }).args;
  assert.equal(a.name, "评审·" + "x".repeat(39) + "…");
  assert.equal(a.props.agent, "x".repeat(80));
});

// --- the tab tab.new made -------------------------------------------------------------------------

test("newTab: the tab with that name that wasn't there before", () => {
  const before = new Set(["tb1", "tb2"]);
  assert.equal(newTab(before, [...tabs, { id: "tb3", name: "评审·claude" }], "评审·claude"), "tb3");
  assert.equal(newTab(before, tabs, "评审·claude"), null);
  assert.equal(newTab(before, [...tabs, { id: "tb3", name: "other" }], "评审·claude"), null);
});

// --- one toast per readiness ----------------------------------------------------------------------

test("ready notifies once per transition into ready; re-renders and restarts don't repeat it", () => {
  const now = 1000;
  let r = readyNotices({}, [{ review: "gr-1", state: "generating" }], now);
  assert.deepEqual(r.notify, []);
  r = readyNotices(r.seen, [{ review: "gr-1", state: "ready" }], now);
  assert.deepEqual(r.notify, ["gr-1"]);
  r = readyNotices(r.seen, [{ review: "gr-1", state: "ready" }], now); // re-render
  assert.deepEqual(r.notify, []);
  r = readyNotices(JSON.parse(JSON.stringify(r.seen)), [{ review: "gr-1", state: "ready" }], now); // restart
  assert.deepEqual(r.notify, []);
});

test("a later readiness (fixing, then ready again) is a new transition", () => {
  let r = readyNotices({}, [{ review: "gr-1", state: "ready" }], 1);
  assert.deepEqual(r.notify, ["gr-1"]);
  r = readyNotices(r.seen, [{ review: "gr-1", state: "fixing" }], 2);
  assert.deepEqual(r.notify, []);
  r = readyNotices(r.seen, [{ review: "gr-1", state: "ready" }], 3);
  assert.deepEqual(r.notify, ["gr-1"]);
});

test("a review missing from one list (terminals not listed yet) keeps its record; old gone ones are dropped", () => {
  let r = readyNotices({}, [{ review: "gr-1", state: "ready" }], 0);
  r = readyNotices(r.seen, [], 1000);
  assert.equal(r.seen["gr-1"].s, "ready");
  r = readyNotices(r.seen, [{ review: "gr-1", state: "ready" }], 2000);
  assert.deepEqual(r.notify, []);
  r = readyNotices(r.seen, [], 2000 + 31 * 86400000);
  assert.equal(r.seen["gr-1"], undefined);
});

test("the same review on two terminals notifies once", () => {
  const r = readyNotices({}, [{ review: "gr-1", state: "ready" }, { review: "gr-1", state: "ready" }], 0);
  assert.deepEqual(r.notify, ["gr-1"]);
});

test("re-renders with nothing new leave the record as it was (no store write per render)", () => {
  const r = readyNotices({}, [{ review: "gr-1", state: "ready" }], 0);
  assert.deepEqual(readyNotices(r.seen, [{ review: "gr-1", state: "ready" }], 60000).seen, r.seen);
  assert.notDeepEqual(readyNotices(r.seen, [{ review: "gr-1", state: "ready" }], 2 * 86400000).seen, r.seen); // listed again a day on
});
