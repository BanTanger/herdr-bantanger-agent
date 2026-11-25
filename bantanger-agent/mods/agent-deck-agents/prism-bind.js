// agent-deck: the prism-link bind flow's logic — the input rule, the argv the dialog runs and
// the result it parses. No view here, so it is testable with plain node (prism-bind-view.js
// has the dialog).

// `{ [session]: { session, cwd, terminal, branch, at } }`: shared, not a field, so the dialog
// copy (a second instance of this mod) and an app restart see the same pending prompt.
export const BIND_TARGETS = "prism-bind.targets";
// `{ [terminal]: ms }`: the agent cards whose prompt was swiped away. Shared so every copy of
// this mod hides the same chip, and it outlives a restart like the target it suppresses.
export const BIND_DISMISSED = "prism-bind.dismissed";
// Horizontal travel that counts as a swipe: a drag that crosses it, or a trackpad swipe that
// accumulates it, dismisses that agent's prompt.
export const SWIPE_PX = 28;
export const SWIPE_WHEEL_PX = 48;

// prism-link's own rule (prism_link.py FEISHU_RE / DIGITS_RE): a number, or a Feishu story URL.
// Refusing the rest here beats an exec that exits 2.
const STORY_NUMBER = /^\d+$/;
const STORY_LINK = /project\.feishu\.cn\/[^/\s]+\/[^/\s]+\/detail\/\d+/;

export function storyInput(text) {
  const value = String(text ?? "").trim();
  if (!value) return { error: "填写飞书需求链接或需求号" };
  if (STORY_NUMBER.test(value) || STORY_LINK.test(value)) return { value };
  return { error: "只接受纯数字需求号或飞书需求链接" };
}

// `env` argv: the CLI labels the terminal that reported the session, and `exec` has no env
// option, so HC_TERMINAL_ID is set here (the core trusts it when HC_TERMINAL_SOCKET is unset,
// herdr-core client.rs terminal_id()). No `--force` by default: a session linked meanwhile (in a
// terminal, or by a prompt that was left over) keeps its story unless the person says otherwise —
// prism-link exits 3, the dialog offers 覆盖关联, and only that retry forces.
// `terminalOnly` labels the terminal without a session meta: the picker opened on an agent whose
// session id it cannot know (`omp` started without `--resume`). The label and the index are the
// binding truth (ticket 08); a later `--from-terminal` copies it into the session meta.
export function bindArgv(cli, target, story, force = false, terminalOnly = false) {
  const argv = [];
  const terminal = String(target?.terminal ?? "").trim();
  if (terminal) argv.push(`HC_TERMINAL_ID=${terminal}`);
  if (terminalOnly) {
    return [...argv, cli, "link", "--cwd", String(target?.cwd ?? ""), "--terminal-only",
      "--story", String(story), ...(force ? ["--force"] : [])];
  }
  // No `--session-id` when the picker has none: prism-link resolves the agent's hint file
  // (`~/.local/state/prism-link/sessions/<terminal>.json`) and falls back to a terminal-only
  // binding when there is still none.
  const session = String(target?.session ?? "").trim();
  return [...argv, cli, "link", "--cwd", String(target?.cwd ?? ""), ...(session ? ["--session-id", session] : []),
    "--story", String(story), ...(force ? ["--force"] : [])];
}

export function prismCli(home) {
  return `${home}/.local/bin/prism-link`;
}

// What the current branch is bound to, writing nothing: `link --branch-only --dry-run` asks only
// `getStoryInfoByBranchName` (prism-link's detect/local-context hits are guesses about this
// machine, not the branch's requirement) and prints the id it would use.
export function lookupArgv(cli, target) {
  return [cli, "link", "--cwd", String(target?.cwd ?? ""), "--session-id", String(target?.session ?? ""), "--branch-only", "--dry-run"];
}

