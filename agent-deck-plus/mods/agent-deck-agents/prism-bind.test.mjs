import assert from "node:assert/strict";
import test from "node:test";
import { SWIPE_PX, SWIPE_WHEEL_PX, ackLabel, bindAcked, bindArgv, bindTargetNote, linkedReqId, lookupArgv, lookupNote, mergeUnlinked, parseLinkResult, prismPrompts, saveLabel, storyInput, swipeMove, swipePast, swipeStart, wheelTravel } from "./prism-bind.js";

const target = { session: "01a1c864-571c", cwd: "/tmp/proj", terminal: "t7", branch: "feature-x" };

test("a number or a Feishu story link is the only input", () => {
  assert.deepEqual(storyInput(" 1234567890 "), { value: "1234567890" });
  assert.deepEqual(storyInput("https://project.feishu.cn/demo/story/detail/1234567890"), {
    value: "https://project.feishu.cn/demo/story/detail/1234567890",
  });
  assert.match(storyInput("").error, /填写/);
  assert.match(storyInput("feature-4980").error, /只接受/);
});

test("the bind argv carries the session, the project and the terminal label", () => {
  assert.deepEqual(bindArgv("/Users/me/.local/bin/prism-link", target, "1234567890"), [
    "HC_TERMINAL_ID=t7",
    "/Users/me/.local/bin/prism-link",
    "link", "--cwd", "/tmp/proj", "--session-id", "01a1c864-571c", "--story", "1234567890",
  ]);
  // Overwriting an earlier link is a second, explicit step, never the first press.
  assert.equal(bindArgv("/Users/me/.local/bin/prism-link", target, "1234567890", true).at(-1), "--force");
  // No terminal in the event: the meta still gets written, only the tab label is skipped.
  assert.equal(bindArgv("cli", { ...target, terminal: "" }, "7")[0], "cli");
});

test("a bound link reads the CLI's JSON line, not its human one", () => {
  const result = {
    code: 0,
    stdout: '{"ok": true, "req_id": "1234567890", "req_url": "https://project.feishu.cn/demo/story/detail/1234567890", "warnings": []}\n',
    stderr: "prism-link: linked 1234567890 -> /tmp/proj/.prism/01a1c864-571c/meta.json\n",
  };
  assert.deepEqual(parseLinkResult(result), {
    ok: true,
    reqId: "1234567890",
    reqUrl: "https://project.feishu.cn/demo/story/detail/1234567890",
    storyName: "",
    source: "",
    branch: "",
    warnings: [],
  });
});

