// Tourist: Claude or Codex walks you through a branch, the last commit, the whole repo, or a feature you describe, one stop at a time.
// This file holds the view's state, keys and flow. The pieces it uses:
//   constants.js  scopes, depths, agents and other fixed tables
//   git.js        the folder to tour and its repo facts
//   agent.js      finding Claude or Codex and talking to it
//   plan.js       the prompts and reading the tour plan
//   code.js       a stop's lines, its editor, opening VS Code
//   ui.js         shared buttons, rows and inputs
//   files.js      grouping the PR's files for the file list
//   since.js      the commit you last reviewed a PR at, for re-reviews
//   checks.js     the PR's CI checks and failed logs
//   links.js      file:line references in the agent's text, as links that move the code
//   ticket.js     tours the tickets mod opens on a ticket's PR, and sending the review back to it
//   views/        the setup, tour, planning and error screens
import { View } from "gpui-kit";
import { v_flex, InputState, ScrollHandle } from "gpui-base";
import { nextCommand, panes, props, run, notify, shared, setShared, focused, closeOverlay, checking } from "herdr";
import { colors, SIZE, paneBackground, seeThroughOpacity } from "./kit/theme.js";
import { SCOPES, DEPTHS, PASSES, SPLIT_WIDTH, SHORTCUTS } from "./constants.js";
import { Shortcuts } from "./kit/shortcuts.js";
import { startFolder, readRepo, git, newFileDiff } from "./git.js";
import { AgentSession, agentName, findAgents, rememberAgent, savedModel, rememberModel } from "./agent.js";
import { listModels, cachedModels } from "./models.js";
import { subject, planPrompt, prSubject, prPlanPrompt, reqSubject, reqPlanPrompt, followUpPrompt, filePrompt, checkPrompt, fixPrompt, branchFixPrompt, fixReplyPrompt, parsePlan } from "./plan.js";
import { readExcerpt, openInEditor, openUrl } from "./code.js";
import { listPRs, loadPR, prFileDiff, prFileStats, listThreads, replyToThread, setThreadResolved } from "./pr.js";
import { lastReviewed, saveReviewed, haveCommit, changesSince } from "./since.js";
import { listChecks, failedLog } from "./checks.js";
import { groupFiles } from "./files.js";
import { diffRows, plainRows, splitDiff, markOutsidePR, rowsFor, nearestRow, windowRows } from "./diff.js";
import { linkify, readLink, resolver } from "./links.js";
import { highlightRows } from "./highlight.js";
import { loadSettings, readMine, refreshMine, loadRequirement, commitDiff, branchFileDiff } from "./requirement.js";
import { prFixTarget, branchFixTarget, openWorktree, worktreeDiff, pushFix, removeWorktree } from "./worktree.js";
import { commentKey, loadComments, saveComments, loadViewed, saveViewed, sideOf, rangeOf } from "./comments.js";
import { planKey, loadSavedPlan, savePlan, dropSavedPlan } from "./saved.js";
import { loadTabTour, saveTabTour, clearTabTour } from "./tours.js";
import { setupView } from "./views/setup.js";
import { tourView } from "./views/tour.js";
import { planningView, errorView } from "./views/status.js";
import { requireView } from "./views/require.js";
import { fixView } from "./views/fix.js";
import { postReview, eventsFor } from "./review.js";
import { reviewView } from "./views/review.js";
import { mergeMethods, mergePR } from "./merge.js";
import { mergeView } from "./views/merge.js";
import { checksView } from "./views/checks.js";
import { confirmDialog, pendingConfirm } from "./views/confirm.js";
import { ticketCommand, changesText, closeOwnTab, ownPane, ticketReviewKey, publishTicketReview } from "./ticket.js";

/** How many lines a scroll key moves the code. */
const CODE_SCROLL_LINES = 3;

/**
 * What the key (mod.open:tourist) does, in a tiny overlay copy that closes after: closes the
 * Tourist pane in the shown tab when there is one, otherwise opens one beside the focused pane.
 */
async function toggle(cx) {
  const tab = focused()?.tab;
  const open = panes().find((p) => p.mod === "tourist" && p.tab === tab);
  if (open) { run("pane.close", { pane: open.pane }); return; }
  run("pane.split", { direction: "right", mod: "tourist" });
  // "Open in full screen": zoom the new pane as soon as it exists, so the split barely shows.
  // A command applies after run returns, so the pane is looked for each frame (up to half a second).
  // The setting is shared by the panes (FULL), since this copy can't read their storage.
  if (shared(FULL) !== true) return;
  for (let i = 0; i < 30; i++) {
    const made = panes().find((p) => p.mod === "tourist" && p.tab === tab);
    if (made) { if (!made.zoomed) run("pane.zoom", { pane: made.pane }); return; }
    await new Promise((done) => cx.timer.after(16, done));
  }
}

/** The panes' "Open in full screen" setting, shared so the key's copy can read it. */
const FULL = "tourist.full";

export default class Tourist extends View {
  init(_props, cx) {
    // The key's copy: an overlay. Panes Tourist runs in have no overlay.
    this.launcher = props()?.overlay !== undefined;
    if (this.launcher) {
      const overlay = props()?.overlay;
      cx.spawn(async (cx) => { try { await toggle(cx); } finally { closeOverlay(overlay); } });
      return;
    }
    const start = startFolder();
    // Opened by the tickets mod on a ticket's PR: props { folder, pr, ticket: { number, root, title } }.
    // That repo is on this computer, whichever space is shown.
    this.ticket = props()?.ticket ?? null; this.ticketPR = Number(props()?.pr) || null;
    this.reviewTicket = null; // the full ticket used to plan this review, loaded when the tour starts
    this.ticketReviewActive = Boolean(this.ticket?.reviewId);
    this.ticketSubmission = this.ticket?.submission ?? "";
    this.ticketRequestSeen = this.ticketSubmission; this.ticketPendingSubmission = null;
    this.ticketWaiting = false; this.ticketRefreshing = false; this.ticketPolling = false;
    this.ticketDone = false;
    this.ticketPreviousFeedback = "";
    this.handBack = null; // sending the comments to the ticket's agent: { confirm, error }
    this.cwd = props()?.folder ?? start.cwd; this.on = this.ticket ? null : start.on;
    this.phase = "setup"; this.scope = "branch"; this.depth = "normal";
    this.git = { root: null, branch: "", base: null, mergeBase: null, changed: [], untracked: [], head: "" };
    this.plan = null; this.idx = 0; this.codeError = null;
    this.session = null;  // the AgentSession of the tour in progress
    this.busy = null; this.error = null;
    this.agents = []; this.agent = null; // installed agent ids, and the one tours use
    this.model = savedModel(); // omp's model for this tour: a selector, or null for omp's own default
    this.models = null; this.modelsError = null; this.modelsLoading = false; this.modelAll = false; // omp's models, loaded when the model step opens
    this.standardModel = null; // omp's own default selector, for the "default" row
    this.modelRoles = [];      // the roles' own models ({ role, selector }), listed first
    this.step = "scope"; // setup step: "scope" what to tour, "pr" which pull request, "depth" how deep
    this.prs = null; this.prsError = null; // the open PRs, loaded when the PR step opens (again after a failure)
    this.prNumber = null; this.pr = null;  // the picked PR, and its details once the tour starts
    // A requirement tour: the picker's list (prism-link's own cache), the picked requirement,
    // and the commit the browser shows. `reqChip` is the status filter's current name.
    this.reqs = null; this.reqsError = null; this.reqChip = "全部";
    this.reqItem = null;                    // the picker's row: { id, title, status }
    this.req = null; this.reqLoading = null; // the loaded requirement: projects, branches, commits
    this.reqSel = { p: 0, c: 0 };            // the commit the browser shows
    this.reqCommit = null;                   // { p, c, files: [{ file, rows }], loading, error }
    this.commentsKeyAt = null;               // which saved-comment file this.comments was read from
    // The terminal tab this pane sits beside: its tours are saved under that id, so a rebuilt
    // pane or a reopened tab comes back to the same tour instead of the agent planning again.
    this.tabId = null; this.paneId = null; this.tourStale = false;
    this.diff = null;     // the rows the code panel shows: the stop's file's diff, or its lines from disk
    this.diffMarks = null; // { stops: [{ index, title, row, current }], stopRows: [first, last] | null } for the shown diff
    this.linkRows = null;  // [first, last] rows a clicked file:line link points at
    this.diffScroll = ScrollHandle.new(); // the diff's scroll position, moved to a stop or a link
    this.codeTop = 0;   // the code row the scroll keys believe is at the top. A wheel scroll does not update it.
    this.codeFits = 20; // how many code rows fit in the code pane, set when it is laid out
    this.scrollReq = null; // { handle, row, step } while the diff is being scrolled (views/diff.js)
    this.repoFiles = new Set(); // every file in the repo (at the PR's head on PR tours), for resolving links
    this.planNote = null; // what planning is waiting on before the agent starts
    this.comments = [];   // line comments on the PR, saved by comments.js
    this.commenting = null; // { file, line, side, code, anchor, editId? } while the comment box is open
    this.threads = [];      // comment threads already on the PR on GitHub (pr.js listThreads)
    this.threadsLoaded = false; this.threadsError = null; this.threadsLoading = false;
    this.threadReply = null;  // the thread id whose reply box is open
    this.threadBusy = null;   // { id, note } while a reply or resolve is going to GitHub
    this.threadError = null;  // { id, text, draft } when GitHub refused one
    this.openResolved = new Set(); // resolved threads the reader expanded
    // Re-review: { number, oid, at }, the commit you last reviewed the picked PR at, when the PR
    // moved since. pass is "since" (only what changed since) or "whole".
    this.since = null; this.pass = "since"; this.sinceLoading = false;
    // The PR's CI checks: { number, list, loading, error, cursor, notes: { key: [{ label, text }] } }.
    this.checks = null;
    this.files = null;      // every file the PR changes, grouped for the file list (files.js)
    this.viewed = {};       // files marked viewed on this PR: { file: the head commit it was marked at }
    this.other = null;      // a PR file the tour doesn't stop at, while it's open instead of a stop
    this.showFiles = true;  // the file list beside a PR tour, toggled with l
    // The fix run on a PR: { phase: "running" | "ready" | "failed" | "pushing" | "pushed",
    // count, note, path, summary, replies, files, error, confirm }. Shown when phase is "fix".
    // replies: [{ text, answer }], the reader's replies to the fix agent and what it said back.
    this.fix = null; this.fixSession = null;
    this.replying = false; // the fix screen's reply box only exists while replying
    // Posting the comments to GitHub: { phase: "editing" | "posting" | "posted", cursor, confirm, url, error }.
    this.review = null;
    // Merging your own PR: { phase: "loading" | "picking" | "merging" | "merged", methods, cursor, confirm, error,
    // approve }. approve, on a ticket's tour: { phase: "approving" | "approved" | "failed", error } once merged.
    this.merge = null;
    this.cursor = 0;      // highlighted row in the current step
    this.split = null;    // null: split when the pane is wide enough. true or false: the s key chose
    this.width = 0;       // the pane width, from on_size_change
    this.height = 0;      // the pane height, for how tall the settings panel can be
    this.asking = false;  // the ask box only exists while asking, so it can't take tour keys
    this.typing = null;   // "ask" | "feature" while a text box has the keyboard
    this.explainScroll = ScrollHandle.new(); // the explanation's scroll position, moved to the bottom after asking
    this.input = this.textBox("ask", "就本站点提问，然后按 enter", cx => this.ask(cx));
    this.featureInput = this.textBox("feature", "例如：一个 space 如何得到它的提示字母", cx => this.pick(cx));
    this.reqFilterInput = this.textBox("reqfilter", "筛选：需求标题或编号，enter 下一步", cx => this.pick(cx));
    this.commentInput = this.textBox("comment", "在这一行写评论，然后按 enter", cx => this.saveComment(cx));
    this.summaryInput = this.textBox("summary", "可选", () => this.leaveBox());
    this.replyInput = this.textBox("reply", "回复 agent，然后按 enter", cx => this.replyFix(cx));
    this.threadInput = this.textBox("thread", "在 GitHub 上回复，然后按 enter 发布", cx => this.postThreadReply(cx));
    // The settings panel: whether Tourist opens filling its tab, and a switch per shortcut key.
    // Opening it takes the keyboard from a text box.
    this.shortcuts = new Shortcuts({ mod: "tourist", keys: SHORTCUTS, rebind: true, options: [{ id: "full", label: "全屏打开" }], onOpen: () => this.leaveBox(),
      onChange: (id, on) => { if (id === "full") setShared(FULL, on); } });
    if (!checking() && shared(FULL) !== this.shortcuts.option("full")) setShared(FULL, this.shortcuts.option("full"));
    this.handle = cx.focus_handle();
    // The pane isn't drawn yet, so focus again once it is.
    this.handle.focus();
    cx.timer.after(50, () => { if (!this.typing) this.handle.focus(); });
    cx.timer.after(400, () => { if (!this.typing) this.handle.focus(); });
    // "Open in full screen": once the pane is there, zoom it to fill its tab (z zooms back). Zoom is
    // a switch, so a pane that is already zoomed is left alone.
    // A pane mod is not told which pane it is, so its pane is found by name: the Tourist pane that
    // has the keyboard, which a newly opened one does, else the only Tourist pane there is.
    if (this.shortcuts.option("full")) cx.timer.after(400, () => {
      const all = panes().filter(p => p.mod === "tourist");
      const mine = all.find(p => p.pane === props()?.pane) ?? all.find(p => p.focused) ?? (all.length === 1 ? all[0] : null);
      if (mine && !mine.zoomed) run("pane.zoom", { pane: mine.pane });
    });
    cx.spawn(async cx => { for (;;) { this.command(await nextCommand(), cx); cx.notify(); } });
    cx.spawn(async cx => { await this.detect(cx); cx.notify(); });
    if (this.ticketReviewActive) {
      // The ticket file can change while this tab is in the background or the board is closed.
      cx.timer.every(10000, cx => this.pollTicket(cx));
      cx.timer.every(30000, cx => { if (this.ticketReviewActive && this.ticketTour()) { this.loadChecks(cx); this.loadThreads(cx); } });
    }
  }