// What the press is about to label, said before it happens. A session's only link to a card is
// the terminal its event recorded, and a prompt outlives the app: by the time someone presses,
// that terminal can be gone or can be an agent other than the one in front. The label lands on
// the terminal, so this is the fact the dialog must show — the one that tells a stale prompt
// apart from the session someone just opened. `live` is the `terminals()` entry with the
// target's address, or null when there is none; `front` is the terminal that was in front before
// the dialog opened (not `focused()`: a mod overlay takes the keyboard, so it reads null there);
// `seen` is set once 确认关联到 <agent> was pressed for that same address (bindAcked).
export function bindTargetNote(target, live, front, seen = false) {
  const t = target ?? {};
  if (!t.session || !t.cwd) return { problem: "找不到这次未关联的会话，重新开一个会话或直接跑 prism-link link", agent: "", other: false };
  const address = String(t.terminal ?? "").trim();
  if (!address) return { problem: "这个会话没有终端，标签写不上；直接跑 prism-link link", agent: "", other: false };
  if (!live) return { problem: `终端 ${address} 已经不在，这条提示属于一个结束的 agent`, agent: "", other: false };
  const agent = String(live.title || live.labels?.where || address);
  // Unknown front (no capture) fails closed the same way: only that named press may go through.
  const other = !seen && String(front ?? "") !== address;
  return { problem: "", agent, other, note: other ? `另一个 agent：${agent}` : agent };
}

// The dialog's "branch already has a requirement" line. `lookup` is undefined (not asked),
// "busy", { id, name } for a hit, {} for none, or { error }.
export function lookupNote(lookup, branch) {
  if (lookup == null) return null;
  if (lookup === "busy") return { text: "查询当前分支的需求…", use: "", retry: false, tone: "dim" };
  if (lookup.id) {
    // Only the branch API speaks for the branch; a detect/local-context id is shown, not offered.
    const branchApi = !lookup.source || lookup.source === "beetle-api";
    return {
      text: `分支 ${branch || "unknown"} 已关联 ${lookup.id}${lookup.name ? ` · ${lookup.name}` : ""}`,
      use: branchApi ? String(lookup.id) : "",
      retry: !branchApi,
      tone: "foreground",
    };
  }
  if (lookup.error) return { text: lookup.error, use: "", retry: true, tone: "blocked" };
  return { text: "当前分支未关联需求", use: "", retry: true, tone: "dim" };
}

// The dialog's primary button: a conflict is the one case that overwrites.
export function saveLabel(busy, confirm) {
  if (busy) return "关联中…";
  return confirm ? "覆盖关联" : "关联";
}

// The primary button while the prompt belongs to another agent: it names that agent and asks for
// one deliberate press, instead of writing a label on a card nobody looked at. (The press also
// tries to show the agent, but `run()` reports no outcome, so the label claims the name only.)
export function ackLabel(agent) {
  const name = String(agent ?? "").trim() || "那个 agent";
  return `确认关联到 ${name.length > 12 ? `${name.slice(0, 11)}…` : name}`;
}

// 确认 was pressed for an address, and only that same terminal passes without a new press: a
// repeated unlinked event can rewrite the session's target while the dialog is open, and an
// acknowledgement of t4n must not authorize t4p.
export function bindAcked(target, ackTerminal) {
  const address = String(target?.terminal ?? "").trim();
  return Boolean(address) && address === String(ackTerminal ?? "").trim();
}

// The prompt this mod shows is per agent card, so pending sessions are folded onto the terminal
// they run in: the newest session per address wins (a tab that was restarted twice must not ask
// twice). A card is skipped when it cannot be labelled — the terminal is gone — and when it is
// already bound: `prism-link link` labels the terminal it linked, so a `req` label is the binding
// the person sees on the card, and asking again for a session whose tab is bound is the bug this
// check exists for. `dismissed` is BIND_DISMISSED. Returns Map(address → target).
export function prismPrompts(targets, terminals = [], dismissed = {}) {
  const live = new Map(terminals.map((k) => [String(k?.address ?? ""), k]));
  const out = new Map();
  for (const t of Object.values(targets ?? {})) {
    const address = String(t?.terminal ?? "").trim();
    if (!address || (dismissed ?? {})[address]) continue;
    const k = live.get(address);
    if (!k || k.state !== "live") continue;
    if (String(k.labels?.req ?? "").trim()) continue;
    const prev = out.get(address);
    // Equal or missing `at` must not let the map's insertion order decide which session a press
    // binds: two copies of this mod have to render the same chip.
    const better = !prev
      || Number(t.at ?? 0) > Number(prev.at ?? 0)
      || (Number(t.at ?? 0) === Number(prev.at ?? 0) && String(t.session ?? "") > String(prev.session ?? ""));
    if (better) out.set(address, { ...t, terminal: address });
  }
  return out;
}