test("a refused link keeps prism-link's reason", () => {
  const conflict = parseLinkResult({
    code: 3,
    stdout: '{"ok": false, "error": "已有不同 req_id=1，未加 --force", "reason": "已有不同 req_id=1，未加 --force", "existing_req_id": "1"}\n',
    stderr: "",
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.existing, "1");
  assert.match(conflict.error, /req_id=1/);
  // A crash before any JSON: the last stderr line is the story, and it is not a conflict.
  assert.equal(parseLinkResult({ code: 5, stdout: "", stderr: "boom\npermission denied\n" }).error, "permission denied");
  assert.equal(parseLinkResult({ code: 5, stdout: "", stderr: "" }).conflict, false);
  assert.match(parseLinkResult({ code: 0, stdout: "", stderr: "" }).error, /exit 0/);
});

test("the branch lookup writes nothing and asks the same checkout", () => {
  assert.deepEqual(lookupArgv("/cli", target), [
    "/cli", "link", "--cwd", "/tmp/proj", "--session-id", "01a1c864-571c", "--branch-only", "--dry-run",
  ]);
});

test("the lookup line offers the found id, and says when the branch has none", () => {
  assert.equal(lookupNote(undefined, "feature-x"), null);
  assert.deepEqual(lookupNote("busy", "feature-x"), { text: "查询当前分支的需求…", use: "", retry: false, tone: "dim" });
  const hit = lookupNote({ id: "1234567890", name: "Gateway refactor", source: "beetle-api" }, "feature-x");
  assert.match(hit.text, /feature-x 已关联 1234567890/);
  assert.match(hit.text, /Gateway refactor/);
  assert.equal(hit.use, "1234567890");
  // detect/local-context ids are this machine's guess, not the branch's link: shown, not offered.
  const guess = lookupNote({ id: "7150000001", source: "detect" }, "feature-x");
  assert.match(guess.text, /7150000001/);
  assert.equal(guess.use, "");
  const none = lookupNote({}, "feature-x");
  assert.equal(none.text, "当前分支未关联需求");
  assert.equal(none.use, "");
  assert.equal(none.retry, true);
  // A failed lookup says why and offers a retry, it does not look like "no requirement".
  const failed = lookupNote({ error: "beetle-api: 请求失败" }, "feature-x");
  assert.equal(failed.text, "beetle-api: 请求失败");
  assert.equal(failed.tone, "blocked");
  assert.equal(failed.retry, true);
});

test("a dry-run hit is parsed as an id, and exit 4 as 'no requirement'", () => {
  const dry = parseLinkResult({
    code: 0,
    stdout: '{"ok": true, "req_id": "1234567890", "story_name": "Gateway refactor", "req_url": "https://project.feishu.cn/demo/story/detail/1234567890", "source": "beetle-api", "branch": "feature-x", "dry_run": true, "would_write": false}\n',
    stderr: "",
  });
  assert.equal(dry.reqId, "1234567890");
  assert.equal(dry.storyName, "Gateway refactor");
  assert.equal(dry.source, "beetle-api");
  assert.equal(dry.branch, "feature-x", "the branch actually asked about, not the event's snapshot");
  assert.equal(parseLinkResult({ code: 4, stdout: '{"ok": false, "error": "分支无需求", "code": 4, "lookup": "none"}\n', stderr: "" }).unresolved, true);
  // A timed-out API also exits 4: that must read as a failure, not "the branch has none".
  const timedOut = parseLinkResult({ code: 4, stdout: '{"ok": false, "error": "beetle-api: 请求失败: timed out", "code": 4, "lookup": "error"}\n', stderr: "" });
  assert.equal(timedOut.unresolved, false);
  assert.match(timedOut.error, /timed out/);
  assert.equal(parseLinkResult({ code: 3, stdout: '{"ok": false, "code": 3}\n', stderr: "" }).unresolved, false);
});

test("the primary button only offers to overwrite after a conflict", () => {
  assert.equal(saveLabel(false, false), "关联");
  assert.equal(saveLabel(false, true), "覆盖关联");
  assert.equal(saveLabel(true, true), "关联中…");
  // A stale prompt's primary press names the agent it belongs to, shortened to fit.
  assert.equal(ackLabel("orders"), "确认关联到 orders");
  assert.equal(ackLabel("订单角色分配四标签和大段名字"), "确认关联到 订单角色分配四标签和大…");
  assert.equal(ackLabel(""), "确认关联到 那个 agent");
});

test("an acknowledgement covers one terminal, not a session", () => {
  // The same session can be re-reported for another terminal while the dialog is open: the
  // confirmation must not carry over.
  assert.equal(bindAcked(target, "t7"), true);
  assert.equal(bindAcked({ ...target, terminal: "t9" }, "t7"), false);
  assert.equal(bindAcked(target, ""), false);
  assert.equal(bindAcked({ ...target, terminal: "" }, ""), false, "no terminal is never an acknowledgement");
});

test("the prompt lands on the agent's card, one per terminal, newest session wins", () => {
  const live = [
    { address: "t4s", state: "live", labels: {} },
    { address: "t4r", state: "live", labels: {} },
  ];
  const older = { ...target, session: "old", terminal: "t4s", at: 100 };
  const newer = { ...target, session: "new", terminal: "t4s", at: 200 };
  const other = { ...target, session: "other", terminal: "t4r", at: 150 };
  const prompts = prismPrompts({ old: older, new: newer, other }, live, {});
  assert.equal(prompts.size, 2, "a tab restarted twice asks once");
  assert.equal(prompts.get("t4s").session, "new", "the session that is running now is the one a press binds");
  assert.equal(prompts.get("t4r").session, "other");
  // The event's terminal may be blank: nothing to put a chip on.
  assert.equal(prismPrompts({ x: { ...target, terminal: "" } }, live, {}).size, 0);
  // Newest wins whichever order they arrive in.
  assert.equal(prismPrompts({ new: newer, old: older }, live, {}).get("t4s").session, "new");
  // Equal or missing `at`: the larger session id wins, in either insertion order, so two copies of
  // the deck pick the same one.
  const tieA = { ...target, session: "aaa", terminal: "t4s", at: 300 };
  const tieB = { ...target, session: "bbb", terminal: "t4s", at: 300 };
  assert.equal(prismPrompts({ bbb: tieB, aaa: tieA }, live, {}).get("t4s").session, "bbb");
  assert.equal(prismPrompts({ aaa: tieA, bbb: tieB }, live, {}).get("t4s").session, "bbb");
  // A higher `at` still beats a larger id: time is the contract, the id only breaks ties.
  assert.equal(prismPrompts({ zzz: tieB, aaa: { ...tieA, at: 400 } }, live, {}).get("t4s").session, "aaa");
  const noAt = { ...target, session: "ccc", terminal: "t4s" };
  assert.equal(prismPrompts({ ccc: noAt, ddd: { ...noAt, session: "ddd" } }, live, {}).get("t4s").session, "ddd");
});

test("a bound, ended or dismissed card is not asked", () => {
  const bound = [{ address: "t4s", state: "live", labels: { req: "1234567890" } }];
  // The CLI labels the terminal it linked: that card already answers the question.
  assert.equal(prismPrompts({ s: { ...target, terminal: "t4s" } }, bound, {}).size, 0);
  // A finished terminal has no card left to label.
  assert.equal(prismPrompts({ s: { ...target, terminal: "t4s" } }, [{ address: "t4s", state: "exited" }], {}).size, 0);
  assert.equal(prismPrompts({ s: { ...target, terminal: "t9" } }, [{ address: "t4s", state: "live" }], {}).size, 0);
  // A swiped card stays away, and that is per card: a new terminal asks again.
  const dismissed = { t4s: 1 };
  assert.equal(prismPrompts({ s: { ...target, terminal: "t4s" } }, [{ address: "t4s", state: "live" }], dismissed).size, 0);
  assert.equal(prismPrompts({ s: { ...target, terminal: "t4p" } }, [{ address: "t4p", state: "live" }], dismissed).size, 1);
});

test("a swipe counts either direction, and a trackpad needs more travel than a drag", () => {
  assert.equal(swipePast(SWIPE_PX - 1), false);
  assert.equal(swipePast(SWIPE_PX), true);
  assert.equal(swipePast(-SWIPE_PX), true, "left and right are both a swipe");
  assert.equal(swipePast(Number.NaN), false);
  assert.ok(SWIPE_WHEEL_PX > SWIPE_PX, "a trackpad reports many small steps, so it accumulates further");
});

test("the drag starts where the press landed, so a fast one-move swipe still counts", () => {
  // A press already displaced from the chip's left edge must not read as a swipe.
  assert.deepEqual(swipeStart(120), { from: 120, travel: 0, step: 0 });
  let s = swipeStart(120);
  // One move, and the whole gesture is there: no intermediate position is needed.
  s = swipeMove(s, 90);
  assert.equal(s.travel, 30);
  assert.equal(swipePast(s.travel), true);
  // Rightward travel counts the same.
  assert.equal(swipeMove(swipeStart(10), 40).travel, 30);
  // A press without a readable position falls back to the first move as the origin.
  s = swipeMove(swipeStart(), 106);
  assert.equal(s.travel, 0);
  assert.equal(swipeMove(s, 90).travel, 16);
  // A move with no readable position leaves the gesture alone, and so does no gesture at all.
  assert.deepEqual(swipeMove(swipeStart(10), undefined), { from: 10, travel: 0, step: 0 });
  assert.equal(swipeMove(null, 5), null);
});

test("the fade steps are few, so a drag repaints the window a handful of times", () => {
  let s = swipeStart(0);
  const steps = new Set();
  for (let x = 1; x <= 200; x += 1) {
    s = swipeMove(s, x);
    steps.add(s.step);
  }
  assert.ok(steps.size <= 5, `fade asked for ${steps.size} repaints`);
  assert.equal(s.step, 4, "the step saturates");
});

test("a trackpad swipe counts its horizontal part, including the closing delta", () => {
  const event = (x, y, phase = "moved") => ({ delta: { x, y }, touch_phase: phase });
  // A vertical scroll over a chip is the list scrolling: it adds nothing and does not wipe the
  // travel a diagonal swipe already built (a diagonal reports both axes).
  assert.deepEqual(wheelTravel({ travel: 5 }, event(1, 30)), { travel: 5, ended: false });
  assert.deepEqual(wheelTravel(null, event(-20, 0)), { travel: 20, ended: false });
  assert.deepEqual(wheelTravel({ travel: 20 }, event(30, 2)), { travel: 50, ended: false });
  assert.ok(swipePast(wheelTravel({ travel: 20 }, event(30, 2)).travel, SWIPE_WHEEL_PX));
  // The event that ends the gesture still carries its own delta: dropping it makes a swipe that
  // ends right at the threshold miss.
  const last = wheelTravel({ travel: 40 }, event(12, 0, "ended"));
  assert.deepEqual(last, { travel: 52, ended: true });
  assert.ok(swipePast(last.travel, SWIPE_WHEEL_PX));
});

test("an unlinked event remembers one session per card, and not one for a bound tab", () => {
  const event = { session_id: "s2", cwd: "/tmp/proj", terminal: "t4s", branch: "feature-x" };
  const before = { s1: { session: "s1", cwd: "/tmp/proj", terminal: "t4s", branch: "feature-x", at: 1 } };
  // The newer session replaces the one it replaced: a restarted tab asks once.
  const merged = mergeUnlinked(before, event, null, 5);
  assert.deepEqual(Object.keys(merged), ["s2"]);
  assert.equal(merged.s2.at, 5);
  assert.equal(merged.s2.branch, "feature-x");
  // A plain tab (no label) keeps other cards' targets.
  const other = { t1: { session: "t1", cwd: "/e", terminal: "t1d", at: 1 } };
  assert.deepEqual(Object.keys(mergeUnlinked(other, event, null, 5)), ["t1", "s2"]);
  // The tab is bound already (the CLI labels what it links): nothing to ask, nothing to remember.
  assert.equal(mergeUnlinked(before, event, { labels: { req: "1234567890" } }), null);
  // A session the CLI cannot bind is not stored at all.
  assert.equal(mergeUnlinked(before, { ...event, cwd: "" }), null);
  assert.equal(mergeUnlinked(before, { ...event, session_id: " " }), null);
  // No terminal in the event: keep the target but replace nothing blindly.
  assert.deepEqual(Object.keys(mergeUnlinked(other, { ...event, terminal: "" }, null, 5)), ["t1", "s2"]);
});

test("a binding is the session's meta, or a project link prism-link itself made", () => {
  assert.equal(linkedReqId({ req_id: "1234567890" }, { req_id: "9" }), "1234567890");
  assert.equal(linkedReqId({}, {}), "");
  // `prism-link link --scope project` stamps both fields; the harness keeps a req_id in the same
  // file without them, and a teammate's file must not bind this session.
  assert.equal(linkedReqId({}, { req_id: "7169917408", link_source: "prism-link", link_scope: "project" }), "7169917408");
  assert.equal(linkedReqId({}, { req_id: "1234567890", workflow_name: "harness" }), "");
  assert.equal(linkedReqId({}, { req_id: "1234567890", link_source: "prism-link", link_scope: "session" }), "");
});

test("the dialog names the card the label lands on, or why it cannot land", () => {
  const live = { address: "t7", state: "live", title: "Orders tab export", labels: { where: "demo-app / Orders tab export" } };
  // The session is in front: just say which agent.
  assert.deepEqual(bindTargetNote(target, live, "t7"), { problem: "", agent: "Orders tab export", other: false, note: "Orders tab export" });
  // Another agent's tab was in front: the press is about that other card, and must say so.
  const stale = bindTargetNote(target, live, "t9");
  assert.equal(stale.other, true);
  assert.equal(stale.note, "另一个 agent：Orders tab export");
  // No front captured at all fails closed the same way: only the named press can unblock it.
  assert.equal(bindTargetNote(target, live, "").other, true);
  // That address was confirmed: the press may go through.
  assert.equal(bindTargetNote(target, live, "t9", true).other, false);
  // The card's tab name when the program set no title.
  assert.equal(bindTargetNote(target, { ...live, title: "" }, "t7").agent, "demo-app / Orders tab export");
  // A terminal that ended leaves nowhere to put the label.
  const gone = bindTargetNote(target, null, "t7");
  assert.match(gone.problem, /t7/);
  assert.equal(gone.agent, "");
  // Records that cannot bind at all.
  assert.match(bindTargetNote({ ...target, terminal: "" }, live, "t7").problem, /没有终端/);
  assert.match(bindTargetNote({ session: "s" }, live, "t7").problem, /重新开一个会话/);
});