  textBox(name, placeholder, submit) {
    const box = InputState.new({ placeholder });
    box.on("focus", (_e, cx) => { this.typing = name; cx.notify(); });
    box.on("blur", (_e, cx) => { if (this.typing === name) this.typing = null; cx.notify(); });
    box.on("submit", (_e, cx) => { submit(cx); cx.notify(); });
    return box;
  }

  /** Gives a text box the keyboard, again once it has been drawn. */
  focusBox(box, cx) {
    box.focus();
    cx.timer.after(50, () => box.focus());
  }

  /** Takes the keyboard back from a text box. */
  leaveBox() {
    this.typing = null; this.asking = false; this.commenting = null; this.replying = false; this.threadReply = null;
    this.handle.focus();
  }

  async close() {
    if (this.launcher) return;
    this.persist();
    publishTicketReview(this, true);
    this.explainScroll.release(); this.diffScroll.release(); this.input.release(); this.featureInput.release(); this.commentInput.release(); this.summaryInput.release(); this.replyInput.release(); this.threadInput.release();
    await this.session?.stop(); await this.fixSession?.stop();
  }

  /** `tourist.<name>` commands: focus, start, next, prev, deeper, technical, open, reset, agent, settings, scope-<id>, depth-<id>. */
  command(c, cx) {
    if (c === "focus") this.handle.focus();
    else if (this.shortcuts.command(c)) { /* the settings panel took it */ }
    else if (c.startsWith("scope-")) { this.scope = c.slice(6); this.goStep("scope"); }
    else if (c === "models") { this.goStep("model"); this.loadModels(cx); }
    else if (c.startsWith("model-")) { this.chooseModel(c.slice(6) || null); }
    else if (c.startsWith("depth-")) { this.depth = c.slice(6); this.goStep("depth"); }
    else if (c.startsWith("pass-")) { this.pass = c.slice(5); if (this.steps().includes("pass")) this.goStep("pass"); }
    else if (c === "checks") this.openChecks(cx);
    else if (c === "checks-back") this.closeChecks();
    else if (c === "down") this.phase === "tour" ? this.move(1, cx) : this.moveCursor(1);
    else if (c === "up") this.phase === "tour" ? this.move(-1, cx) : this.moveCursor(-1);
    else if (c === "pick") this.pick(cx);
    else if (c === "back") this.back();
    else if (c === "start") this.start(cx);
    else if (c === "next") this.move(1, cx);
    else if (c === "prev") this.move(-1, cx);
    else if (c === "deeper") this.deeper(cx);
    else if (c === "technical") this.technical(cx);
    else if (c === "open") this.openInEditor();
    else if (c === "reset") this.reset(cx);
    else if (c === "agent") this.switchAgent();
    else if (c === "fix") this.startFix(cx);
    else if (c === "fix-back") this.closeFix();
    else if (c === "fix-discard") this.discardFix(cx);
    else if (c === "review") this.startReview(cx);
    else if (c === "review-back") this.closeReview();
    else if (c === "merge") this.startMerge(cx);
    else if (c === "merge-back") this.closeMerge();
    else if (c === "changes") this.requestChanges(cx);
    else if (c === "explain") this.explainFile(cx);
    else if (c === "viewed") this.toggleViewed(this.currentFile(), cx);
    else if (c.startsWith("file-") && this.files) {
      // file-<n>: the nth file in the list, counting down from the top
      const f = [...this.files.tour, ...this.files.also, ...this.files.side][Number(c.slice(5)) - 1];
      if (f) this.openFile(f, cx);
    }
  }

  /**
   * The tab this copy is in. A mod pane isn't told which pane it is, and a copy only runs while
   * its tab is shown, so the shown tab that holds a Tourist pane is this one; the keyboard picks
   * between several. Null when that can't be told yet.
   */
  myTabId() {
    const tab = focused()?.tab;
    if (!tab) return null;
    const mine = panes().filter(p => p.mod === "tourist" && p.tab === tab);
    if (!mine.length) return null;
    const me = (this.paneId && mine.find(p => p.pane === this.paneId)) || mine.find(p => p.focused) || (mine.length === 1 ? mine[0] : null);
    if (!me) return null;
    this.paneId = me.pane;
    return tab;
  }

  /** The tab id, waiting a moment for the pane to be shown and focused on first render. */
  async resolveTab(cx) {
    for (let i = 0; i < 8; i++) {
      const id = this.myTabId();
      if (id) return id;
      await new Promise(done => cx.timer.after(150, () => done(undefined)));
    }
    return null;
  }

  /**
   * Saves this tab's tour, so reopening Tourist beside the same terminal (or a rebuilt pane)
   * brings it back without the agent planning again. Only a tour is kept: the setup screens are
   * cheap to redo, and `q` (新导览) clears the tab.
   */
  persist() {
    if (this.ticket || this.launcher) return;
    if (!this.tabId) this.tabId = this.myTabId();
    if (!this.tabId || this.phase !== "tour" || !this.plan?.stops?.length) return;
    const heads = {};
    for (const p of this.req?.projects ?? []) if (p.head) heads[p.engine] = p.head;
    if (this.pr) heads.pr = this.pr.headOid;
    const { savedAt, ...plan } = this.plan;
    saveTabTour(this.tabId, {
      scope: this.scope, depth: this.depth, prNumber: this.prNumber ?? null, pass: this.pass, since: this.since ?? null,
      feature: this.featureInput.value(), savedKey: this.savedKey ?? null, idx: this.idx, plan,
      agent: this.session?.agent ?? this.agent, session: this.session?.id ?? null, cwd: this.session?.cwd ?? this.git.root ?? null,
      reqItem: this.scope === "requirement" ? this.reqItem : null, heads, stale: Boolean(this.tourStale),
      title: this.tourTitle(), subject: this.tourSubject(),
    }).catch(() => {});
  }

  /** Saves a moment later: j/k moves stop by stop, and each move would otherwise write the file. */
  persistSoon(cx) {
    const token = this.persistToken = {};
    cx.timer.after(250, () => { if (this.persistToken === token) this.persist(); });
  }

  /** What the sidebar calls this tour. */
  tourTitle() {
    if (this.scope === "requirement") return this.reqItem?.title || `需求 ${this.reqItem?.id ?? ""}`.trim();
    if (this.scope === "pr") return `PR #${this.prNumber}${this.pr?.title ? ` ${this.pr.title}` : ""}`;
    if (this.scope === "branch") return `分支 ${this.git.branch}`;
    if (this.scope === "commit") return "最后一次提交";
    if (this.scope === "feature") return `功能：${this.featureInput.value().trim()}`;
    return "整个仓库";
  }

  /** A short tag for the row: the requirement id, the PR number, the branch. */
  tourSubject() {
    if (this.scope === "requirement") return String(this.reqItem?.id ?? "");
    if (this.scope === "pr") return `#${this.prNumber ?? ""}`;
    if (this.scope === "branch") return String(this.git.branch ?? "");
    return "";
  }

  /**
   * Brings back the tour this tab had. The plan is not asked for again: only what the stops point
   * at is reloaded (a requirement's branches, a PR's refs), and a moved head is marked, not replanned.
   */
  async restoreTour(saved, cx) {
    this.scope = saved.scope; this.depth = saved.depth; this.prNumber = saved.prNumber ?? null;
    this.pass = saved.pass ?? "since"; this.since = saved.since ?? null;
    if (saved.feature) this.featureInput.set_value(saved.feature);
    if (saved.agent && this.agents.includes(saved.agent)) this.agent = saved.agent;
    // A branch, commit or repo tour reads the checkout it was planned in: another folder means nothing to show.
    if (!this.req && !this.pr && saved.cwd && this.git.root && saved.cwd !== this.git.root) return;
    this.savedKey = saved.savedKey ?? null;
    this.plan = saved.plan;
    this.idx = Math.max(0, Math.min(Number(saved.idx) || 0, saved.plan.stops.length - 1));
    this.tourStale = false;
    this.phase = "tour";
    this.session = new AgentSession(this.agent, saved.cwd ?? this.git.root, { model: this.modelForSessions() });
    this.session.id = saved.session ?? null;
    if (this.scope === "requirement" && saved.reqItem) { this.loadRequirementForRestore(saved, cx); return; }
    if (this.scope === "pr" && this.prNumber) { this.restorePR(saved, cx); return; }
    this.show(this.idx, cx);
    this.loadRepoFiles(cx);
  }

  /** A restored requirement tour: its projects and heads again, its plan kept. */
  loadRequirementForRestore(saved, cx) {
    const item = this.reqItem = saved.reqItem;
    cx.spawn(async cx => {
      try {
        const settings = await loadSettings();
        const req = await loadRequirement(item, settings, this.on);
        req.title ||= item.title; req.status ||= item.status;
        this.tourStale = req.projects.some(p => p.head && saved.heads?.[p.engine] && saved.heads[p.engine] !== p.head);
        this.req = req;
        this.show(this.idx, cx);
        this.loadRepoFiles(cx);
      } catch (e) { this.fail(String(e?.message ?? e)); }
      cx.notify();
    });
  }

  /** A restored PR tour: the PR again, its comments and files, its plan kept. */
  restorePR(saved, cx) {
    cx.spawn(async cx => {
      try {
        const pr = await loadPR(this.git.root, this.on, saved.prNumber);
        this.tourStale = Boolean(saved.heads?.pr && pr.headOid !== saved.heads.pr);
        this.pr = pr;
        const key = commentKey(this.git.root, pr.number);
        this.comments = await loadComments(key);
        this.viewed = await loadViewed(key);
        this.threads = []; this.threadsLoaded = false; this.threadsError = null;
        this.show(this.idx, cx);
        this.loadFiles(cx); this.loadRepoFiles(cx);
      } catch (e) { this.fail(String(e?.message ?? e)); }
      cx.notify();
    });
  }

  /** Finds the repo and the agents. Given `cx` (the first time only), a PR or a requirement in the props is opened too. */
  async detect(cx = null) {
    if (!this.cwd) { this.fail("没有可供导览的文件夹。请在仓库内的终端里打开 Tourist。"); return; }
    // Both take a moment on Windows and don't depend on each other.
    const [repo, found] = await Promise.all([readRepo(this.cwd, this.on), findAgents(this.on)]);
    // Opened on a requirement (props { scope: "requirement", story }): its projects come from
    // Beetle and their folders from the settings, so this checkout is only where the agent runs.
    const asked = props()?.scope, story = String(props()?.story ?? "").trim();
    if (!repo && !(asked === "requirement" && story)) { this.fail(`${this.cwd} 不在 git 仓库内。`); return; }
    this.agents = found.agents; this.agent = found.agent;
    if (!this.agent) { this.fail("Tourist 需要 PATH 上有已登录的 claude 或 codex CLI。"); return; }
    this.git = repo ?? this.git;
    if (repo && repo.changed.length === 0) this.scope = repo.head ? "commit" : "repo";
    // Opened with a scope already chosen (Git Good's Tour button asks for "branch"): skip that
    // question. A branch with no changes still gets the question, since there is nothing to tour.
    if (asked === "requirement" && story && cx) {
      this.scope = "requirement"; this.step = "scope";
      this.openRequirement({ id: story, title: String(props()?.title ?? ""), status: String(props()?.status ?? "") }, cx);
      return;
    }
    // Opened on the requirement picker (props { scope: "requirement" } with no story).
    if (asked === "requirement" && cx) { this.scope = "requirement"; this.goStep("req"); this.loadReqs(cx); return; }
    if (asked === "branch" && repo && repo.changed.length > 0) { this.scope = "branch"; this.goStep("depth"); }
    else this.goStep("scope");
    if (cx && this.ticketPR) await this.openPropPR(cx);
    // Opened plainly (not for a ticket or a scope): the tour this tab had, at the stop it was on.
    else if (cx && !this.ticket && !asked) {
      this.tabId = await this.resolveTab(cx);
      const saved = this.tabId ? await loadTabTour(this.tabId) : null;
      if (saved) await this.restoreTour(saved, cx);
    }
  }

