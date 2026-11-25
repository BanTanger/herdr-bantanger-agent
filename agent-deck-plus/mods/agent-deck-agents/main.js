// Modified from Herdr's shipped `agents` mod (Apache-2.0, herdr 0.1.11) for agent-deck;
// changes are marked `agent-deck:`.
// Agents in grouped or priority views; parents take their most urgent sub-agent's place.
// A viewed done agent stays in Done until left.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, HoverCard, InputState } from "gpui-base";
import { agents, hc, exec, notify, readTextFile, watchFolder, home, terminals, panes, focused, spaces, run, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout, settings } from "herdr";
import { SESSION_OF, sessionFrom, resumeLink, machineOf } from "./resume.js";
import { liveTitle } from "./title.js";
import { labelBadge, assignColors, badgeStyle } from "./badge.js";
import { openReview, newTab, tabLabel, reviewChip, readyNotices } from "./review.js";
import { reviewChipView } from "./review-chip.js";
import { chip, prismInk } from "./chip.js";
import { prismToastPayload } from "./prism-toast.js";
import { BIND_DISMISSED, BIND_TARGETS, MINE_TTL, SWIPE_WHEEL_PX, bindAcked, bindArgv, bindTargetNote, cardLabel, filterMine, linkedReqId, lookupArgv, lookupNote, mergeUnlinked, mineArgv, mineStatuses, moveIndex, parseLinkResult, parseMine, prismCli, prismPrompts, storyInput, swipeMove, swipePast, swipeStart, wheelTravel } from "./prism-bind.js";
import { prismBindView } from "./prism-bind-view.js";
import { prismPromptChip } from "./prism-prompt-view.js";

// agent-deck: the last "my requirements" snapshot. Module scope on purpose — the host runs this
// file once per source version and every copy (deck, dialog) sees the same Map, so the dialog
// opens on data instead of waiting for `prism-link mine` (contract: issues/04).
let mineCache = null;

// agent-deck: where a bare `req` label opens. prism-link writes `req_url` on the label and that
// always wins. Without one, the base comes from shared state —
//   setShared("prism.feishu", "https://project.feishu.cn/<your-space>")
// — or, if that is unset, from any live `req_url` (the part before `story/detail/`), so a person
// who has bound anything once is configured already. With none of the three, the chip says so
// instead of opening a guessed URL.
const FEISHU = "prism.feishu";
const feishuBase = () => {
  const kept = shared(FEISHU);
  if (typeof kept === "string" && kept.trim()) return kept.trim().replace(/\/+$/, "");
  for (const term of terminals()) {
    const url = term.labels?.req_url;
    const at = typeof url === "string" ? url.indexOf("story/detail/") : -1;
    if (at > 0) return url.slice(0, at).replace(/\/+$/, "");
  }
  return "";
};
const reqUrlOf = (labels, req) => {
  if (labels?.req_url) return labels.req_url;
  const base = feishuBase();
  return base ? `${base}/story/detail/${req}` : null;
};

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

// agent-deck: Spaces rolls up into the line above Agents; clicking the Agents header unrolls it.
const spacesHidden = () => !!find(layout(), "spaces")?.hidden;
const toggleSpaces = () => run("layout.toggle", { id: "spaces" });

function lead(tab, all = panes()) {
  const mine = all.filter(p => p.tab === tab.id && p.terminal);
  return mine.find(p => p.program?.agent) ?? mine.find(p => p.focused) ?? mine[0];
}

function title(tab, l) {
  const live = liveTitle(l?.title, l?.program);
  return tab.name === l?.program?.name && live ? live : tab.name;
}
// agent-deck: a tab with one agent takes the agent's chat name, so Herdr's
// alerts ("Claude Code needs you · space / tab") say which chat. Only tabs
// nobody named, or that this named; a name someone gave a tab stays.
const NAME_TABS = true;
const TAB_NAME_MAX = 48;
function chatTitle(a) {
  const live = liveTitle(a.title, a.program);
  return live && !/^\d+$/.test(live) ? (live.length > TAB_NAME_MAX ? live.slice(0, TAB_NAME_MAX - 1) + "\u2026" : live) : null;
}

// agent-deck: "waiting" is an idle agent whose own hook still reports background work as
// a `bg` record (`hc report state=working:id=bg`, e.g. Claude Code's run_in_background
// shells). A done agent stays done until seen; then, still working in the background, it waits.
const RANK = { blocked: 5, done: 4, working: 3, waiting: 2, idle: 1 };
const waits = (s, k) => s === "idle" && bgRunning(k);
const bgRunning = (k) => k?.records?.bg?.state === "working";
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  const word = s === "error" ? "blocked" : s === "done" ? "idle" : s;
  return waits(word, k) ? "waiting" : word; // agent-deck: by the word it shows
};
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const SECTION = { 5: "Needs you", 4: "Done", 3: "Working", 2: "Waiting", 1: "Idle" };
const SECTION_STATUS = { 5: "blocked", 4: "done", 3: "working", 2: "waiting" };

// A label shows on its terminal's card: resolve the target's terminal live, so a prompt that
// outlived its agent cannot pass for the session someone is looking at. `terminals()` is empty
// right after a start (first read pending) — unknown, which is why only forget paths need
// `terminals().length`.
const liveTerminal = (address) => {
  const a = String(address ?? "").trim();
  return (a && terminals().find((k) => k.address === a && k.state === "live")) || null;
};
// A meta file that is missing or half-written reads as empty, never as a binding.
const jsonOf = (text) => {
  try { return JSON.parse(text ?? "{}") ?? {}; } catch { return {}; }
};