// The shared targets after one unlinked event, or null when nothing should be remembered: a
// session with no project or no id cannot be bound, and a tab that is bound already (`live` is its
// terminal, or null while the first read is pending) must not be asked — `prism-link link` labels
// the terminal it linked, and a card reading "prism <id>" carrying an "未关联" chip is the
// bug this rules out. A newer session in the same terminal replaces the one it replaced, so a tab
// restarted twice leaves one target, not two.
export function mergeUnlinked(targets, event, live, now = Date.now()) {
  const session = String(event?.session_id ?? "").trim();
  const cwd = String(event?.cwd ?? "").trim();
  const terminal = String(event?.terminal ?? "").trim();
  if (!session || !cwd) return null;
  if (String(live?.labels?.req ?? "").trim()) return null;
  const next = { ...(targets ?? {}) };
  for (const [s, t] of Object.entries(next)) {
    if (s !== session && terminal && String(t?.terminal ?? "") === terminal) delete next[s];
  }
  next[session] = { session, cwd, terminal, branch: String(event?.branch ?? ""), at: now };
  return next;
}

// A swipe is travel, not direction: a card dismissed by dragging left must not need dragging
// right next time. `wheel` is the smaller accumulator a trackpad reports.
export function swipePast(travel, threshold = SWIPE_PX) {
  return Math.abs(Number(travel) || 0) >= threshold;
}

// The drag a press on a chip starts. Held on the view, not in the render, so a repaint mid-drag
// (the fade) does not restart the gesture. The origin is where the press landed: waiting for the
// first move to fix it swallows a fast swipe that reports one position.
export function swipeStart(x) {
  return { from: typeof x === "number" ? x : null, travel: 0, step: 0 };
}

// One pointer position. Travel is the distance from where the press began, in either direction,
// and `step` says when the fade is worth a repaint (each repaint redraws the window, and a drag
// arrives once per pixel).
export function swipeMove(state, x) {
  if (!state || typeof x !== "number") return state;
  if (state.from == null) return { ...state, from: x };
  const travel = Math.abs(x - state.from);
  return { ...state, travel, step: Math.min(4, Math.floor(travel / 7)) };
}

// A trackpad reports pixels with no button held: count the horizontal part only, so scrolling the
// list over a chip still scrolls. The closing event carries the gesture's last delta, so it counts
// before `ended` says the gesture is over; a vertical step neither adds travel nor resets it (a
// diagonal swipe reports both, and dropping the accumulator would make those miss).
export function wheelTravel(state, event) {
  const d = event?.delta ?? {};
  const step = Math.abs(d.x ?? 0) > Math.abs(d.y ?? 0) ? Math.abs(d.x ?? 0) : 0;
  return { travel: Number(state?.travel ?? 0) + step, ended: event?.touch_phase === "ended" };
}

// The requirement a card is bound to, from the files prism-link writes: the session's own meta,
// or a project-wide link carrying prism-link's `--scope project` marker. The harness keeps a
// req_id in the same project file without that marker, and it must not pass for a link nobody
// made (the collector refuses it for the same reason).
export function linkedReqId(sessionMeta, projectMeta) {
  const own = String(sessionMeta?.req_id ?? "").trim();
  if (own) return own;
  const p = projectMeta ?? {};
  const explicit = String(p.link_source ?? "").trim() === "prism-link" && String(p.link_scope ?? "").trim() === "project";
  return explicit ? String(p.req_id ?? "").trim() : "";
}