  /**
   * Picks the PR named in the props, the same way enter on the PR step does: the re-review lookup
   * runs, and the tour lands on "What to review" or "How deep".
   */
  async openPropPR(cx) {
    const number = this.ticketPR;
    this.scope = "pr"; this.goStep("pr");
    this.prsLoading = true; this.prsError = null; cx.notify();
    try { this.prs = await listPRs(this.git.root, this.on); }
    catch (e) { this.prsLoading = false; this.fail(`无法列出打开的 PR 来查找 PR #${number}：${String(e?.message ?? e)}`); return; }
    this.prsLoading = false;
    if (this.step !== "pr") return; // the reader went back meanwhile
    const i = this.prs.findIndex(p => p.number === number);
    if (i < 0) { this.fail(`PR #${number}${this.ticket ? `（工单 #${this.ticket.number}）` : ""} 在 GitHub 上不是打开状态，可能已经合并或关闭。`); return; }
    this.cursor = i;
    this.pick(cx);
  }

  /** The ticket this tour reviews, when it is on that ticket's PR. Null for every other tour. */
  ticketTour() { return this.ticket && this.pr && this.pr.number === this.ticketPR ? this.ticket : null; }

  /** React to an opener's request without taking focus from another tab. */
  syncTicketReview(cx) {
    if (!this.ticketReviewActive) return;
    const request = shared(`${ticketReviewKey(this.ticket, this.ticketPR)}.request`);
    if (request?.id === this.ticket.reviewId && request.submission !== this.ticketRequestSeen) {
      this.ticketRequestSeen = request.submission;
      this.ticketPendingSubmission = request.submission;
    }
    if (this.ticketPendingSubmission === this.ticketSubmission) this.ticketPendingSubmission = null;
    if (this.ticketPendingSubmission !== null && this.ticketPendingSubmission !== undefined)
      this.refreshTicket(this.ticketPendingSubmission, cx);
    publishTicketReview(this);
  }

  pollTicket(cx) {
    if (!this.ticketReviewActive || this.ticketPolling || this.ticketRefreshing) return;
    this.ticketPolling = true;
    cx.spawn(async cx => {
      try {
        const ticket = await ticketCommand(this.ticket, ["show", String(this.ticket.number)]);
        if (ticket.status === "review") this.refreshTicket(ticket.submitted ?? ticket.updated ?? "", cx);
        if (ticket.status === "doing" && ticket.feedback) {
          this.ticketWaiting = true;
          this.ticketPreviousFeedback ||= ticket.feedback;
        }
        if (ticket.status === "done") { this.ticketWaiting = false; this.ticketDone = true; }
      } catch { /* A temporary CLI failure leaves the existing review available. */ }
      this.ticketPolling = false; cx.notify();
    });
  }

  /** Refresh only between edits and actions. Draft comments stay on the commit they describe. */
  refreshTicket(submission, cx) {
    if (!this.ticketReviewActive || !submission || submission === this.ticketSubmission) return;
    this.ticketPendingSubmission = submission;
    if (!this.git.root || !this.agent || this.ticketRefreshing
      || this.typing || this.commenting || this.busy || this.comments.length || this.threadBusy
      || this.phase === "planning" || this.phase === "merge" || this.phase === "review") return;
    this.ticketRefreshing = true;
    this.ticketSubmission = submission;
    if (this.ticketPendingSubmission === submission) this.ticketPendingSubmission = null;
    cx.spawn(async cx => {
      try {
        await this.session?.stop();
        this.reset(cx, true);
        this.scope = "pr"; this.prNumber = this.ticketPR; this.pass = "since";
        const gen = this.gen;
        const pr = await loadPR(this.git.root, this.on, this.ticketPR);
        const last = await lastReviewed(this.git.root, this.on, commentKey(this.git.root, pr.number), pr.number, pr.headOid).catch(() => null);
        if (gen !== this.gen || !this.ticketReviewActive) return;
        this.since = last ? { number: pr.number, ...last } : null;
        this.start(cx, false);
      } catch (error) { this.fail(String(error?.message ?? error)); }
      finally { this.ticketRefreshing = false; cx.notify(); }
    });
  }

  /** Switches to the next installed agent and remembers it. */
  switchAgent() {
    if (this.agents.length < 2) return;
    this.agent = this.agents[(this.agents.indexOf(this.agent) + 1) % this.agents.length];
    rememberAgent(this.agent);
  }

  agentName() { return agentName(this.agent); }

  /** A key for a button or a hint to show: empty when the user turned that shortcut off. @param {string} id @param {string} key */
  keyOf(id, key) { return this.shortcuts.shown(id, key); }

  fail(message) { this.phase = "error"; this.error = message; this.busy = null; }

  start(cx, focus = true) {
    if (this.phase !== "setup" || !this.git.root) return;
    // A resumed tour uses its saved plan. One that can't start any more (the branch's changes
    // are gone) is forgotten, and Tourist starts at the first step.
    if (this.scope === "branch" && this.git.changed.length === 0) return;
    if (this.scope === "feature" && !this.featureInput.value().trim()) { this.focusBox(this.featureInput, cx); return; }
    if (this.scope === "pr" && !this.prNumber) return;
    if (focus) this.leaveBox();
    this.phase = "planning";
    const session = this.session = new AgentSession(this.agent, this.git.root, { model: this.modelForSessions() });
    const gen = this.gen = (this.gen ?? 0) + 1;
    cx.spawn(async cx => {
      try {
        let prompt, plan = null, head = null;
        const feature = this.featureInput.value().trim();
        if (this.scope === "pr") {
          this.planNote = `正在获取 PR #${this.prNumber}`; cx.notify();
          const pr = await loadPR(this.git.root, this.on, this.prNumber);
          if (gen !== this.gen) return;
          // A re-review tours only what changed in the PR's files since the commit you last reviewed.
          const last = this.since?.number === pr.number && this.pass === "since" && this.since.oid !== pr.headOid ? this.since : null;
          if (last) {
            const short = last.oid.slice(0, 7);
            this.planNote = `正在查找自 ${short} 起的改动`; cx.notify();
            if (!await haveCommit(this.git.root, this.on, last.oid)) throw new Error(`无法获取 ${short}，也就是你上次评审的提交。强制推送可能已把它从 GitHub 上移除。请重新开始并选择「整个 PR」。`);
            const changes = await changesSince(this.git.root, this.on, pr, last.oid);
            if (gen !== this.gen) return;
            if (changes.files.length === 0) throw new Error(`自你上次在 ${short} 的评审以来，这个 PR 没有任何文件改动。请重新开始并选择「整个 PR」。`);
            Object.assign(pr, { sinceOid: last.oid, sinceAt: last.at, sinceFiles: changes.files, sinceCommits: changes.commits });
          }
          this.pr = pr; this.planNote = null; head = pr.headOid;
          this.comments = await loadComments(commentKey(this.git.root, pr.number));
          this.viewed = await loadViewed(commentKey(this.git.root, pr.number));
          this.threads = []; this.threadsLoaded = false; this.threadsError = null;
          this.loadThreads(cx); this.loadChecks(cx);
          cx.notify();
          const ticket = this.ticketTour();
          if (ticket) {
            this.planNote = `正在读取工单 #${ticket.number}`; cx.notify();
            const details = await ticketCommand(ticket, ["show", String(ticket.number)]);
            if (gen !== this.gen) return;
            this.reviewTicket = details;
            if (this.ticketPreviousFeedback) this.reviewTicket.reviewFeedback = this.ticketPreviousFeedback;
            if (details.submitted) this.ticketSubmission = details.submitted;
            this.planNote = null;
          } else this.reviewTicket = null;
          prompt = prPlanPrompt(prSubject(pr, this.reviewTicket), this.depth, this.reviewTicket);
        } else {
          // HEAD now, not when Tourist opened, so a commit made since then plans again.
          head = await git(["rev-parse", "HEAD"], { cwd: this.git.root, on: this.on });
          prompt = planPrompt(subject(this.scope, this.git, feature), this.depth);
        }
        // The same tour of the same commit at the same depth was planned before: reuse it,
        // and its agent session when the agent matches.
        this.savedKey = planKey({ root: this.git.root, scope: this.scope, depth: this.depth, head, pr: this.pr, feature, ticket: this.reviewTicket });
        const saved = this.savedKey ? await loadSavedPlan(this.savedKey) : null;
        if (gen !== this.gen) return;
        // A tour of a commit or PR that moved since (its saved-plan key changed) plans again instead.
        if (saved) { plan = saved.plan; plan.savedAt = saved.saved; if (saved.agent === session.agent) session.id = saved.session; }
        if (!plan) plan = parsePlan(await session.ask(prompt));
        if (gen !== this.gen) return;
        this.plan = plan; this.phase = "tour"; this.show(resume ? Number(resume.idx) || 0 : 0, cx);
        this.loadRepoFiles(cx);
        if (this.pr) this.loadFiles(cx);
        if (!plan.savedAt) this.storePlan();
      } catch (e) { if (gen === this.gen) this.fail(String(e?.message ?? e)); }
      cx.notify();
    });
  }

  /**
   * Shows stop i. On a PR tour the code panel holds the file's whole diff, scrolled to the stop,
   * with every stop on the file labelled. Branch and last-commit tours do the same when the diff
   * holds the stop's lines. Otherwise it shows the stop's lines from disk, numbered. `focus` ({ a, b }, new-file lines) highlights and
   * scrolls to those lines instead, for a file:line link.
   */
  show(i, cx, focus = null) {
    if (!this.plan) return;
    this.idx = Math.max(0, Math.min(i, this.plan.stops.length - 1));
    this.other = null;
    this.codeError = null; this.diff = null; this.diffMarks = null; this.linkRows = null;
    if (this.commenting) this.leaveBox();
    const s = this.plan.stops[this.idx], idx = this.idx;
    cx.spawn(async cx => {
      // A requirement branch isn't checked out here: show the file's change against its base.
      if (this.req) {
        const p = this.projectOf(s);
        if (!p?.dir) { this.codeError = `本地没有 ${p?.engine ?? "这个工程"} 的克隆。检查设置文件的 tourist.roots。`; cx.notify(); return; }
        await this.loadCommentsFor(commentKey(p.dir, `${p.branch}@${p.head}`));
        const all = await this.loadReqDiff(p, s.file);
        if (this.idx !== idx || this.other) return;
        const range = rowsFor(all, Number(s.start) || 1, Number(s.end) || Infinity);
        const rows = windowRows(all, range?.[0] ?? 0);
        if (rows.length === 0) { this.codeError = `${p.engine} 的 ${s.file} 在这条分支上没有改动`; cx.notify(); return; }
        this.diff = rows;
        this.diffMarks = { stops: this.stopsOn(s.file, rows), stopRows: rowsFor(rows, Number(s.start) || 1, Number(s.end) || Infinity) };
        this.focusDiff(focus, cx);
        return;
      }
      // A PR isn't on disk: show the file's diff instead.
      if (this.pr) {
        const all = await this.loadDiff(s.file);
        if (this.idx !== idx || this.other) return;
        const range = rowsFor(all, Number(s.start) || 1, Number(s.end) || Infinity);
        const rows = windowRows(all, range?.[0] ?? 0);
        if (rows.length === 0) { this.codeError = `此 PR 中 ${s.file} 没有改动`; cx.notify(); return; }
        this.diff = rows;
        this.diffMarks = { stops: this.stopsOn(s.file, rows), stopRows: rowsFor(rows, Number(s.start) || 1, Number(s.end) || Infinity) };
        this.focusDiff(focus, cx);
        return;
      }
      const all = await this.localDiff(s.file);
      if (this.idx !== idx) return;
      const range = all ? rowsFor(all, Number(s.start) || 1, Number(s.end) || Infinity) : null;
      if (range) {
        const rows = windowRows(all, range[0]);
        this.diff = rows;
        this.diffMarks = { stops: this.stopsOn(s.file, rows), stopRows: rowsFor(rows, Number(s.start) || 1, Number(s.end) || Infinity) };
        this.focusDiff(focus, cx);
        return;
      }
      const excerpt = await readExcerpt(this.git.root, s, this.on);
      if (this.idx !== idx) return;
      if (!excerpt) { this.codeError = `无法读取 ${s.file}`; cx.notify(); return; }
      s.start = excerpt.start; s.end = excerpt.end;
      this.diff = highlightRows(plainRows(excerpt.text, excerpt.start), s.file);
      this.focusDiff(focus, cx);
    });
    this.persistSoon(cx);
  }

  /**
   * One file's diff rows on a branch tour (merge base to the files on disk, so uncommitted edits
   * count) or a last-commit tour (HEAD's change). Null on other tours or when git has none.
   */
  async localDiff(file) {
    // A new file git does not know yet has no diff against the merge base: all of it is new.
    if (this.scope === "branch" && this.git.untracked?.includes(file)) {
      const added = await newFileDiff(file, { cwd: this.git.root, on: this.on });
      return added ? highlightRows(diffRows(added), file) : null;
    }
    const args = this.scope === "branch" && this.git.mergeBase ? ["diff", "--no-color", "--unified=3", this.git.mergeBase, "--", file]
      : this.scope === "commit" ? ["show", "--no-color", "--format=", "--unified=3", "HEAD", "--", file] : null;
    const text = args ? await git(args, { cwd: this.git.root, on: this.on }) : null;
    return text ? highlightRows(diffRows(text), file) : null;
  }

  /** The tour's stops on `file`, each with the first row of its lines in `rows`. Stops whose lines aren't shown are left out. */
  stopsOn(file, rows) {
    const project = this.req ? this.projectOf(this.plan.stops[this.idx]) : null;
    return this.plan.stops.flatMap((st, index) => {
      if (st.file !== file) return [];
      // On a requirement tour two projects can hold the same path: only this project's stops.
      if (project && st.repo && st.repo !== project.engine) return [];
      const range = rowsFor(rows, Number(st.start) || 1, Number(st.end) || Infinity);
      return range ? [{ index, title: st.title, row: range[0], end: range[1], current: index === this.idx && !this.other }] : [];
    });
  }

  /**
   * Scrolls the shown diff to a link's lines (highlighting them) or, without one, to the
   * current stop. A few lines above stay in view for context.
   */
  focusDiff(focus, cx) {
    const rows = this.diff;
    if (!rows) return;
    this.linkRows = focus ? rowsFor(rows, focus.a, focus.b) : null;
    const target = focus ? (this.linkRows?.[0] ?? nearestRow(rows, focus.a)) : this.diffMarks?.stopRows?.[0] ?? 0;
    const labelled = this.diffMarks?.stops.some(st => st.row === target);
    this.scrollTo(Math.max(0, target - (labelled ? 4 : 3)), cx);
  }

  /**
   * Scrolls the diff so row `row` sits at the top. The scroll handle only brings an item into
   * view the shortest way, so it first jumps to the end and then scrolls back up to the row.
   */
  scrollTo(row, cx) {
    this.codeTop = row;
    const req = this.scrollReq = { handle: this.diffScroll, row, step: 1 };
    cx.notify();
    // Each timer uses the cx it is handed: a click's cx is gone by the time the timer runs.
    cx.timer.after(40, cx => { if (this.scrollReq === req) { req.step = 2; cx.notify(); } });
    cx.timer.after(300, cx => { if (this.scrollReq === req) { this.scrollReq = null; cx.notify(); } });
  }

  /**
   * Scrolls the code a few lines. The scroll handle can only bring a row into view the shortest
   * way, so down asks for the row just under the pane and up for the row just above it.
   * @param {number} dir 1 for down, -1 for up
   */
  scrollCode(dir, cx) {
    const rows = this.diff?.length ?? 0;
    if (!rows) return;
    const last = Math.max(0, rows - this.codeFits);
    this.codeTop = Math.max(0, Math.min(last, this.codeTop + dir * CODE_SCROLL_LINES));
    const row = dir > 0 ? Math.min(rows - 1, this.codeTop + this.codeFits - 1) : this.codeTop;
    const req = this.scrollReq = { handle: this.diffScroll, row, step: 2 };
    cx.notify();
    cx.timer.after(200, cx => { if (this.scrollReq === req) { this.scrollReq = null; cx.notify(); } });
  }

  /** Every file in the repo, or in the PR's head commit, so the agent's file:line references can be resolved. */
  loadRepoFiles(cx) {
    const plan = this.plan;
    // A requirement's files are every project's change, collected while the requirement was read.
    if (this.req) { this.repoFiles = new Set(this.req.projects.flatMap(p => p.files)); return; }
    const args = this.pr ? ["ls-tree", "-r", "--name-only", this.pr.headOid] : ["ls-files"];
    cx.spawn(async cx => {
      const out = await git(args, { cwd: this.git.root, on: this.on });
      if (this.plan === plan && out) { this.repoFiles = new Set(out.split(/\r?\n/).filter(Boolean)); cx.notify(); }
    });
  }

  /** The agent's markdown with its file:line references turned into links. */
  linkify(text) {
    const files = new Set([...this.repoFiles, ...(this.plan?.stops ?? []).map(s => s.file)]);
    const prefer = [this.currentFile(), ...(this.plan?.stops ?? []).map(s => s.file)].filter(Boolean);
    return linkify(text, resolver(files, prefer));
  }

  /** A link in the agent's text: a file:line reference moves the code, anything else opens in the browser. */
  clickLink(url, cx) {
    const ref = readLink(url);
    if (ref) this.followLink(ref, cx); else openUrl(url);
  }

  /**
   * Shows a file:line reference. On a PR tour: the shown diff scrolls to it, or the stop on that
   * file (the one holding the line first), or the file from the list, or GitHub for a file the PR
   * doesn't change. On other tours: the stop holding the line, else VS Code.
   */
  followLink({ file, a, b }, cx) {
    if (!this.plan) return;
    const stops = this.plan.stops.map((st, i) => ({ st, i })).filter(x => x.st.file === file);
    const holding = stops.find(x => a >= Number(x.st.start) && a <= Number(x.st.end));
    if (this.pr) {
      if (file === this.currentFile() && this.diff) { this.focusDiff({ a, b }, cx); return; }
      const stop = holding ?? stops[0];
      if (stop) { this.show(stop.i, cx, { a, b }); return; }
      const f = this.laterFiles().find(x => x.file === file);
      if (f) { this.openFile(f, cx, { a, b }); return; }
      openUrl(`${this.pr.url.replace(/\/pull\/\d+\/?$/, "")}/blob/${this.pr.headOid}/${file}#L${a}${b > a ? `-L${b}` : ""}`);
      return;
    }
    if (holding && holding.i !== this.idx) this.show(holding.i, cx);
    else if (file === this.currentFile() && this.diff && rowsFor(this.diff, a, b)) this.focusDiff({ a, b }, cx);
    else { const path = this.localPath(file); if (path) openInEditor(path, a); }
  }

  /**
   * One PR file's whole diff, or [] when git can't produce it. On a re-review the diff starts at
   * the commit you last reviewed, and lines GitHub won't take a comment on are marked.
   */
  async loadDiff(file) {
    const pr = this.pr;
    const [text, whole] = await Promise.all([
      prFileDiff(this.git.root, this.on, pr, file),
      pr.sinceOid ? prFileDiff(this.git.root, this.on, pr, file, true) : null,
    ]);
    const rows = text ? diffRows(text) : [];
    highlightRows(rows, file);
    return pr.sinceOid ? markOutsidePR(rows, whole ? diffRows(whole) : null) : rows;
  }

  /** Sends a follow-up about the current stop and adds the answer under it. */
  followUp(label, question, cx) {
    if (this.busy || !this.plan || !this.session) return;
    const s = this.plan.stops[this.idx], session = this.session, other = this.other;
    const file = other ?? s.file, notes = other ? this.otherNotes(other) : s.notes;
    this.busy = label;
    cx.spawn(async cx => {
      const comments = this.comments.filter(c => c.file === file);
      let prompt = other ? filePrompt(question, other, this.pr, comments) : followUpPrompt(question, s, this.idx + 1, comments);
      // A reused tour whose agent session couldn't be kept starts fresh, so say what it's about.
      if (!session.id) prompt = `这是导览的一部分。主题：${this.pr ? prSubject(this.pr, this.reviewTicket) : this.req ? reqSubject(this.req) : subject(this.scope, this.git, this.featureInput.value().trim())}\n\n${prompt}`;
      try { notes.push({ label, text: await session.ask(prompt) }); this.storePlan(); }
      catch (e) { notes.push({ label: "错误", text: String(e?.message ?? e) }); }
      this.busy = null; cx.notify();
    });
  }

  /** The file whose code is showing: the open other file, or the current stop's. */
  currentFile() { return this.other ?? this.plan?.stops[this.idx]?.file ?? null; }

  /** The answers about a file the tour doesn't stop at. Kept in the plan, so they're saved with it. */
  otherNotes(file) {
    const all = this.plan.fileNotes ??= {};
    return all[file] ??= [];
  }

  /** Loads every file the PR changes for the file list. A failure just leaves the list empty. */
  loadFiles(cx) {
    const pr = this.pr, plan = this.plan;
    this.files = null;
    cx.spawn(async cx => {
      const stats = await prFileStats(this.git.root, this.on, pr).catch(() => []);
      if (this.pr === pr && this.plan === plan) { this.files = groupFiles(stats, plan.stops); cx.notify(); }
    });
  }

  /** Opens a file from the list: a tour file goes to its first stop, any other shows its whole diff. */
  openFile(f, cx, focus = null) {
    if (f.stop !== undefined) { this.show(f.stop, cx, focus); return; }
    if (!this.pr) return;
    this.other = f.file;
    this.codeError = null; this.diff = null; this.diffMarks = null; this.linkRows = null;
    if (this.commenting) this.leaveBox();
    const file = f.file;
    cx.spawn(async cx => {
      const all = await this.loadDiff(file);
      if (this.other !== file) return;
      const rows = windowRows(all, focus ? nearestRow(all, focus.a) : 0);
      if (rows.length === 0) { this.codeError = f.add === null ? `${file} 是二进制文件` : `此 PR 中 ${file} 没有改动`; cx.notify(); return; }
      this.diff = rows;
      this.diffMarks = { stops: [], stopRows: null };
      this.focusDiff(focus, cx);
    });
  }

  /** The files after the tour stops, in list order: "Also changed", then tests, docs and generated. */
  laterFiles() { return this.files ? [...this.files.also, ...this.files.side] : []; }

  /**
   * Where j (1) or k (-1) goes: the tour stops in order, then on into the other files in the
   * list after the last stop, and back the same way.
   */
  moveTarget(dir) {
    const later = this.laterFiles(), last = (this.plan?.stops.length ?? 0) - 1;
    if (this.other) {
      const j = later.findIndex(f => f.file === this.other) + dir;
      return j < 0 ? { stop: last } : j < later.length ? { file: later[j] } : null;
    }
    const i = this.idx + dir;
    if (i >= 0 && i <= last) return { stop: i };
    return dir > 0 && later.length ? { file: later[0] } : null;
  }

  move(dir, cx) {
    const to = this.moveTarget(dir);
    if (to?.file) this.openFile(to.file, cx);
    else if (to) this.show(to.stop, cx);
  }

  explainFile(cx) { if (this.other) this.followUp("解释", "解释这个文件改了什么、为什么改，以及它和 PR 其余部分怎么连起来。", cx); }

  /** Loads the comment threads already on the PR from GitHub. A failure just shows none. */
  loadThreads(cx) {
    const pr = this.pr;
    if (!pr || this.threadsLoading === pr) return;
    this.threadsLoading = pr;
    cx.spawn(async cx => {
      try {
        const threads = await listThreads(pr, this.git.root, this.on);
        if (this.pr === pr) { this.threads = threads; this.threadsLoaded = true; this.threadsError = null; }
      } catch (error) { if (this.pr === pr) this.threadsError = String(error?.message ?? error); }
      if (this.threadsLoading === pr) this.threadsLoading = false;
      cx.notify();
    });
  }

  /** Opens the reply box under a GitHub thread. A reply GitHub refused comes back in the box. */
  startThreadReply(th, cx) {
    if (!this.pr || th.canReply === false || this.threadBusy) return;
    this.leaveBox();
    this.threadReply = th.id;
    this.threadInput.set_value(this.threadError?.id === th.id ? this.threadError.draft ?? "" : "");
    this.threadError = null;
    this.focusBox(this.threadInput, cx);
  }

  /** Posts the reply box's text to its thread on GitHub, then reloads the threads. Empty just closes. */
  postThreadReply(cx) {
    const id = this.threadReply, text = this.threadInput.value().trim(), pr = this.pr;
    const th = this.threads.find(x => x.id === id);
    this.threadInput.set_value("");
    this.leaveBox();
    if (!text || !th || !pr) return;
    this.threadBusy = { id, note: "正在发布回复" }; this.threadError = null;
    cx.spawn(async cx => {
      try { await replyToThread(pr, this.git.root, this.on, th, text); if (this.pr === pr) this.loadThreads(cx); }
      catch (e) { this.threadError = { id, text: `GitHub 拒绝了这条回复：${String(e?.message ?? e)}`, draft: text }; }
      this.threadBusy = null; cx.notify();
    });
  }

  /** Resolves a GitHub thread, or unresolves a resolved one. */
  toggleResolved(th, cx) {
    const to = !th.resolved;
    if (!this.pr || !th.nodeId || this.threadBusy || !(to ? th.canResolve : th.canUnresolve)) return;
    this.threadBusy = { id: th.id, note: to ? "正在解决" : "正在取消解决" }; this.threadError = null;
    cx.spawn(async cx => {
      try { await setThreadResolved(this.git.root, this.on, th, to); th.resolved = to; this.openResolved.delete(th.id); }
      catch (e) { this.threadError = { id: th.id, text: `GitHub 拒绝：${String(e?.message ?? e)}` }; }
      this.threadBusy = null; cx.notify();
    });
  }

  /** Expands a resolved thread, or folds it back to one line. */
  toggleResolvedOpen(th) {
    if (this.openResolved.has(th.id)) this.openResolved.delete(th.id); else this.openResolved.add(th.id);
  }

  /** Loads the PR's CI checks, keeping answers already given. A failure shows on the checks screen. */
  loadChecks(cx) {
    const pr = this.pr;
    if (!pr) return;
    if (this.checks?.number !== pr.number) this.checks = { number: pr.number, list: null, loading: false, error: null, cursor: 0, notes: {} };
    const c = this.checks;
    if (c.loading) return;
    c.loading = true; c.error = null;
    cx.spawn(async cx => {
      try { c.list = await listChecks(this.git.root, this.on, pr); c.cursor = Math.min(c.cursor, Math.max(0, c.list.length - 1)); }
      catch (e) { c.error = String(e?.message ?? e); }
      c.checkedAt = Date.now(); c.loading = false; cx.notify();
    });
  }

  openChecks(cx) {
    if (!this.pr) return;
    this.leaveBox();
    this.phase = "checks";
    this.loadChecks(cx);
  }

  closeChecks() { this.phase = this.plan ? "tour" : "setup"; }

  moveCheck(i) {
    const c = this.checks, n = c?.list?.length ?? 0;
    if (n) c.cursor = (i + n) % n;
  }

  /** The highlighted check, and where its answers are kept. */
  currentCheck() {
    const check = this.checks?.list?.[this.checks.cursor];
    return check ? { check, key: `${check.workflow}/${check.name}` } : null;
  }

  /** Reads the highlighted failed check's log and asks the tour's agent why it failed. */
  explainCheck(cx) {
    const cur = this.currentCheck(), c = this.checks, pr = this.pr, session = this.session;
    if (!cur || !pr || !session || this.busy || (cur.check.bucket !== "fail" && cur.check.bucket !== "cancel")) return;
    const notes = c.notes[cur.key] ??= [];
    this.busy = `正在读取 ${cur.check.name} 的日志`;
    cx.spawn(async cx => {
      try {
        const log = await failedLog(this.git.root, this.on, pr, cur.check);
        this.busy = `${this.agentName()} 正在读取失败信息`; cx.notify();
        let prompt = checkPrompt(cur.check, log);
        if (!session.id) prompt = `这是导览评审的一部分。主题：${prSubject(pr, this.reviewTicket)}\n\n${prompt}`;
        notes.push({ label: "为什么失败", text: await session.ask(prompt) });
      } catch (e) { notes.push({ label: "错误", text: String(e?.message ?? e) }); }
      this.busy = null; cx.notify();
    });
  }

  openCheck() { const cur = this.currentCheck(); if (cur?.check.link) openUrl(cur.check.link); }

  /** Saves the tour's plan and answers so reopening it skips planning. Branch tours have no key and aren't saved. */
  storePlan() {
    if (!this.savedKey || !this.plan) return;
    const { savedAt, ...plan } = this.plan;
    savePlan(this.savedKey, plan, this.session?.agent ?? this.agent, this.session?.id ?? null).catch(() => {});
    this.persist();
  }

  /** Throws away the saved plan and plans the tour again. */
  replan(cx) {
    if (!this.savedKey || this.busy || this.phase !== "tour") return;
    const key = this.savedKey, req = this.req;
    this.session?.stop();
    this.diff = null;
    this.plan = null; this.files = null; this.other = null;
    // A requirement tour is planned again from its browser: there is no depth step to land on.
    if (req) { this.phase = "require"; this.savedKey = null; cx.spawn(async () => { await dropSavedPlan(key); }); cx.notify(); return; }
    this.phase = "setup"; this.step = "depth";
    cx.spawn(async cx => { await dropSavedPlan(key); this.start(cx); cx.notify(); });
  }

  deeper(cx) { this.followUp("更深入", "这里再深入一点：这个文件里、以及它调用的代码里，还有哪些重要的地方？", cx); }
  technical(cx) { this.followUp("更技术", "再讲一遍，更技术一些：确切的机制、类型、数据流和边界情况。", cx); }
  ask(cx) {
    const q = this.input.value().trim();
    if (!q || this.busy) return;
    this.input.set_value("");
    this.leaveBox();
    this.followUp(`你的提问：${q}`, q, cx);
    // Reveal the empty marker at the end of the explanation once the question is drawn,
    // so the answer appears in view. Again a moment later in case that layout came early.
    this.explainScroll.scroll_to_item(1);
    cx.timer.after(50, cx => { this.explainScroll.scroll_to_item(1); cx.notify(); });
  }

  /**
   * Opens the comment box under a diff line of the current stop. With shift held and a
   * comment already open on this stop, it stretches that comment from the line first
   * clicked (`anchor`) to this one instead, keeping what was typed.
   */
  startComment(row, cx, { index = -1, shift = false } = {}) {
    const file = this.currentFile(), rows = this.diff ?? [];
    if (!this.commentsKey() || !file || row.number === undefined || row.noComment) return;
    this.asking = false;
    const open = this.commenting;
    if (shift && open?.file === file && open.anchor >= 0 && index >= 0) {
      const [a, b] = rangeOf(rows, open.anchor, index);
      if (rows[a].noComment || rows[b].noComment) return; // a re-review line GitHub won't take
      const lines = rows.slice(a, b + 1).filter(r => r.number !== undefined);
      const first = rows[a], last = rows[b];
      this.commenting = { file, anchor: open.anchor, line: last.number, side: sideOf(last), code: lines.map(r => r.text).join("\n") };
      if (a !== b) Object.assign(this.commenting, { startLine: first.number, startSide: sideOf(first) });
    } else {
      this.commenting = { file, anchor: index, line: row.number, side: sideOf(row), code: row.text };
      this.commentInput.set_value("");
    }
    this.focusBox(this.commentInput, cx);
  }

  /** Reopens a saved comment in the box to change its text. */
  startEdit(comment, cx) {
    if (!this.commentsKey()) return;
    this.asking = false;
    const { id, text, created, ...where } = comment;
    this.commenting = { ...where, anchor: -1, editId: id };
    this.commentInput.set_value(text);
    this.focusBox(this.commentInput, cx);
  }

  /** Saves the open comment, or the edit of a saved one. An empty box just closes. */
  saveComment(cx) {
    const text = this.commentInput.value().trim(), at = this.commenting;
    this.commentInput.set_value("");
    this.leaveBox();
    if (!text || !at || !this.commentsKey()) return;
    if (at.editId) {
      this.comments = this.comments.map(c => c.id === at.editId ? { ...c, text } : c);
      this.storeComments(cx);
      return;
    }
    const { anchor, ...where } = at; // the anchor only means something while the box is open
    this.comments.push({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ...where, text, created: new Date().toISOString() });
    this.storeComments(cx);
  }

  deleteComment(comment, cx) {
    this.comments = this.comments.filter(c => c.id !== comment.id);
    this.storeComments(cx);
  }

  /** True when the file was marked viewed at the PR's current head. */
  isViewed(file) { return Boolean(this.pr) && this.viewed[file] === this.pr.headOid; }

  /** Marks a file viewed, or clears the mark. Saved per PR. */
  toggleViewed(file, cx) {
    if (!this.pr || !file) return;
    const viewed = { ...this.viewed };
    if (this.isViewed(file)) delete viewed[file]; else viewed[file] = this.pr.headOid;
    this.viewed = viewed;
    const key = commentKey(this.git.root, this.pr.number), head = this.pr.headOid;
    // Every file viewed counts as reviewing this head, for the next re-review.
    const all = this.files ? [...this.files.tour, ...this.files.also, ...this.files.side] : [];
    const done = all.length > 0 && all.every(f => viewed[f.file] === head);
    cx.spawn(async () => {
      await saveViewed(key, viewed).catch(() => {});
      if (done) await saveReviewed(key, head).catch(() => {});
    });
  }

  storeComments(cx) {
    const key = this.commentsKey(), list = this.comments;
    if (!key) return;
    cx.spawn(async () => { await saveComments(key, list).catch(() => {}); });
    this.persist();
  }

  /**
   * Opens the fix screen. The first time, an agent with edit tools works through every
   * saved comment in a worktree on the PR's commit. Later, it shows that run's result.
   */
  /** What a fix edits and pushes to: your own PR's head, or the requirement branch the stop is on. */
  fixTarget() {
    if (this.pr?.mine) return prFixTarget(this.git.root, this.pr);
    const project = this.projectOf(this.plan?.stops[this.idx]);
    if (this.req && project?.dir && project.head) return branchFixTarget(project, this.req.id);
    return null;
  }

  startFix(cx) {
    const target = this.fixTarget();
    if (!target || this.ticketTour()) return; // never edit someone else's PR, nor a ticket's, which its agent works on
    if (this.fix && this.fix.phase !== "pushed") { this.leaveBox(); this.phase = "fix"; return; }
    if (this.comments.length === 0 || this.busy) return;
    this.leaveBox();
    const comments = [...this.comments], pr = this.pr;
    const fix = this.fix = { phase: "running", count: comments.length, note: "正在创建 worktree", path: null, replies: [],
      branch: target.branch, label: target.label, dir: target.dir ?? null };
    this.phase = "fix";
    cx.spawn(async cx => {
      try {
        fix.path = await openWorktree(target.dir ?? this.git.root, this.on, target);
        fix.note = `${this.agentName()} 正在处理 ${comments.length} 条评论`; cx.notify();
        const session = this.fixSession = new AgentSession(this.agent, fix.path, { write: true, model: this.modelForSessions() });
        fix.summary = await session.ask(pr ? fixPrompt(pr, comments)
          : branchFixPrompt({ ...target, req: this.req.id, engine: target.engine ?? target.label }, comments));
        fix.files = splitDiff(await worktreeDiff(fix.path, this.on));
        fix.phase = "ready";
      } catch (e) { fix.phase = "failed"; fix.error = String(e?.message ?? e); }
      cx.notify();
    });
  }

  /**
   * On a ticket's tour: sends every saved comment to the ticket as requested changes, which also
   * reaches its agent when one runs. This head counts as reviewed, so the next tour of the PR can
   * offer only what changed since. The tab stays open while its agent makes the changes.
   * The first press only asks for a second one.
   */
  requestChanges(cx) {
    const ticket = this.ticketTour(), pr = this.pr;
    if (!ticket || this.comments.length === 0 || this.busy || this.ticketWaiting) return;
    if (!this.handBack?.confirm) { this.handBack = { confirm: true, error: null }; this.leaveBox(); return; }
    const comments = [...this.comments], key = commentKey(this.git.root, pr.number);
    this.handBack = null;
    this.busy = `正在把 ${comments.length} 条评论发送到工单 #${ticket.number}`;
    cx.spawn(async cx => {
      try {
        const r = await ticketCommand(ticket, ["changes", String(ticket.number), changesText(pr, comments)]);
        await saveReviewed(key, pr.headOid).catch(() => {});
        this.comments = this.comments.filter(c => !comments.includes(c));
        await saveComments(key, this.comments).catch(() => {});
        this.ticketPreviousFeedback = changesText(pr, comments);
        this.ticketWaiting = true;
        this.busy = null;
        notify({ title: `已请求修改 #${ticket.number}`,
          body: r.forwarded ? `已把 ${comments.length} 条评论发送给它的 agent。`
            : r.forwardError ? `已保存在工单上，但没送到它的 agent：${r.forwardError}`
            : "已保存在工单上。它上面没有 agent 在运行，请在工单面板启动一个。",
          level: r.forwarded ? "success" : "warning" });
      } catch (e) { this.busy = null; this.handBack = { confirm: true, error: String(e?.message ?? e) }; }
      cx.notify();
    });
  }

  /** Closes this tab, after a ticket's tour is done with. */
  closeTab(cx) { if (!closeOwnTab(ownPane())) this.reset(cx); }

  /** Opens the reply box on the fix screen, once the agent has finished a run. */
  startReply(cx) {
    const fix = this.fix;
    if (!fix || !this.fixSession?.id || (fix.phase !== "ready" && fix.phase !== "failed")) return;
    this.replying = true;
    this.focusBox(this.replyInput, cx);
  }

  /** Sends the reader's reply into the fix agent's session, so it keeps editing the same worktree. */
  replyFix(cx) {
    const fix = this.fix, session = this.fixSession, text = this.replyInput.value().trim();
    if (!text || !fix || !session || (fix.phase !== "ready" && fix.phase !== "failed")) return;
    this.replyInput.set_value("");
    this.leaveBox();
    fix.phase = "running"; fix.error = null; fix.confirm = false;
    fix.note = `${this.agentName()} 正在处理你的回复`;
    const reply = { text, answer: null };
    fix.replies.push(reply);
    cx.spawn(async cx => {
      try {
        reply.answer = await session.ask(fixReplyPrompt(text));
        fix.files = splitDiff(await worktreeDiff(fix.path, this.on));
      } catch (e) { fix.error = String(e?.message ?? e); }
      fix.phase = "ready";
      cx.notify();
    });
  }

  closeFix() { this.phase = this.plan ? "tour" : "setup"; if (this.fix) this.fix.confirm = false; }

  /** Commits the fix and pushes it to the PR's branch. The first press only asks for a second one. */
  pushFix(cx) {
    const fix = this.fix, target = this.fixTarget(), pr = this.pr;
    if (!fix || !target || fix.phase !== "ready" || !fix.files?.length) return;
    if (!fix.confirm) { fix.confirm = true; this.leaveBox(); return; } // leaveBox gives the dialog the keyboard
    fix.confirm = false; fix.phase = "pushing"; fix.error = null;
    const root = target.dir ?? this.git.root, key = this.commentsKey();
    cx.spawn(async cx => {
      try {
        const head = await pushFix(fix.path, root, this.on, target,
          pr ? `Address review comments on #${pr.number}` : `Address review comments on ${target.branch}`);
        fix.phase = "pushed";
        await removeWorktree(root, this.on, target).catch(() => {});
        this.comments = []; if (key) await saveComments(key, []).catch(() => {});
        if (pr) this.adoptHead(head, cx); else this.refreshReqQuietly(cx);
      } catch (e) { fix.phase = "ready"; fix.error = `推送失败：${String(e?.message ?? e)}`; }
      cx.notify();
    });
  }

  /**
   * Moves the tour to the PR's new head after you pushed a fix, so merging, posting and the diffs
   * use the commit that's on GitHub now. You saw the fix's diff before pushing, so viewed marks
   * carry over, and the plan is saved under the new head so reopening the tour skips planning.
   */
  adoptHead(head, cx) {
    const pr = this.pr, old = pr.headOid;
    if (!head || head === old) return;
    pr.headOid = head;
    const viewed = {};
    for (const [file, at] of Object.entries(this.viewed)) viewed[file] = at === old ? head : at;
    this.viewed = viewed;
    const key = commentKey(this.git.root, pr.number);
    cx.spawn(async () => { await saveViewed(key, viewed).catch(() => {}); });
    this.savedKey = planKey({ root: this.git.root, scope: "pr", depth: this.depth, head, pr, feature: "", ticket: this.reviewTicket });
    this.storePlan();
    // The fix changed the code: show the new diffs, file counts, threads and the checks the push started.
    if (this.other) { const f = this.laterFiles().find(x => x.file === this.other); if (f) this.openFile(f, cx); }
    else this.show(this.idx, cx);
    this.loadFiles(cx); this.loadThreads(cx); this.loadChecks(cx);
    if (this.merge) this.merge.confirm = false;
  }

  /** Throws the fix away: the worktree and its branch are deleted. The comments stay. */
  discardFix(cx) {
    const fix = this.fix, target = this.fixTarget();
    if (!fix || !target || (fix.phase !== "ready" && fix.phase !== "failed")) return;
    this.fix = null; this.closeFix();
    cx.spawn(async cx => { await removeWorktree(target.dir ?? this.git.root, this.on, target).catch(() => {}); cx.notify(); });
  }

  /** Opens the post-review screen for the saved comments. */
  startReview(cx) {
    // A peer's PR can be approved with no comments. Your own can only take comments.
    if (!this.pr || (this.comments.length === 0 && this.pr.mine)) return;
    this.leaveBox();
    if (!this.review || this.review.phase === "posted") {
      // With no comments the likely verdict is Approve, so it starts highlighted.
      const cursor = this.comments.length === 0 ? Math.max(0, eventsFor(this.pr).findIndex(e => e.id === "APPROVE")) : 0;
      this.review = { phase: "editing", cursor, confirm: false, url: null, error: null };
      this.summaryInput.set_value("");
    }
    this.phase = "review";
  }

  closeReview() {
    if (this.review?.phase === "posting") return;
    if (this.review?.phase === "posted") this.review = null;
    else if (this.review) this.review.confirm = false;
    this.leaveBox();
    this.phase = this.plan ? "tour" : "setup";
  }

  /** Moves the verdict highlight. Any change asks for the two presses again. */
  moveVerdict(i) {
    const r = this.review, n = this.pr ? eventsFor(this.pr).length : 0;
    if (!r || r.phase !== "editing" || n === 0) return;
    r.cursor = (i + n) % n; r.confirm = false;
  }

  /** True when the review has something to post: comments, an approval, or a summary. */
  canPost() {
    const r = this.review, pr = this.pr;
    if (!r || !pr || r.phase !== "editing") return false;
    const event = (eventsFor(pr)[r.cursor] ?? eventsFor(pr)[0]).id;
    return this.comments.length > 0 || event === "APPROVE" || this.summaryInput.value().trim() !== "";
  }

  /** Posts the comments as one GitHub review. The first press only asks for a second one. */
  postReview(cx) {
    const r = this.review, pr = this.pr;
    if (!this.canPost()) return;
    if (!r.confirm) { r.confirm = true; this.leaveBox(); return; }
    const event = (eventsFor(pr)[r.cursor] ?? eventsFor(pr)[0]).id;
    const comments = [...this.comments], summary = this.summaryInput.value();
    r.confirm = false; r.phase = "posting"; r.error = null;
    this.leaveBox();
    cx.spawn(async cx => {
      try {
        r.url = await postReview(this.git.root, this.on, pr, comments, event, summary);
        r.phase = "posted";
        saveReviewed(commentKey(this.git.root, pr.number), pr.headOid).catch(() => {});
        if (this.pr === pr) { this.comments = this.comments.filter(c => !comments.includes(c)); this.storeComments(cx); this.loadThreads(cx); }
      } catch (e) { r.phase = "editing"; r.error = `GitHub 拒绝了这次评审：${String(e?.message ?? e)}`; }
      cx.notify();
    });
  }

  openReview() { if (this.review?.url) openUrl(this.review.url); }

  /** Opens the merge screen for your own PR and reads which merge methods the repo allows. */
  startMerge(cx) {
    const pr = this.pr;
    if (!pr?.mine) return; // never merge someone else's PR
    this.leaveBox();
    this.phase = "merge";
    if (this.merge && this.merge.phase !== "loading") { this.merge.confirm = false; return; }
    const m = this.merge = { phase: "loading", methods: null, cursor: 0, confirm: false, error: null, approve: null };
    cx.spawn(async cx => {
      try { m.methods = await mergeMethods(this.git.root, this.on, pr); m.phase = "picking"; }
      catch (e) { m.methods = []; m.phase = "picking"; m.error = `无法读取仓库的合并设置：${String(e?.message ?? e)}`; }
      cx.notify();
    });
  }

  closeMerge() {
    if (this.merge?.phase === "merging") return;
    if (this.merge) this.merge.confirm = false;
    this.phase = this.plan ? "tour" : "setup";
  }

  /** Moves the merge method highlight. Any change asks for the two presses again. */
  moveMethod(i) {
    const m = this.merge, n = m?.methods?.length ?? 0;
    if (!m || m.phase !== "picking" || n === 0) return;
    m.cursor = (i + n) % n; m.confirm = false;
  }

  /** Merges the PR with the picked method. The first press only asks for a second one. */
  doMerge(cx) {
    const m = this.merge, pr = this.pr, method = m?.methods?.[m.cursor];
    if (!m || !pr?.mine || m.phase !== "picking" || !method) return;
    if (!m.confirm) { m.confirm = true; this.leaveBox(); return; }
    m.confirm = false; m.phase = "merging"; m.error = null;
    const ticket = this.ticketTour();
    cx.spawn(async cx => {
      try { await mergePR(this.git.root, this.on, pr, method.id); m.phase = "merged"; }
      catch (e) { m.phase = "picking"; m.error = `GitHub 未合并：${String(e?.message ?? e)}`; cx.notify(); return; }
      // A ticket's PR is its work, so merging it approves the ticket: done, its agent ended, its worktree removed.
      if (ticket) {
        m.approve = { phase: "approving", error: null }; cx.notify();
        try { const r = await ticketCommand(ticket, ["approve", String(ticket.number)]); m.approve = { phase: "approved", error: (r.warnings ?? []).join(" ") || null }; }
        catch (e) { m.approve = { phase: "failed", error: String(e?.message ?? e) }; }
      }
      cx.notify();
    });
  }

  openPR() { if (this.pr?.url) openUrl(this.pr.url); }

  startAsking(cx) {
    if (this.busy) return;
    this.asking = true;
    this.focusBox(this.input, cx);
  }

  /** The setup steps for a scope, in order. A PR tour adds the PR picker; omp adds its model. */
  steps(scope = this.scope) {
    // A requirement picks its depth like every other scope, then opens the browser: the
    // projects, branches and commits come from Beetle and local git, so there is nothing for
    // the agent to plan until g.
    if (scope === "requirement") return ["scope", "req", ...(this.agent === "omp" ? ["model"] : []), "depth"];
    const base = scope !== "pr" ? ["scope"]
      // A PR you reviewed at an older head asks whether to review only what changed since.
      : this.since && this.since.number === this.prNumber ? ["scope", "pr", "pass"] : ["scope", "pr"];
    return [...base, ...(this.agent === "omp" ? ["model"] : []), "depth"];
  }

  /** How many rows the current setup step has. */
  stepRows() {
    return this.step === "scope" ? SCOPES.length
      : this.step === "req" ? this.reqRows().length
      : this.step === "pr" ? (this.prs?.length ?? 0)
      : this.step === "pass" ? PASSES.length
      : this.step === "model" ? this.modelChoices().length
      : DEPTHS.length;
  }

  /** The rows of the model step: omp's own default, the models its roles name, this machine's, then all. */
  modelChoices() {
    const all = this.models ?? [];
    const named = (selector) => all.find((m) => m.selector === selector)?.name ?? selector.split("/").pop();
    const rows = [{ selector: null, label: "omp 默认模型", hint: this.standardModel ? `omp 的 default 角色：${this.standardModel}` : "用 omp 自己配的模型" }];
    const listed = new Set();
    // The roles' own models first: these are the ones this machine actually runs.
    for (const r of this.modelRoles ?? []) {
      if (listed.has(r.selector)) continue;
      listed.add(r.selector);
      rows.push({ selector: r.selector, label: named(r.selector), hint: `${r.selector} · omp 的 ${r.role} 角色` });
    }
    for (const m of all) {
      if (listed.has(m.selector)) continue;
      if (!this.modelAll && !m.common) continue;
      rows.push({ selector: m.selector, label: m.name, hint: `${m.selector}${m.contextWindow ? ` · ${Math.round(m.contextWindow / 1000)}K 上下文` : ""}` });
    }
    return rows;
  }

  /** The model flag this tour's agent gets. Only omp takes one; the others keep their own defaults. */
  modelForSessions() { return this.agent === "omp" ? this.model : null; }

  /** Loads omp's models for the model step: the catalogue kept from earlier today, else a fresh read. */
  loadModels(cx) {
    if (this.agent !== "omp" || this.models || this.modelsLoading) return;
    const cached = cachedModels();
    if (cached) {
      this.models = cached.models; this.standardModel = cached.standard; this.modelRoles = cached.roles ?? [];
      if (this.step === "model") this.goStep("model");
      return;
    }
    this.modelsLoading = true; this.modelsError = null;
    cx.spawn(async cx => {
      try {
        const listed = await listModels(this.on);
        this.models = listed.models; this.standardModel = listed.standard; this.modelRoles = listed.roles ?? [];
      } catch (e) { this.modelsError = `${String(e?.message ?? e)} 按 esc 后再选一次模型。`; }
      this.modelsLoading = false;
      if (this.step === "model") this.goStep("model");
      cx.notify();
    });
  }

  /** The model step's enter: keep the row's selector, or omp's default for the first row. */
  chooseModel(selector) {
    this.model = selector;
    rememberModel(selector);
    this.goStep("depth");
  }

  /** Moves the highlight within the current setup step. */
  moveCursor(delta) {
    const rows = this.stepRows();
    if (rows > 0) this.cursor = (this.cursor + delta + rows) % rows;
  }

  /** Shows a setup step with its current choice highlighted. */
  goStep(step) {
    this.step = step;
    this.cursor = step === "scope" ? SCOPES.findIndex(s => s.id === this.scope)
      : step === "req" ? Math.max(0, this.reqRows().findIndex(r => r.id === this.reqItem?.id))
      : step === "pr" ? Math.max(0, (this.prs ?? []).findIndex(p => p.number === this.prNumber))
      : step === "pass" ? Math.max(0, PASSES.findIndex(p => p.id === this.pass))
      : step === "model" ? Math.max(0, this.modelChoices().findIndex(m => m.selector === this.model))
      : DEPTHS.findIndex(d => d.id === this.depth);
  }

  back() {
    const steps = this.steps(), i = steps.indexOf(this.step);
    if (i > 0) this.goStep(steps[i - 1]);
  }

  /** Loads the open PRs once they are needed. A failure (no gh, signed out) shows on the PR step and the next visit retries. */
  loadPRs(cx) {
    if (this.prs || this.prsLoading || !this.git.root) return;
    this.prsLoading = true; this.prsError = null;
    cx.spawn(async cx => {
      try { this.prs = await listPRs(this.git.root, this.on); }
      catch (e) { this.prsError = `${String(e?.message ?? e)} 按 esc 后重新选择 PR 再试。`; }
      this.prsLoading = false;
      if (this.step === "pr") this.goStep("pr");
      cx.notify();
    });
  }

  /** The picker's rows: my requirements from prism-link's cache, cut by the status chip and the filter text. */
  reqRows() {
    const items = this.reqs?.items ?? [];
    const q = this.reqFilterInput.value().trim().toLowerCase();
    return items.filter(r => (this.reqChip === "全部" || r.status === this.reqChip)
      && (!q || String(r.title ?? "").toLowerCase().includes(q) || String(r.id).includes(q)));
  }

  /** The status chips: 全部 and every status the list holds, in the order the list shows them. */
  reqChips() {
    const seen = [];
    for (const r of this.reqs?.items ?? []) if (r.status && !seen.includes(r.status)) seen.push(r.status);
    return ["全部", ...seen];
  }

  setReqChip(name, cx) { this.reqChip = name; this.cursor = 0; }

  /**
   * The list of my requirements: prism-link's cache first, so the picker opens at once; a refresh
   * asks prism-link for a new one. The mod never reads the Meegle API itself.
   */
  loadReqs(cx, refresh = false) {
    if (this.reqsLoading) return;
    if (this.reqs && !refresh) return;
    this.reqsLoading = true; this.reqsError = null;
    cx.spawn(async cx => {
      try {
        if (refresh) this.reqs = await refreshMine(this.on);
        else {
          const mine = await readMine();
          this.reqs = mine;
          if (mine.error) this.reqsError = `${mine.error}。按 r 重新拉取。`;
        }
      } catch (e) { this.reqsError = `${String(e?.message ?? e)} 按 r 重试。`; }
      this.reqsLoading = false;
      if (this.step === "req") this.goStep("req");
      cx.notify();
    });
  }

  /** Opens the requirement browser: its projects from Beetle, then each one's branch and commits. */
  openRequirement(item, cx) {
    this.reqItem = item;
    this.leaveBox();
    this.phase = "require";
    this.req = null; this.reqSel = { p: 0, c: 0 }; this.reqCommit = null;
    // props { tour: true } asks for the agent's tour at once, without the browser in between.
    this.autoTour = Boolean(props()?.tour);
    this.loadRequirementNow(cx);
    // An opener may only know the id: the list has the title and status.
    if (!item.title || !item.status) cx.spawn(async cx => {
      const mine = await readMine();
      const known = mine.items.find(r => String(r.id) === String(item.id));
      if (!known || this.reqItem !== item) return;
      this.reqItem = { ...item, title: item.title || known.title, status: item.status || known.status };
      // The loaded requirement carries its own copy of the title and status: keep them in step.
      if (this.req?.id === String(item.id)) {
        this.req = { ...this.req, title: this.req.title || known.title, status: this.req.status || known.status };
      }
      cx.notify();
    });
  }

  /** Reads the requirement (again, after 刷新): Beetle's branches, then local git for each project. */
  loadRequirementNow(cx) {
    const item = this.reqItem;
    if (!item) return;
    const gen = this.gen = (this.gen ?? 0) + 1;
    this.reqLoading = `正在读取需求 ${item.id} 的工程和分支`;
    cx.spawn(async cx => {
      try {
        const settings = await loadSettings();
        const req = await loadRequirement(item, settings, this.on);
        if (gen !== this.gen) return;
        // An opener that only knew the id gets the title and status from the cached list meanwhile.
        if (this.reqItem && this.reqItem !== item) { req.title ||= this.reqItem.title; req.status ||= this.reqItem.status; }
        this.req = req; this.reqLoading = null;
        this.selectCommit(0, 0, cx);
        if (this.autoTour) { this.autoTour = false; this.startReqTour(cx); }
      } catch (e) {
        if (gen === this.gen) { this.reqLoading = null; this.fail(String(e?.message ?? e)); }
      }
      cx.notify();
    });
  }

  refreshReq(cx) {
    if (this.reqLoading || !this.reqItem) return;
    this.loadRequirementNow(cx);
  }

  /** Reads the requirement again without leaving the tour: after a fix's push moved a branch. */
  refreshReqQuietly(cx) {
    const item = this.reqItem;
    if (!item) return;
    cx.spawn(async cx => {
      try {
        const settings = await loadSettings();
        const req = await loadRequirement(item, settings, this.on);
        if (this.reqItem !== item) return;
        this.req = req;
        if (this.phase === "tour") this.show(this.idx, cx);
      } catch { /* the tour keeps the commits it already had */ }
      cx.notify();
    });
  }

  /** Every commit of the requirement, in project order: the browser's j/k list. */
  reqRowList() {
    return (this.req?.projects ?? []).flatMap((p, pi) => p.commits.map((c, ci) => ({ pi, ci, ...c })));
  }

  /** Shows one commit's diff beside the list, its files split apart. */
  selectCommit(p, c, cx) {
    const commit = this.req?.projects[p]?.commits[c];
    this.reqSel = { p, c };
    this.reqCommit = commit ? { p, c, files: [], loading: true, error: null } : null;
    if (!commit) { cx.notify?.(); return; }
    const dir = this.req.projects[p].dir;
    cx.spawn(async cx => {
      const text = await commitDiff(dir, commit.sha, this.on);
      if (this.reqSel.p !== p || this.reqSel.c !== c) return;
      const files = text ? splitDiff(text) : [];
      this.reqCommit = { p, c, files, loading: false, error: files.length ? null : "这个提交没有可显示的 diff" };
      cx.notify();
    });
  }

  moveReqCursor(delta, cx) {
    const rows = this.reqRowList();
    if (!rows.length) return;
    const at = rows.findIndex(r => r.pi === this.reqSel.p && r.ci === this.reqSel.c);
    const next = rows[(at + delta + rows.length) % rows.length];
    this.selectCommit(next.pi, next.ci, cx);
  }

  depthLabel() { return DEPTHS.find(d => d.id === this.depth)?.label ?? this.depth; }

  /** g in the browser: the agent plans a tour across the requirement's projects. */
  startReqTour(cx) {
    if (!this.req || this.phase !== "require" || !this.reqRowList().length) return;
    this.startRequirement(cx);
  }

  /**
   * Plans a tour of the whole requirement. The agent runs in the first cloned project and is
   * told every project's folder, branch and commits, so it can read each one with `git -C`.
   */
  startRequirement(cx) {
    const req = this.req;
    if (!req) return;
    const dir = req.projects.find(p => p.dir)?.dir ?? this.git.root;
    this.phase = "planning";
    this.planNote = `正在读取需求 ${req.id} 各工程的改动`;
    const session = this.session = new AgentSession(this.agent, dir, { model: this.modelForSessions() });
    const gen = this.gen = (this.gen ?? 0) + 1;
    const head = req.projects.map(p => String(p.head ?? "").slice(0, 12)).filter(Boolean).join("-") || String(req.id);
    cx.spawn(async cx => {
      try {
        const prompt = reqPlanPrompt(reqSubject(req), this.depth);
        this.savedKey = planKey({ root: req.id, scope: "requirement", depth: this.depth, head });
        const saved = this.savedKey ? await loadSavedPlan(this.savedKey) : null;
        if (gen !== this.gen) return;
        let plan = saved?.plan ?? null;
        if (plan && saved.agent === session.agent) session.id = saved.session;
        if (!plan) plan = parsePlan(await session.ask(prompt));
        if (gen !== this.gen) return;
        this.planNote = null; this.plan = plan; this.phase = "tour";
        this.comments = []; this.commentsKeyAt = null;
        this.show(0, cx);
        this.loadRepoFiles(cx);
        if (!plan.savedAt) this.storePlan();
      } catch (e) { if (gen === this.gen) this.fail(String(e?.message ?? e)); }
      cx.notify();
    });
  }

  /** The saved comments, loaded once per requirement branch commit. A tour moves between projects. */
  async loadCommentsFor(key) {
    if (!key || key === this.commentsKeyAt) return;
    this.commentsKeyAt = key;
    this.comments = await loadComments(key);
  }

  /** The project a stop belongs to: by the stop's `repo`, else the only project there is. */
  projectOf(stop) {
    const all = this.req?.projects ?? [];
    if (!stop) return null;
    const named = stop.repo ? all.find(p => p.engine === stop.repo) : null;
    return named ?? (all.length === 1 ? all[0] : null);
  }

  /** Where a file lives on this computer: the requirement project's folder, or the toured repo. */
  localPath(file) {
    if (this.req) { const p = this.projectOf(this.plan?.stops[this.idx]); return p?.dir ? `${p.dir}/${file}` : null; }
    return `${this.git.root}/${file}`;
  }

  /**
   * The file the saved comments belong to: a PR's number, or a requirement branch's commit
   * (the code the comment was written against). Null when there is nothing to comment on.
   */
  commentsKey() {
    if (this.pr) return commentKey(this.git.root, this.pr.number);
    if (this.req) {
      const p = this.projectOf(this.plan?.stops[this.idx]);
      if (p?.dir && p.head) return commentKey(p.dir, `${p.branch}@${p.head}`);
    }
    return null;
  }

  /** One file's change on a requirement branch, rows-ready. Empty when git has none. */
  async loadReqDiff(project, file) {
    const text = await branchFileDiff(project.dir, project.baseRef ?? `origin/${project.base}`, project.head, file, this.on);
    const rows = text ? diffRows(text) : [];
    return highlightRows(rows, file);
  }

  /** Enter on the highlighted row: move to the next step, or start the tour from the last one. */
  pick(cx) {
    // Finding the repo and the agent CLIs takes a few seconds. Until it's done there is
    // nothing to tour, and the detection would also reset the step under the reader.
    if (!this.git.root) return;
    if (this.step === "scope") {
      const s = SCOPES[this.cursor];
      if (s.id === "branch" && this.git.changed.length === 0) return;
      this.scope = s.id;
      if (s.id === "feature" && !this.featureInput.value().trim()) { this.focusBox(this.featureInput, cx); return; }
      this.leaveBox();
      this.goStep(this.steps()[1]);
      if (this.step === "pr") this.loadPRs(cx);
      if (this.step === "req") this.loadReqs(cx);
    } else if (this.step === "req") {
      const item = this.reqRows()[this.cursor];
      if (!item) return;
      // The requirement is opened after the depth (the last step): this just records which one.
      this.reqItem = item;
      const steps = this.steps();
      this.goStep(steps[steps.indexOf("req") + 1]);
      if (this.step === "model") this.loadModels(cx);
    } else if (this.step === "pr") {
      const p = this.prs?.[this.cursor];
      if (!p || this.sinceLoading) return;
      this.prNumber = p.number; this.since = null; this.pass = "since";
      // Look up your last review of this PR. When it was at an older head, offer a re-review.
      this.sinceLoading = true;
      cx.spawn(async cx => {
        const last = await lastReviewed(this.git.root, this.on, commentKey(this.git.root, p.number), p.number, p.headRefOid).catch(() => null);
        this.sinceLoading = false;
        if (this.prNumber === p.number && this.step === "pr") {
          this.since = last ? { number: p.number, ...last } : null;
          // The next step after the PR picker: a re-review pass, omp's model, or the depth.
          this.goStep(this.steps(this.scope)[this.steps(this.scope).indexOf("pr") + 1]);
        }
        cx.notify();
      });
    } else if (this.step === "pass") {
      this.pass = PASSES[this.cursor].id;
      const steps = this.steps();
      this.goStep(steps[steps.indexOf("pass") + 1]);
    } else if (this.step === "model") {
      this.chooseModel(this.modelChoices()[this.cursor]?.selector ?? null);
    } else {
      this.depth = DEPTHS[this.cursor].id;
      // A requirement is browsed first: g starts the agent's tour from there.
      if (this.scope === "requirement") this.openRequirement(this.reqItem, cx);
      else this.start(cx);
    }
  }

  /** Code beside the explanation when the pane is wide, unless the s key chose. */
  isSplit() { return this.split ?? this.width >= SPLIT_WIDTH; }

  toggleSplit() { this.split = !this.isSplit(); }

  openInEditor() {
    const s = this.plan?.stops[this.idx];
    if (!s) return;
    if (this.pr) openUrl(`${this.pr.url}/files`); // the PR's files aren't on disk
    else { const path = this.localPath(s.file); if (path) openInEditor(path, s.start); }
  }

  reset(cx, keepTicket = false) {
    if (!keepTicket) { publishTicketReview(this, true); this.ticketReviewActive = false; }
    this.ticketWaiting = false;
    this.gen = (this.gen ?? 0) + 1;
    this.session?.stop(); this.session = null;
    this.fixSession?.stop(); this.fixSession = null; this.fix = null; // a fix's worktree stays and is reused next time
    this.review = null; this.merge = null; this.checks = null; this.since = null; this.sinceLoading = false; this.handBack = null;
    this.reviewTicket = null;
    this.threadBusy = null; this.threadError = null; this.openResolved = new Set();
    this.threadsLoaded = false; this.threadsError = null;
    if (!keepTicket) this.leaveBox();
    this.plan = null; this.busy = null; this.error = null;
    this.pr = null; this.prNumber = null; this.prs = null; this.diff = null; this.planNote = null; this.comments = []; this.threads = []; this.savedKey = null; this.viewed = {};
    // The picker's list stays (it is prism-link's cache); the picked requirement does not.
    this.req = null; this.reqItem = null; this.reqLoading = null; this.reqSel = { p: 0, c: 0 }; this.reqCommit = null; this.commentsKeyAt = null;
    this.files = null; this.other = null; this.diffMarks = null; this.linkRows = null; this.scrollReq = null; this.repoFiles = new Set();
    this.phase = this.git.root ? "setup" : "error";
    this.tourStale = false;
    // 新导览 is the one way to forget the tab's tour; a ticket's refresh keeps it.
    if (!keepTicket && this.tabId) clearTabTour(this.tabId).catch(() => {});
    this.goStep("scope");
    if (!this.git.root) cx.spawn(async cx => { this.phase = "setup"; await this.detect(); cx.notify(); });
  }

  key(e, cx) {
    const k = e.key;
    // A text box has the keyboard: it gets every key except esc and tab, which hand keys back.
    if (this.typing) {
      if (k === "escape" || k === "tab") { this.leaveBox(); cx.stop_propagation(); cx.notify(); }
      return;
    }
    // The settings panel is open: it takes every key.
    if (this.shortcuts.open) { this.shortcuts.key(e, cx); return; }
    // A press with ctrl, alt or cmd is ignored, unless the user put a shortcut on that key.
    if ((e.modifiers?.control || e.modifiers?.alt || e.modifiers?.platform) && !this.shortcuts.idFor(e.keystroke)) return;
    // A key that is turned off in the settings does nothing. Its button still works.
    const on = (/** @type {string} */ id) => !this.shortcuts.isOff(id);
    // True when this press is the key that shortcut is on now: the user can change keys in the settings.
    const is = (/** @type {string} */ id) => this.shortcuts.matches(id, e.keystroke);
    // z zooms this pane to fill the tab and back, on every screen (Herdr's pane.zoom, ctrl-shift-z).
    if (is("zoom")) { run("pane.zoom"); cx.stop_propagation(); return; }
    let handled = true;
    // The confirm dialog is open (push, post or merge): y goes ahead, n or esc cancels, other keys wait.
    const asking = pendingConfirm(this);
    if (asking) {
      if (k === "y") asking.go(cx);
      else if (k === "n" || k === "escape") asking.cancel();
      cx.stop_propagation(); cx.notify();
      return;
    }
    // , opens the settings, on every screen.
    if (this.shortcuts.key(e, cx)) return;
    if (this.phase === "setup" && !this.git.root) {
      handled = false; // still finding the repo; see pick()
    } else if (this.phase === "setup") {
      // Scopes and depths have letters. PRs take 1 to 9 for the first nine.
      const list = this.step === "scope" ? SCOPES : this.step === "depth" ? DEPTHS : this.step === "pass" ? PASSES : null;
      const letter = list ? list.findIndex(x => x.key === k) : /^[1-9]$/.test(k) && +k <= this.stepRows() ? +k - 1 : -1;
      const onFeature = this.step === "scope" && SCOPES[this.cursor]?.id === "feature";
      if (letter >= 0) this.cursor = letter;
      else if (k === "j" || k === "down") this.moveCursor(1);
      else if (k === "k" || k === "up") this.moveCursor(-1);
      else if (k === "enter") this.pick(cx);
      else if (k === "tab" && onFeature) this.focusBox(this.featureInput, cx);
      else if ((k === "tab" || k === "/") && this.step === "req") this.focusBox(this.reqFilterInput, cx);
      else if (k === "r" && this.step === "req") this.loadReqs(cx, true);
      else if (k === "escape" && this.step !== "scope") this.back();
      else if (is("agent") && this.agents.length > 1) this.switchAgent();
      else if (is("model") && this.agent === "omp") { this.goStep("model"); this.loadModels(cx); }
      else handled = false;
    } else if (this.phase === "require") {
      const depth = /^[1-3]$/.test(k) ? +k - 1 : -1;
      if (k === "j" || k === "down") this.moveReqCursor(1, cx);
      else if (k === "k" || k === "up") this.moveReqCursor(-1, cx);
      else if (is("guide")) this.startReqTour(cx);
      else if (k === "r") this.refreshReq(cx);
      else if (depth >= 0) this.depth = DEPTHS[depth].id;
      else if (k === "q" || k === "escape") this.reset(cx);
      else handled = false;
    } else if (this.phase === "planning") {
      if (k === "escape" || k === "q") this.reset(cx);
      else handled = false;
    } else if (this.phase === "tour") {
      if (is("next") || k === "down") this.move(1, cx);
      else if (is("prev") || k === "up") this.move(-1, cx);
      else if (is("scroll-down")) this.scrollCode(1, cx);
      else if (is("scroll-up")) this.scrollCode(-1, cx);
      else if (is("deeper")) this.deeper(cx);
      else if (is("technical")) this.technical(cx);
      else if ((k === "a" || k === "/") && on("ask")) this.startAsking(cx);
      else if (is("open")) this.openInEditor();
      else if (is("split")) this.toggleSplit();
      else if (is("files") && this.pr) this.showFiles = !this.showFiles;
      else if (is("explain") && this.other) this.explainFile(cx);
      else if (is("viewed") && this.pr) this.toggleViewed(this.currentFile(), cx);
      else if (is("merge") && this.pr?.mine) this.startMerge(cx);
      else if (k === "escape" && this.commenting) this.leaveBox();
      else if (is("fix") && this.pr?.mine) this.startFix(cx);
      else if (k === "g" && this.ticketTour()) this.requestChanges(cx);
      else if (is("review") && this.pr) this.startReview(cx);
      else if (is("checks") && this.pr) this.openChecks(cx);
      else if (is("replan") && this.savedKey) this.replan(cx);
      else if (k === "q") this.reset(cx);
      else handled = false;
    } else if (this.phase === "fix") {
      if (k === "b" || k === "escape") this.closeFix();
      else if (is("push")) this.pushFix(cx);
      else if (is("discard")) this.discardFix(cx);
      else if ((k === "r" || k === "a" || k === "/") && on("reply")) this.startReply(cx);
      else handled = false;
    } else if (this.phase === "merge") {
      const m = this.merge, n = /^[1-3]$/.test(k) ? +k - 1 : -1;
      if (k === "b" || k === "escape") this.closeMerge();
      else if ((is("merge")) || k === "enter") this.doMerge(cx);
      else if (is("open") && m?.phase === "merged") this.openPR();
      else if (k === "q" && m?.phase === "merged") this.reset(cx);
      else if (k === "c" && m?.phase === "merged" && this.ticketTour() && m.approve?.phase !== "approving") this.closeTab(cx);
      else if (n >= 0 && n < (m?.methods?.length ?? 0)) this.moveMethod(n);
      else if (k === "j" || k === "down") this.moveMethod((m?.cursor ?? 0) + 1);
      else if (k === "k" || k === "up") this.moveMethod((m?.cursor ?? 0) - 1);
      else handled = false;
    } else if (this.phase === "checks") {
      const n = /^[1-9]$/.test(k) ? +k - 1 : -1;
      if (k === "b" || k === "escape") this.closeChecks();
      else if ((is("explain")) || k === "enter") this.explainCheck(cx);
      else if (is("open")) this.openCheck();
      else if (is("refresh")) this.loadChecks(cx);
      else if (n >= 0 && n < (this.checks?.list?.length ?? 0)) this.checks.cursor = n;
      else if (k === "j" || k === "down") this.moveCheck((this.checks?.cursor ?? 0) + 1);
      else if (k === "k" || k === "up") this.moveCheck((this.checks?.cursor ?? 0) - 1);
      else handled = false;
    } else if (this.phase === "review") {
      const r = this.review, verdict = /^[1-3]$/.test(k) ? +k - 1 : -1;
      if (k === "b" || k === "escape") this.closeReview();
      else if ((is("review")) || k === "enter") this.postReview(cx);
      else if (is("open")) this.openReview();
      else if (k === "tab" && r?.phase === "editing") this.focusBox(this.summaryInput, cx);
      else if (verdict >= 0 && this.pr && verdict < eventsFor(this.pr).length) this.moveVerdict(verdict);
      else if (k === "j" || k === "down") this.moveVerdict((r?.cursor ?? 0) + 1);
      else if (k === "k" || k === "up") this.moveVerdict((r?.cursor ?? 0) - 1);
      else handled = false;
    } else if (this.phase === "error") {
      if (k === "enter" || k === "q" || k === "escape") this.reset(cx);
      else handled = false;
    } else handled = false;
    if (handled) { cx.stop_propagation(); cx.notify(); }
  }

  render(cx) {
    if (this.launcher) return v_flex();
    this.syncTicketReview(cx);
    const t = colors();
    const root = v_flex().id("tourist").relative().track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      // A click on the code, the text or a divider can take the keyboard away. Take it back
      // once the click is over, unless it landed in a text box.
      .on_mouse_up("left", (_e, cx) => { cx.timer.after(30, () => { if (!this.typing) this.handle.focus(); }); })
      .size_full().min_h(0).text_color(t.foreground).text_size(SIZE.text)
      .on_size_change((size, cx) => { if (size.width !== this.width || size.height !== this.height) { this.width = size.width; this.height = size.height; cx.notify(); } }) // no fill: the pane's own background shows, like a terminal
      // ...except over a background picture with see-through panes, which have none: the terminals' color at their opacity.
      .when(seeThroughOpacity() !== null, (el) => el.bg(paneBackground(t.background)));
    // The settings panel sits over any screen, under the gear at the top right. A short pane gets a shorter panel.
    const settings = (/** @type {typeof root} */ el) => el.when(this.shortcuts.open, (/** @type {typeof root} */ el) => el.child(this.shortcuts.panel(t,
      { top: 52, right: SIZE.panePad, maxHeight: Math.max(120, Math.min(420, (this.height || 600) - 130)) })));
    if (this.phase === "setup") return settings(root.child(setupView(this, t)));
    if (this.phase === "planning") return settings(root.child(planningView(this, t)));
    if (this.phase === "error") return settings(root.child(errorView(this, t)));
    if (this.phase === "require") return settings(root.child(requireView(this, t)));
    // Push, post and merge ask first, in a dialog over the screen.
    const dialog = confirmDialog(this, t);
    if (this.phase === "fix" && this.fix && (this.pr || this.req)) return settings(root.child(fixView(this, t)).when(Boolean(dialog), el => el.child(dialog)));
    if (this.phase === "review" && this.review && this.pr) return settings(root.child(reviewView(this, t)).when(Boolean(dialog), el => el.child(dialog)));
    if (this.phase === "merge" && this.merge && this.pr) return settings(root.child(mergeView(this, t)).when(Boolean(dialog), el => el.child(dialog)));
    if (this.phase === "checks" && this.checks && this.pr) return settings(root.child(checksView(this, t)));
    return settings(root.child(tourView(this, t)).when(Boolean(dialog), el => el.child(dialog)));
  }
}