// The agent whose card is in front: the active space's active tab's focused pane. `focused()` is
// null whenever a mod overlay (toast, dialog) has the keyboard, which is exactly when a prompt is
// pressed, so the front is read from the layout instead. No active space, no active tab, or no
// focused terminal → null, which the caller treats as unknown (fail closed: one named press first).
function frontTerminal() {
  const space = spaces().find((s) => s.active);
  const tab = space?.tabs?.find((x) => x.active);
  if (!tab) return null;
  return panes().find((p) => p.tab === tab.id && p.terminal && p.focused)?.terminal ?? null;
}

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class Agents extends View {
  init(_props, cx) {
    const bind = props()?.prismBind;
    if (bind) return this.initPrismBind(String(bind), cx);
    if (props()?.sortMenu) return;
    this.folded = new Set();
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.pins = JSON.parse(localStorage.getItem("pins") ?? "[]");
    cx.timer.every(30000, (cx) => cx.notify());
    // agent-deck: prism-link failures arrive as JSON files; show one toast each.
    // The CLI creates the directory on its first failure, so a missing dir or a
    // replaced one (deleted between runs) must retry rather than end the watch.
    this.seenPrismErrors = new Map();
    this.prismSwipe = null; // { address, from, travel } while a chip is being dragged
    this.prismWheel = null; // { address, travel } while a trackpad swipe crosses a chip
    cx.spawn(async (cx) => {
      const dir = `${home()}/.local/state/prism-link/events`;
      for (;;) {
        let paths = [];
        try { paths = await watchFolder(dir); } catch {
          // The mod runtime has no setTimeout; the host timer is owner-scoped, so it dies with the tab.
          await new Promise((resolve) => cx.timer.after(3000, () => resolve()));
          continue;
        }
        for (const p of paths) if (p.endsWith(".json")) this.prismEvent(p);
      }
    });
    // The prompt itself is derived on every render from the shared targets (`prismPrompts`), so a
    // restart only has to drop the targets that were bound or died meanwhile.
    cx.spawn(async () => this.prunePrism());
    cx.timer.every(60000, () => { this.prunePrism().catch(() => {}); });
    if (NAME_TABS) {
      this.named = JSON.parse(localStorage.getItem("namedTabs") ?? "{}"); // tab -> the name this gave it
      cx.timer.every(3000, () => this.nameTabs());
    }
    // agent-deck: each review's last state, for one ready toast per readiness (review.js).
    this.reviewSeen = JSON.parse(localStorage.getItem("reviewSeen") ?? "{}");
    this.reviewTabs = {}; // review -> the tab this deck opened for it, until its label is back
  }

  // agent-deck: the 评审 chip's click (review.js openReview). A tab.new is in flight until its tab
  // shows up in spaces() (catchReviewTab) or 5 s pass; clicks meanwhile open nothing more.
  openReviewTab(address, space, chip, name) {
    if (this.opening && Date.now() < this.opening.until) return;
    const tabs = spaces().flatMap((s) => s.tabs);
    const act = openReview({ chip, address, tabs, known: this.reviewTabs[chip.review], name, space });
    if (act.cmd === "tab.new") this.opening = { address, review: chip.review, name: act.args.name, before: new Set(tabs.map((t) => t.id)), until: Date.now() + 5000 };
    run(act.cmd, act.args);
  }

  // agent-deck: run() gives no tab id: the new tab with the asked name is it; label the agent with it.
  catchReviewTab(tabs) {
    const o = this.opening;
    if (!o) return;
    const id = newTab(o.before, tabs, o.name);
    if (!id && Date.now() < o.until) return;
    this.opening = null;
    if (!id) return;
    this.reviewTabs[o.review] = id;
    hc(["label", o.address, `herdr.review_tab=${tabLabel(id, o.address)}`]).catch(() => {});
  }

  // agent-deck: a toast when a review turns ready (once per readiness, across re-renders and restarts).
  reviewNotices(all, nameOf) {
    const reviews = all.map((k) => ({ k, c: reviewChip(k.labels) })).filter((x) => x.c);
    const { notify: ready, seen } = readyNotices(this.reviewSeen, reviews.map((x) => ({ review: x.c.review, state: x.c.state })), Date.now());
    if (JSON.stringify(seen) !== JSON.stringify(this.reviewSeen)) localStorage.setItem("reviewSeen", JSON.stringify(seen));
    this.reviewSeen = seen;
    for (const review of ready) {
      const k = reviews.find((x) => x.c.review === review).k;
      notify({ title: "评审导览已就绪", body: nameOf(k), level: "success", timeout: 10000, action: { name: "pane.focus", args: { terminal: k.address } } });
    }
  }

  // agent-deck: a prism-link event file: a failed link (a toast) or the collector saying this
  // session has no requirement (the prompt that stays).
  async prismEvent(file) {
    let e = {};
    try { e = JSON.parse((await readTextFile(file)) ?? "{}"); } catch { return; }
    if (e.kind === "unlinked") this.prismUnlinked(e);
    else this.prismFailure(e);
  }

  // agent-deck: read one prism-link failure file and post a toast (5 min dedupe).
  prismFailure(e) {
    const key = `${e.branch ?? ""}|${e.reason ?? ""}`;
    const now = Date.now();
    if (now - (this.seenPrismErrors.get(key) ?? 0) < 5 * 60 * 1000) return;
    this.seenPrismErrors.set(key, now);
    notify(prismToastPayload(e));
  }

  // agent-deck: remember the session so its card's chip can bind it (prism-bind.js mergeUnlinked
  // decides what the event is worth: a bound tab is not asked again, and one session per card).
  prismUnlinked(e) {
    const terminal = String(e?.terminal ?? "").trim();
    const next = mergeUnlinked(shared(BIND_TARGETS), e, liveTerminal(terminal));
    if (next) setShared(BIND_TARGETS, next);
  }

  // The requirement a session reports to: its own meta, or a project-wide `--scope project` link
  // (linkedReqId). The terminal's `req` label is checked where the chip is derived.
  async linkedPrism(target) {
    const dir = `${target.cwd}/.prism`;
    const [own, project] = await Promise.all([
      readTextFile(`${dir}/${target.session}/meta.json`).catch(() => null),
      readTextFile(`${dir}/meta.json`).catch(() => null),
    ]);
    return linkedReqId(jsonOf(own), jsonOf(project));
  }

  // agent-deck: drop the targets that can no longer ask anything — the session got linked (its
  // meta, or an explicit project link), its tab carries the `req` label the CLI writes, or the
  // terminal is gone. Age and count never drop one: the chip waits for the person. The meta reads
  // run together: this is UI-thread work every minute, not a loop of round trips.
  async prunePrism() {
    const known = terminals().length > 0;
    const targets = { ...(shared(BIND_TARGETS) ?? {}) };
    const sessions = Object.keys(targets);
    const drops = await Promise.all(sessions.map(async (session) => {
      const target = targets[session];
      if (!target?.cwd) return true;
      if (!known) return false;
      const live = liveTerminal(target.terminal);
      if (!live) return true;
      if (String(live.labels?.req ?? "").trim()) return true;
      return Boolean(await this.linkedPrism({ ...target, session }));
    }));
    for (const [i, drop] of drops.entries()) if (drop) delete targets[sessions[i]];
    if (drops.includes(true)) setShared(BIND_TARGETS, targets);
    // A dismissal belongs to the card, so it ends with it: a terminal that went away may come
    // back as another agent, and that one must be asked.
    const dismissed = shared(BIND_DISMISSED) ?? {};
    if (known) {
      const live = new Set(terminals().map((k) => String(k.address ?? "")));
      const kept = Object.fromEntries(Object.entries(dismissed).filter(([address]) => live.has(address)));
      if (Object.keys(kept).length !== Object.keys(dismissed).length) setShared(BIND_DISMISSED, kept);
    }
  }

  forgetPrism(session) {
    const targets = { ...(shared(BIND_TARGETS) ?? {}) };
    if (!(session in targets)) return;
    delete targets[session];
    setShared(BIND_TARGETS, targets);
  }

  // A drag on a card's prompt. Held on the view, not in the render, so the fade's repaint does not
  // restart the gesture, and the chip hands over where the press landed. Positions are the chip's
  // own, so the row must not continue a drag it did not start (a different origin would read as
  // one huge jump); a swipe across the whole card is the trackpad path (wheelTravel).
  prismDragStart(address, x, cx) {
    this.prismSwipe = { address, ...swipeStart(x) };
    cx.stop_propagation();
  }

  prismDragMove(address, e, cx) {
    if (this.prismSwipe?.address !== address) return;
    const next = swipeMove(this.prismSwipe, e?.local_position?.x);
    // Repaint only when the fade crosses a step: each repaint redraws the window.
    if (next.step !== this.prismSwipe.step) cx.notify();
    this.prismSwipe = next;
    // Dismiss the moment it is far enough, so a release outside the chip cannot leave it faded.
    if (!swipePast(next.travel)) return;
    this.prismSwipe = null;
    this.dismissPrism(address, cx);
  }

  prismDragEnd(cx) {
    if (!this.prismSwipe) return;
    this.prismSwipe = null;
    cx.notify();
  }

  // The chip under an agent's name: one per card (prismPrompts), so the prompt says whose binding
  // it is and lives with the card instead of stacking in the window's corner. A press opens the
  // dialog; travel past SWIPE_PX — dragged or swept on a trackpad — dismisses the card.
  prismPrompt(target) {
    const address = String(target.terminal ?? "");
    return prismPromptChip(theme(), {
      address,
      dx: this.prismSwipe?.address === address ? this.prismSwipe.travel : 0,
      onDown: (x, cx) => this.prismDragStart(address, x, cx),
      onMove: (e, cx) => this.prismDragMove(address, e, cx),
      onUp: (_e, cx) => this.prismDragEnd(cx),
      onLeave: (cx) => { if (this.prismSwipe?.address === address) this.prismDragEnd(cx); },
      onWheel: (e, cx) => {
        const state = this.prismWheel?.address === address ? this.prismWheel : { address, travel: 0 };
        const next = wheelTravel(state, e);
        if (swipePast(next.travel, SWIPE_WHEEL_PX)) {
          this.prismWheel = null;
          this.dismissPrism(address, cx);
          return;
        }
        this.prismWheel = next.ended ? null : { address, travel: next.travel };
      },
      // The click a swipe ends with must not open the dialog it was dismissing.
      onOpen: () => {
        this.prismWheel = null;
        if (Date.now() - (this.prismSwipedAt?.[address] ?? 0) < 400) return;
        this.openPrismBind(String(target.session));
      },
    });
  }

  // Dismissing is per card and outlives the app: the person said this agent must stop asking.
  dismissPrism(address, cx) {
    (this.prismSwipedAt ??= {})[address] = Date.now();
    setShared(BIND_DISMISSED, { ...(shared(BIND_DISMISSED) ?? {}), [address]: Date.now() });
    cx.notify();
  }

  // agent-deck: a two-finger tap (the secondary click) on an agent card opens the picker for that
  // terminal. A normal click keeps its meaning: focus the pane (ticket 06).
  openPickerFor(a, cx) {
    cx.stop_propagation();
    run("pane.focus", { pane: a.pane });
    const session = this.sessionOf(a.address);
    const live = liveTerminal(a.address);
    // A session id is a bonus, not a prerequisite: without one the dialog binds by terminal
    // (`link --terminal-only`). The overlay's props key must still be truthy — `render()` uses it
    // to tell the dialog copy from the deck, and `""` made the overlay draw the whole deck.
    const key = session || `t:${a.address}`;
    this.openPrismBind(key, { session, terminal: a.address, cwd: String(live?.cwd ?? ""), branch: "" }, a.address);
  }

  // The session behind a terminal: what the unlinked prompt recorded, else the agent's own
  // `--resume <id>` argument (Claude Code and omp both start that way).
  sessionOf(address) {
    for (const [sid, target] of Object.entries(shared(BIND_TARGETS) ?? {})) {
      if (target?.terminal === address) return String(sid);
    }
    const argv = terminals().find((x) => x.address === address)?.foreground?.argv ?? [];
    const at = argv.indexOf("--resume");
    return at >= 0 ? String(argv[at + 1] ?? "") : "";
  }

  openPrismBind(session, target = null, from = null) {
    // The agent in front is read here, in a copy that still sees the layout: the dialog itself
    // owns the keyboard and cannot tell. No `modal`: a click beside the dialog closes it, and Esc
    // still works while it holds the keyboard (ticket 06).
    openOverlay({
      mod: "agent-deck-agents", kind: "dialog", width: 720, height: 560,
      props: { prismBind: session, prismFrom: from ?? frontTerminal() ?? "", ...(target ? { prismTarget: target } : {}) },
    });
  }

  // The dialog copy. Targets are read from `shared` on every use, so a target the other copy
  // added or dropped is what binds.
  initPrismBind(session, cx) {
    this.bindSession = session;
    this.bindFrom = String(props()?.prismFrom ?? ""); // the agent in front when the prompt was pressed
    this.bindAckTerminal = ""; // the terminal 确认关联到 was pressed for: only it may write
    this.bindBusy = false;
    this.bindConfirm = false;
    this.bindError = "";
    this.bindText = "";
    // The list: one search box over the cached snapshot; status is a filter, not a search field.
    this.mineQuery = "";
    this.mineStatus = "全部";
    this.mineIndex = 0;
    this.mineAll = mineCache?.items ?? [];
    this.mineVisible = filterMine(this.mineAll, "", "全部");
    this.mineStatuses = mineStatuses(this.mineAll);
    this.mineFetchedAt = mineCache?.fetchedAt ?? null;
    this.mineStale = Boolean(mineCache?.stale);
    this.mineError = String(mineCache?.error ?? "");
    this.mineLoading = false;
    this.input = InputState.new({ placeholder: "搜索标题或需求号，也可粘贴飞书链接" });
    // A new id is a new decision: the overwrite confirm belongs to the one that conflicted.
    this.input.on("change", (_e, cx) => {
      this.bindText = this.input.value();
      this.bindConfirm = false;
      this.mineQuery = this.bindText;
      this.applyMine(cx);
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.bindSelected(cx));
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.bindHandle = cx.focus_handle();
    this.bindLookup = null;
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.applyMine(cx);
    this.loadMine(false, cx);
    // The branch may already have a requirement: keep it as one candidate, not as the answer.
    this.lookupPrismBranch(cx);
  }

  applyMine(cx) {
    this.mineVisible = filterMine(this.mineAll ?? [], this.mineQuery, this.mineStatus);
    if (this.mineIndex >= this.mineVisible.length) this.mineIndex = Math.max(0, this.mineVisible.length - 1);
  }

  // `refresh` asks prism-link for a fresh snapshot; a failed refresh keeps what is on screen
  // (stale-while-revalidate) and only adds the error line.
  loadMine(refresh, cx) {
    const cached = mineCache;
    if (!refresh && cached && Date.now() - cached.at < MINE_TTL) {
      this.mineAll = cached.items;
      this.mineVisible = filterMine(this.mineAll, this.mineQuery, this.mineStatus);
      this.mineStatuses = mineStatuses(this.mineAll);
      this.mineFetchedAt = cached.fetchedAt;
      this.mineStale = Boolean(cached.stale);
      this.mineError = String(cached.error ?? "");
      cx.notify();
      return;
    }
    if (this.mineLoading) return;
    this.mineLoading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      let parsed;
      try {
        parsed = parseMine(await exec("env", mineArgv(prismCli(home()), refresh), { timeout: 20000 }));
      } catch (e) {
        parsed = { items: this.mineAll ?? [], fetchedAt: this.mineFetchedAt, stale: true, error: `无法运行 prism-link mine: ${e?.message ?? e}` };
      }
      this.mineLoading = false;
      this.mineFetchedAt = parsed.fetchedAt ?? this.mineFetchedAt;
      this.mineStale = Boolean(parsed.stale || parsed.error);
      this.mineError = String(parsed.error ?? "");
      if (Array.isArray(parsed.items) && parsed.items.length) {
        this.mineAll = parsed.items;
        mineCache = { items: parsed.items, fetchedAt: parsed.fetchedAt, at: Date.now(), stale: this.mineStale, error: this.mineError };
      }
      this.mineStatuses = mineStatuses(this.mineAll);
      this.applyMine(cx);
      cx.notify();
    });
  }

  pickMine(id, cx) {
    const at = (this.mineVisible ?? []).findIndex((i) => String(i.id) === String(id));
    if (at >= 0) this.mineIndex = at;
    cx.notify();
  }

  // Enter / 关联: a typed number or link wins; otherwise the highlighted row is the answer.
  bindSelected(cx) {
    const typed = storyInput(this.input?.value() ?? this.bindText);
    if (typed.error) {
      const item = this.mineVisible?.[this.mineIndex];
      if (!item) {
        this.bindError = "选择一条需求，或填写需求号/链接";
        cx.notify();
        return;
      }
      this.input.set_value(String(item.id));
      this.bindText = String(item.id);
      this.bindConfirm = false;
    }
    this.savePrismBind(cx);
  }

  // A card's requirement title, when the cached snapshot knows it (the card shows id · title).
  mineTitle(id) {
    const hit = (mineCache?.items ?? []).find((i) => String(i.id) === String(id));
    return hit?.title ?? "";
  }

  // What this checkout's branch is bound to: `link --branch-only --dry-run` asks only
  // getStoryInfoByBranchName (10 s in prism_link.py), writes nothing, and reports the branch it
  // actually asked about — the event's branch may be from before a switch.
  lookupPrismBranch(cx) {
    const target = this.bindTarget();
    // The branch lookup asks prism-link with `--session-id`; with no session (a picker opened on
    // an agent whose id we cannot know) it would fail with "缺 session_id" and paint a red line
    // that has nothing to do with binding. The branch is a bonus candidate anyway.
    if (!target?.cwd || !String(target?.session ?? "").trim()) {
      this.bindLookup = {};
      cx.notify();
      return;
    }
    this.bindLookup = "busy";
    cx.notify();
    cx.spawn(async (cx) => {
      let result;
      try {
        result = parseLinkResult(await exec("env", lookupArgv(prismCli(home()), target), { timeout: 20000 }));
      } catch (e) {
        result = { ok: false, error: `无法查询分支: ${e?.message ?? e}` };
      }
      // Exit 4 is an answer ("no requirement on this branch"), not an error.
      this.bindLookup = result.ok
        ? { id: result.reqId, name: result.storyName, source: result.source, branch: result.branch || target.branch }
        : result.unresolved ? { branch: result.branch || target.branch } : { error: result.error };
      cx.notify();
    });
  }

  // "使用 <id>": the found requirement is the input, and the same press binds it.
  usePrismStory(id, cx) {
    if (!id || this.bindBusy) return;
    this.input.set_value(String(id));
    this.bindText = String(id);
    this.bindConfirm = false;
    this.savePrismBind(cx);
  }

  bindTarget() {
    return (shared(BIND_TARGETS) ?? {})[this.bindSession] ?? props()?.prismTarget ?? null;
  }

  savePrismBind(cx) {
    if (this.bindBusy) return;
    const target = this.bindTarget();
    const note = bindTargetNote(target, liveTerminal(target?.terminal), this.bindFrom, bindAcked(target, this.bindAckTerminal));
    const text = storyInput(this.input?.value() ?? this.bindText);
    const problem = text.error || note.problem;
    // A gone terminal, or one that is not the agent in front of you (a prompt restored hours
    // later), keeps its reason on the dialog's identity line and leaves only 确认关联到 <agent> as
    // the primary press. Only after that very address was confirmed does 关联 come back. A stale
    // prompt must never label another agent's card on the first press.
    if (problem || note.other) {
      if (text.error) this.bindError = text.error;
      cx.notify();
      return;
    }
    this.bindBusy = true;
    this.bindError = "";
    const confirm = this.bindConfirm;
    cx.notify();
    cx.spawn(async (cx) => {
      let result;
      try {
        result = parseLinkResult(await exec("env", bindArgv(prismCli(home()), target, text.value, confirm)));
      } catch (e) {
        result = { ok: false, error: `无法运行 prism-link: ${e?.message ?? e}` };
      }
      this.bindBusy = false;
      if (!result.ok) {
        // prism-link refused to replace a different story: say which one, and make the next
        // press the one that forces. Every other refusal stays a plain error.
        this.bindConfirm = Boolean(result.conflict);
        this.bindError = result.conflict
          ? `${result.error}${result.existing ? `（现有 ${result.existing}）` : ""} · 要改绑请再点「覆盖关联」`
          : result.error;
        cx.notify();
        return;
      }
      this.forgetPrism(String(this.bindSession));
      closeOverlay(props().overlay);
      const branch = this.bindLookup?.branch || target.branch;
      notify({ title: "prism 已关联", body: `${result.reqId || text.value}${branch ? ` · ${branch}` : ""}`, level: "success", timeout: 5000 });
    });
  }

  // Closed without binding: the chip is derived from the target on every render, so cancelling
  // needs nothing put back — the same target still asks on the card.

  // agent-deck: see NAME_TABS.
  nameTabs() {
    const byTab = {};
    for (const a of agents()) (byTab[a.tab] ??= []).push(a);
    const tabs = spaces().flatMap((s) => s.tabs);
    const named = {};
    for (const tab of tabs) {
      const mine = this.named[tab.id];
      const own = !tab.named || (mine != null && tab.name === mine);
      if (own && mine != null) named[tab.id] = mine;
      const list = byTab[tab.id] ?? [];
      const want = list.length === 1 ? chatTitle(list[0]) : null;
      if (!own || !want || tab.name === want) continue;
      run("tab.rename", { id: tab.id, name: want });
      named[tab.id] = want;
    }
    this.named = named;
    localStorage.setItem("namedTabs", JSON.stringify(named));
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  setPins(pins) {
    this.pins = pins;
    localStorage.setItem("pins", JSON.stringify(pins));
  }

  // Drops pins of agents that ended. Only for machines the list has heard from:
  // right after a start, or while a machine connects, its agents aren't listed yet.
  prunePins(all) {
    const machine = (addr) => (addr.includes("/") ? addr.split("/")[0] : "");
    const heard = new Set(all.map((k) => machine(k.address)));
    const live = new Set(all.filter((k) => k.state === "live").map((k) => k.address));
    const kept = this.pins.filter((p) => !heard.has(machine(p)) || live.has(p));
    if (kept.length !== this.pins.length) this.setPins(kept);
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  // Looking at a done agent makes it idle; it stays with Done until you leave
  // it rather than drop away under you. Any other change moves it at once.
  hold(list) {
    const cur = list.find((a) => a.focused);
    const same = cur && cur.address === this.held?.address;
    // Arriving, or any change but done turning idle, sets what it was.
    // agent-deck: a seen done agent with background work turns waiting, not idle.
    if (!same || !(cur.status === "idle" || cur.status === "waiting")) this.held = cur ? { address: cur.address, rank: RANK[cur.status] ?? 0 } : null;
  }

  rank(a) {
    const sawDone = a.address === this.held?.address && this.held.rank === RANK.done && (a.status === "idle" || a.status === "waiting");
    return sawDone ? RANK.done : RANK[a.status] ?? 0;
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Sort agents"))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("agents.sort", s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  // The prism bind dialog: one input for a story link or number, and what prism-link said when
  // it refused it (prism-bind.js lays out the rest, so a native check can render it alone).
  prismBindDialog(t) {
    const target = this.bindTarget();
    return prismBindView(t, {
      target,
      note: bindTargetNote(target, liveTerminal(target?.terminal), this.bindFrom, bindAcked(target, this.bindAckTerminal)),
      input: this.input,
      query: this.mineQuery ?? "",
      status: this.mineStatus ?? "全部",
      statuses: this.mineStatuses ?? ["全部"],
      items: this.mineVisible ?? [],
      index: this.mineIndex ?? 0,
      fetchedAt: this.mineFetchedAt ?? null,
      stale: Boolean(this.mineStale),
      loading: Boolean(this.mineLoading),
      error: this.mineError ?? "",
      errorParams: this.bindError,
      handle: this.bindHandle,
      busy: this.bindBusy,
      confirm: this.bindConfirm,
      lookup: lookupNote(this.bindLookup, this.bindLookup?.branch || target?.branch),
      onUse: (id, cx) => this.usePrismStory(id, cx),
      onLookup: (cx) => this.lookupPrismBranch(cx),
      onQuery: (cx) => { this.mineQuery = this.input?.value() ?? ""; this.applyMine(cx); cx.notify(); },
      onStatus: (status, cx) => { this.mineStatus = status; this.mineIndex = 0; this.applyMine(cx); cx.notify(); },
      onPick: (id, cx) => this.pickMine(id, cx),
      onMove: (delta, cx) => { this.mineIndex = moveIndex(this.mineIndex ?? 0, delta, (this.mineVisible ?? []).length); cx.notify(); },
      onRefresh: (cx) => this.loadMine(true, cx),
      onBind: (cx) => this.bindSelected(cx),
      // 确认关联到 <agent>: the press is the acknowledgement of that address. Showing it is best
      // effort — `run()` reports no outcome — so the dialog never claims the agent was shown.
      onAck: (cx) => {
        this.bindAckTerminal = String(target?.terminal ?? "");
        if (target?.terminal) run("pane.focus", { terminal: target.terminal });
        cx.notify();
      },
      onCancel: () => closeOverlay(props().overlay),
    });
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  subRow(t, s, shown, compact) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.peek(k.address))
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, { status: st }, compact));
  }

  // compact: a ! for blocked where a header already says "Needs you".
  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    // agent-deck: waiting spins slower, in its own color (theme "waiting", else muted).
    if (a.status === "waiting") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.waiting ?? t.muted ?? t.dim).spin(2400);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    // Idle: a ring; done: a dot.
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  // agent-deck: Copy link on a Claude Code card, as in the Overview: a herdr-resume:// link
  // to its session (resume.js). The id is read on click from the pid of the terminal's
  // program and ~/.claude/sessions/<pid>.json on its machine. The icon says how it went for 2 s.
  copyLink(address, cx) {
    if (this.linkState?.address === address && this.linkState.state === "busy") return;
    const mark = (state, cx) => { this.linkState = { address, state }; cx.notify(); };
    mark("busy", cx);
    cx.spawn(async (cx) => {
      let id = null;
      try {
        let pid = terminals().find((x) => x.address === address)?.foreground?.pid;
        if (!Number.isInteger(pid)) pid = JSON.parse((await hc(["get", address, "--json"])).stdout)?.foreground?.pid;
        const m = machineOf(address);
        if (Number.isInteger(pid)) {
          const r = await hc(["exec", ...(m ? ["--on", m] : []), "--timeout", "20", "--", "sh", "-c", SESSION_OF, "sh", String(pid)]);
          id = sessionFrom(r.stdout);
        }
        if (id) cx.write_to_clipboard(resumeLink(m, id));
      } catch {}
      const state = id ? "copied" : "failed";
      mark(state, cx);
      cx.timer.after(2000, (cx) => { if (this.linkState?.address === address && this.linkState.state === state) { this.linkState = null; cx.notify(); } });
    });
  }

  linkButton(t, address) {
    const st = this.linkState?.address === address ? this.linkState.state : null;
    return div().id(`ag-link-${address}`).flex_none().p(2).rounded(4).cursor_pointer()
      .text_color(st === "copied" ? t.ansi2 ?? t.foreground : st === "failed" ? t.blocked : t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(st === "copied" ? "Link copied" : st === "failed" ? "No session to link yet (send it a message first)" : "Copy a herdr-resume:// link to this session")
      .on_click((_e, cx) => { cx.stop_propagation(); this.copyLink(address, cx); })
      .child(svg("mods/agent-deck-agents/link.svg").size(12));
  }

  render(cx) {
    const t = theme();
    if (props()?.prismBind) return this.prismBindDialog(t, cx);
    if (props()?.sortMenu) return this.sortMenu(t);
    const collapsed = narrow();
    const sort = sortOf();
    const all = terminals();
    // agent-deck: agents at rest with background work show as waiting.
    const byAddress = new Map(all.map((k) => [k.address, k]));
    let list = agents().map((a) => (waits(a.status, byAddress.get(a.address)) ? { ...a, status: "waiting" } : a));
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    this.hold(list);
    const byPriority = sort.id === "priority";
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    this.prunePins(all);
    const pinned = this.pins.map((p) => list.find((a) => a.address === p)).filter(Boolean);
    const rest = list.filter((a) => !this.pins.includes(a.address));
    list = [...pinned, ...rest];
    setAgentOrder(list.map((a) => a.address));
    // agent-deck: each task on the rail gets its color (badge.js): the person's pick from the
    // label editor (shared "agent-deck.task-colors"), else one worked out so tasks on screen
    // don't share. this.taskColors keeps a task's color while it stays listed.
    const badges = new Map(list.map((a) => [a.address, labelBadge(byAddress.get(a.address)?.labels)]));
    this.taskColors = assignColors(list.map((a) => badges.get(a.address)?.key).filter(Boolean), shared("agent-deck.task-colors") ?? {}, this.taskColors ?? {});
    const dark = settings()?.dark !== false;

    const withKids = (a, i) => {
      const subs = collapsed ? [] : this.tree(all, a.address);
      const r = row(a, i, subs);
      if (this.folded.has(a.address)) return [r];
      return [r, ...subs.map((s) => this.subRow(t, s, shown, byPriority))];
    };

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    // A row reads "space \u00b7 detail": the detail is a tab someone named or the
    // agent's own title, never an automatic tab number unless two rows would
    // otherwise read the same.
    const tabs = spaces().flatMap(s => s.tabs);
    // agent-deck: a tab someone named wins, so the rail reads what the tab bar reads
    // (renaming the tab renames the row); else the agent's own title (Claude's chat name).
    const label = (a) => {
      const tab = tabs.find(t => t.id === a.tab);
      if (tab?.named && tab.name && tab.name !== a.program?.name) return tab.name;
      const live = liveTitle(a.title, a.program);
      return live ?? (tab ? title(tab, lead(tab)) : a.title || a.program?.name || "");
    };
    const detail = new Map(list.map(a => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));
    }
    // agent-deck: the 评审 chip: a ready toast, and the tab a chip click just opened.
    this.reviewNotices(all, (k) => detail.get(k.address) ?? k.name ?? k.program?.name ?? k.address);
    this.catchReviewTab(tabs);
    // agent-deck: the prism prompt, one per card (prism-bind.js prismPrompts): the newest pending
    // session in each terminal that is not bound and not swiped away.
    const prompts = prismPrompts(shared(BIND_TARGETS) ?? {}, all, shared(BIND_DISMISSED) ?? {});

    const row = (a, i, subs = [], wide = false) => {
      const pic = icon(a.program, 16, t.foreground);
      const more = detail.get(a.address);
      // agent-deck: the guided review this agent's changes are in (`herdr.review*` labels, review.js).
      const review = reviewChipView(t, a.address, byAddress.get(a.address)?.labels, (c) => this.openReviewTab(a.address, a.space, c, more || a.program?.name || label(a)));
      // agent-deck: the requirement this session reports to (`hc label t7 req=… req_url=…`), or the
      // prompt asking for one. They are exclusive: prismPrompts skips a labelled terminal.
      const req = byAddress.get(a.address)?.labels?.req;
      const reqUrl = req ? reqUrlOf(byAddress.get(a.address)?.labels, req) : null;
      const prompt = req ? null : prompts.get(a.address);
      // agent-deck: on the rail, resting on a row shows its wide card beside it.
      if (collapsed && !wide) {
        const badge = badges.get(a.address);
        const style = badge && badgeStyle(this.taskColors[badge.key], dark);
        return HoverCard.new(`ag-hover-${a.address}`).anchor("left_center").open_delay(250)
          .content(v_flex().w(300).p(6).rounded(10).bg(t.popover).border(1).border_color(t.border).shadow_lg()
            .child(row(a, i, this.tree(all, a.address), true))
            .children(this.tree(all, a.address).map((s) => this.subRow(t, s, shown, false))))
          .trigger(h_flex()
          .id(`ag-${a.address}`)
          // agent-deck: the rail cell follows herdr-app PR #286 (the program's icon and the
          // status mark, centered); the current session also gets an accent border.
          .h(30)
          .flex_none()
          .rounded(8)
          .items_center()
          .justify_center()
          .gap(3)
          .when(a.focused, (el) => el.bg(t.selected).border(1).border_color(t.accent))
          .when(!a.focused, (el) => el.hover((s) => s.bg(t.hover)))
          .cursor_pointer()
          .on_click((e, cx) => (e?.modifiers?.platform ? this.openPickerFor(a, cx) : run("pane.focus", { pane: a.pane })))
          // agent-deck: a session with a task or role label shows their letters (badge.js) instead.
          .child(badge
            ? h_flex().h(18).min_w(22).px(3).flex_none().rounded(5).bg(style.bg).items_center().justify_center().text_size(10.5).font_bold().text_color(style.fg).child(badge.text)
            : pic ?? div().w(16).flex_none().text_center().text_size(11).text_color(a.focused ? t.foreground : t.muted).child(String(i + 1)))
          // agent-deck: a linked session keeps an orange dot on the rail.
          .when(Boolean(req), (el) => el.child(div().size(5).flex_none().rounded(3).bg(prismInk(dark))))
          // agent-deck: an unbound agent keeps a hollow amber dot: the wide card says 未关联.
          .when(Boolean(prompt), (el) => el.child(div().size(5).flex_none().rounded(3).border(1).border_color(t.working)))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true))));
      }
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const isPinned = this.pins.includes(a.address);
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.setPins(isPinned ? this.pins.filter((p) => p !== a.address) : [...this.pins, a.address]);
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      // Under a space header the space goes without saying; an automatic tab number says nothing.
      // Without a space header above (priority, pinned) the row names its space.
      const full = byPriority || isPinned;
      // agent-deck: the chat name leads; the space follows, dimmed.
      const name = full ? more || a.space_name || label(a) : more ?? (/^\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a));
      // agent-deck: a two-line card: name, then the space chip.
      return v_flex()
        .id(`ag-${a.address}`)
        .mb(4)
        .px(8)
        .py(7)
        .gap(5)
        .flex_none()
        .rounded(8)
        .bg(a.focused ? t.selected : t.surface)
        .border(1)
        .border_color(a.focused ? t.accent : t.border)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click((e, cx) => (e?.modifiers?.platform ? this.openPickerFor(a, cx) : run("pane.focus", { pane: a.pane })))
        .child(h_flex().items_center().gap(9).min_w(0)
          .when(Boolean(pic), el => el.child(div().id(`agent-fold-${a.address}`)
            .when(subs.length > 0, el => el.on_click((_e, cx) => {
              cx.stop_propagation();
              this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
              cx.notify();
            })).child(pic)))
          .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(idle ? t.muted : t.foreground).child(name))
          .when(subs.length > 0, el => el.child(fold(a, subs)))
          // agent-deck: Copy link (Claude Code only), on hover or while it says how it went.
          .when(a.program?.key === "claude" && (this.hovered === a.address || this.linkState?.address === a.address), el => el.child(this.linkButton(t, a.address)))
          .when(this.hovered === a.address, el => el.child(pin))
          .when(this.hovered !== a.address && Boolean(when), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when))))
          .child(this.status(t, a, byPriority && !isPinned)))
        .child(h_flex().items_center().gap(4).min_w(0).pl(25)
          .when(Boolean(a.space_name), el => el.child(chip(`space-${a.address}`, a.space_name, t.muted, { edge: t.border })
            .flex_shrink_1().min_w(0).truncate()))
          // agent-deck: the requirement this session reports to, in words, one tone apart from the
          // unbound prompt; the number and the title are in the tooltip. Opens it in Feishu.
          .when(Boolean(req), el => el.child(chip(`prism-${a.address}`, "已关联", prismInk(dark), {
            press: (e, cx) => {
              cx.stop_propagation();
              if (e?.modifiers?.platform) return this.openPickerFor(a, cx);
              // agent-deck: no base to open in yet — say so instead of doing nothing.
              if (!reqUrl) {
                notify({
                  title: "飞书基址未设置",
                  body: `setShared("prism.feishu", "https://project.feishu.cn/<空间>") · 或让终端带上 req_url（${req}）`,
                  level: "warning",
                  timeout: 12000,
                });
                return;
              }
              exec("open", [reqUrl]);
            },
          })
            .flex_none()
            .tooltip(reqUrl
              ? `${cardLabel(req, this.mineTitle(req))} · 点击打开飞书 · ⌘点击改绑`
              : `${cardLabel(req, this.mineTitle(req))} · 未设置 prism.feishu：点击看怎么设`)))
          // agent-deck: the prompt for a session no requirement covers. It sits on this card, is
          // opened by a press, and is swiped away by a drag (prismPrompt).
          .when(Boolean(prompt), el => el.child(this.prismPrompt(prompt)))
          // agent-deck: the review chip; opens or selects the review's Guide tab.
          .when(Boolean(review), el => el.child(review)));
    };

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    for (const a of rest) {
      const r = rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "", status: byPriority ? SECTION_STATUS[r] : null, members: [a] });
    }

    // A group's header; it folds the group. Folded, it says how many and the most urgent state.
    const header = (g) => {
      const open = !this.folded.has(g.id);
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      return h_flex()
        .id(g.id)
        .px(8)
        .pt(8)
        .h(30)
        .flex_none()
        .gap(6)
        .items_center()
        .text_size(11)
        .font_medium()
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        .child(div().truncate().text_color(t[g.status] ?? t.dim).child(g.label))
        .when(byPriority || !open, (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el
          .when(!byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)));
    };
    const rows = collapsed
      ? list.flatMap(withKids)
      : groups.flatMap((g) => [header(g), ...(this.folded.has(g.id) ? [] : g.members.flatMap(withKids))]);

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      // agent-deck: the layout's divider above is the line (and the grab handle), so no top border.
      .text_size(13)
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .px(16)
            .h(41)
            .pt(14)
            .pb(5)
            .flex_none()
            .items_center()
            .justify_between()
            // agent-deck: the header rolls Spaces up or down.
            .child(
              h_flex()
                .id("ag-spaces-fold")
                .flex_1()
                .gap(4)
                .items_center()
                .cursor_pointer()
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(toggleSpaces)
                .tooltip(spacesHidden() ? "Show Spaces" : "Roll up Spaces")
                .child(div().text_size(11.5).font_medium().child("Agents"))
                .child(svg(`mods/workspace-chrome/chevron-${spacesHidden() ? "right" : "down"}.svg`).size(12)),
            )
            .child(
              div()
                .id("ag-sort")
                .text_size(11)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(() => openOverlay({ mod: "agent-deck-agents", kind: "popup", width: 200, height: 140, props: { sortMenu: true } }))
                .tooltip(`Sort agents: ${sort.label}`)
                .child(svg(`mods/workspace-chrome/${sort.icon}.svg`).size(14)),
            ),
        ),
      )
      .when(list.length === 0 && !collapsed, (el) =>
        el.child(div().px(12).text_size(12).text_color(t.dim).child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      // agent-deck: on the rail, the same toggle sits above the list.
      .when(collapsed, (el) =>
        el.child(
          h_flex()
            .id("ag-spaces-fold")
            .h(20)
            .flex_none()
            .justify_center()
            .items_center()
            .cursor_pointer()
            .text_color(t.dim)
            .hover((s) => s.text_color(t.foreground))
            .on_click(toggleSpaces)
            .tooltip(spacesHidden() ? "Show Spaces" : "Roll up Spaces")
            .child(svg(`mods/workspace-chrome/chevron-${spacesHidden() ? "right" : "down"}.svg`).size(12)),
        ),
      )
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(collapsed ? 4 : 8).when(collapsed, (el) => el.pt(6).gap(2)).overflow_y_scrollbar().mode("always").children(rows))
      .child(
        h_flex()
          .h(28)
          .px(12)
          .items_center()
          .justify_between()
          .when(collapsed, (el) => el.flex_col().h(76).gap(8).justify_center().px(0))
          // agent-deck: the all-machines overview (cmd-shift-o; again closes it), and History:
          // search past Claude Code sessions on every machine.
          .child(
            h_flex()
              .gap(12)
              .items_center()
              .when(collapsed, (el) => el.flex_col().gap(8))
              .child(
                div()
                  .id("overview")
                  .text_color(t.dim)
                  .cursor_pointer()
                  .hover((s) => s.text_color(t.foreground))
                  .on_click(() => run("mod.open", { name: "agent-deck-overview" }))
                  .tooltip("Agents overview (⌘⇧O)")
                  .child(svg("mods/workspace-chrome/layers.svg").size(14)),
              )
              .child(
                div()
                  .id("history")
                  .text_color(t.dim)
                  .cursor_pointer()
                  .hover((s) => s.text_color(t.foreground))
                  .on_click(() => run("mod.open", { name: "agent-deck-history" }))
                  .tooltip("Search past sessions (History)")
                  .child(svg("mods/workspace-chrome/search.svg").size(14)),
              ),
          )
          // Herdr's rail control. agent-deck: on the wide sidebar too, as « (narrow) and » (back).
          .child(
            // agent-deck: a 26px button as in herdr-app PR #286, keeping the « / » marks.
            div()
              .id("collapse")
              .size(26)
              .flex()
              .flex_none()
              .items_center()
              .justify_center()
              .rounded(6)
              .text_size(13)
              .text_color(t.muted)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click(toggleSidebar)
              .tooltip(collapsed ? "Widen the Agents column" : "Narrow the Agents column")
              .child(collapsed ? "»" : "«"),
          ),
      );
  }
}