// The CLI prints one JSON line on stdout and its human line on stderr (prism_link.py emit).
export function parseLinkResult(result) {
  const code = Number(result?.code ?? -1);
  const lines = String(result?.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  let data = null;
  for (let i = lines.length - 1; i >= 0 && !data; i -= 1) {
    try { data = JSON.parse(lines[i]); } catch {}
  }
  if (code === 0 && data?.ok) {
    return {
      ok: true,
      reqId: String(data.req_id ?? ""),
      reqUrl: String(data.req_url ?? ""),
      storyName: String(data.story_name ?? ""),
      source: String(data.source ?? ""),
      // The branch the answer is about: the event's snapshot may be from before a branch switch.
      branch: String(data.branch ?? ""),
      warnings: data.warnings ?? [],
    };
  }
  const human = String(result?.stderr ?? "").split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
  const exit = Number(data?.code ?? code);
  return {
    ok: false,
    conflict: exit === 3,
    // exit 4 is only an answer when prism-link says the branch API itself answered "none"
    // (`lookup`). No lookup field (an older CLI, or a non-branch query) keeps the old reading.
    unresolved: exit === 4 && String(data?.lookup ?? "") !== "error",
    existing: String(data?.existing_req_id ?? ""),
    error: data?.error || data?.reason || human || `prism-link exit ${code}`,
  };
}

// ── mine: the cached "my requirements" list ──────────────────────────────
// `prism-link mine` answers one JSON line (contract: .scratch/prism-mine/issues/04). The dialog
// filters this list in memory; typing never calls the CLI. Helpers stay pure so node can test them.

export const MINE_TTL = 5 * 60 * 1000;

export function mineArgv(cli, refresh = false) {
  return [cli, "mine", ...(refresh ? ["--refresh"] : [])];
}

// `result` is an `exec` result. A stale answer still carries usable items and an error to show.
export function parseMine(result) {
  const lines = String(result?.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  let data = null;
  for (let i = lines.length - 1; i >= 0 && !data; i -= 1) {
    try { data = JSON.parse(lines[i]); } catch {}
  }
  const human = String(result?.stderr ?? "").split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
  if (!data) return { items: [], fetchedAt: null, stale: false, error: human || "prism-link mine 没有输出" };
  if (!data.ok) return { items: [], fetchedAt: null, stale: false, error: data.error || human || "mine 取数失败", needsLogin: Boolean(data.needs_login) };
  return {
    items: Array.isArray(data.items) ? data.items : [],
    fetchedAt: data.fetchedAt ?? null,
    stale: Boolean(data.stale),
    error: data.stale ? String(data.error || "") : "",
    needsLogin: Boolean(data.needs_login),
  };
}

export function mineFresh(fetchedAt, now = Date.now()) {
  const at = Date.parse(String(fetchedAt ?? ""));
  if (!Number.isFinite(at)) return "—";
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

export function mineStatuses(items = []) {
  return ["全部", ...new Set(items.map((i) => String(i?.status ?? "")).filter(Boolean))];
}

// Title + requirement number only: status is a display field, and roles cost five extra calls.
export function filterMine(items = [], query = "", status = "全部") {
  const q = String(query ?? "").trim().toLowerCase();
  return items.filter((i) => {
    if (status && status !== "全部" && String(i?.status ?? "") !== status) return false;
    if (!q) return true;
    return `${i?.title ?? ""} ${i?.id ?? ""}`.toLowerCase().includes(q);
  });
}

export function moveIndex(index, delta, length) {
  if (!length) return 0;
  const next = (Number(index) || 0) + delta;
  return ((next % length) + length) % length;
}

export function cardLabel(reqId, title) {
  const id = String(reqId ?? "").trim();
  const name = String(title ?? "").trim();
  if (!id) return "";
  return name ? `prism ${id} · ${name}` : `prism ${id}`;
}
