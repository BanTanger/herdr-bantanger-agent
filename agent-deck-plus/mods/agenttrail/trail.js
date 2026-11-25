// Reads a repo's tickets, locally: a wayfinder map with its tickets, or a to-tickets
// slate, from .wayfinder/maps/<slug>/{map.md,tickets/} or .scratch/<slug>/{map.md,issues/}.
// Builds the same board the view draws, with tickets as cards ("blocked by" as the edges)
// and each ticket's checklist as its tasks. Read-only: it writes nowhere.
// No Herdr imports: the host passes exec and readTextFile in.

export const POLL_MS = 5000;
const MAX_TICKETS = 400;

export const norm = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
export const repoName = (p) => norm(p).split("/").pop() || String(p ?? "");

// The folder to follow: the focused terminal's, on this computer. Focus anywhere else
// (this view, another mod, a terminal on another machine) keeps the last one.
export function focusFolder(focus, spaces, last = null) {
  if (!focus?.terminal || !focus.cwd) return last;
  return spaces.find((s) => s.id === focus.space)?.machine ? last : norm(focus.cwd);
}

// ---- markdown

function splitFront(text) {
  const lines = String(text ?? "").split("\n");
  if (lines[0]?.trim() !== "---") return { meta: {}, body: lines.join("\n") };
  let end = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === "---") { end = i; break; }
  if (end < 0) return { meta: {}, body: lines.join("\n") };
  const meta = {};
  for (let i = 1; i < end; i++) {
    const at = lines[i].indexOf(":");
    if (at > 0) meta[lines[i].slice(0, at).trim().toLowerCase()] = lines[i].slice(at + 1).trim();
  }
  return { meta, body: lines.slice(end + 1).join("\n") };
}

// One "## Title" section's text, up to the next "## ".
function section(body, title) {
  const lines = body.split("\n");
  const want = title.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const m = /^##\s+(.+?)\s*$/.exec(lines[i]);
    if (!m || m[1].toLowerCase() !== want) continue;
    const out = [];
    for (let j = i + 1; j < lines.length && !/^##\s+/.test(lines[j]); j++) out.push(lines[j]);
    return out.join("\n").trim();
  }
  return "";
}

function bullets(text) {
  const out = [];
  for (const l of text.split("\n")) {
    const m = /^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/.exec(l);
    if (m) out.push(m[1]);
  }
  return out;
}

// Prose lines, for a section written in paragraphs or numbered steps.
function lines(text) {
  const out = [];
  for (const raw of text.split("\n")) {
    const l = raw.trim().replace(/^#+\s+/, "").replace(/^\d+[.)]\s+/, "").replace(/^\*\*|\*\*$/g, "").trim();
    if (!l || /^[-*|]/.test(l) || /^---+$/.test(l)) continue;
    out.push(l.replace(/\*\*/g, "").replace(/\]/g, "]"));
  }
  return out;
}

const yamlList = (v) => {
  const s = String(v ?? "").trim();
  if (!s || s === "[]") return [];
  return s.replace(/^\[|\]$/g, "").split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
};

// ---- one ticket

export function parseTicket(path, text, mtime = null) {
  const base = norm(path).split("/").pop().replace(/\.md$/i, "");
  const { meta, body } = splitFront(text);
  const head = (/^#\s+(.+)$/m.exec(body) ?? [])[1] ?? "";
  const fromHead = head.replace(/^\d{1,3}\s*[—–\-:.]+\s*/, "").trim();
  const title = (meta.title || fromHead || base).slice(0, 240);
  const status = String(meta.status ?? (/^\s*(?:\*\*)?Status:(?:\*\*)?\s*(.+)$/m.exec(body) ?? [])[1] ?? "").trim();
  const type = String(meta.type ?? (/^\s*(?:\*\*)?Type:(?:\*\*)?\s*([A-Za-z]+)/m.exec(body) ?? [])[1] ?? "").trim().toLowerCase();
  const blockedRaw = String(meta.blockedby ?? (/^\s*(?:\*\*)?Blocked by:(?:\*\*)?\s*(.+)$/m.exec(body) ?? [])[1] ?? "").trim();
  const blocksRaw = String(meta.blocks ?? (/^\s*(?:\*\*)?Blocks:(?:\*\*)?\s*(.+)$/m.exec(body) ?? [])[1] ?? "").trim();
  const blocks = yamlList(blocksRaw);
  const blockedBy = yamlList(blockedRaw).length
    ? yamlList(blockedRaw)
    : blockedRaw.replace(/\(.*?\)/g, "").split(/[,，、;；]|\band\b/).map((s) => s.trim()).filter((s) => /^#?\d{1,3}\b|^[\w-]{2,}$/.test(s) && !/^none$/i.test(s));
  const checks = [];
  for (const l of body.split("\n")) {
    const m = /^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/.exec(l);
    if (m) checks.push({ title: m[2].slice(0, 200), done: m[1] !== " " });
  }
  const closed = /closed|done|complete|resolved|merged|wontfix|cancel/i.test(status);
  const done = closed || (checks.length > 0 && checks.every((c) => c.done));
  const claimed = !done && (/(claim|working|progress|active|doing|started)/i.test(status)
    || (Boolean(meta.claimed) && !/^unassigned$/i.test(String(meta.assigned ?? "").trim())));
  const id = (/^(\d{1,3})\b/.exec(base) ?? [])[1] ?? base;
  const question = section(body, "Question") || section(body, "What to build");
  const answer = section(body, "Answer") || section(body, "Resolution") || section(body, "Findings") || section(body, "What it delivers");
  const prose = done ? answer : question;
  const rows = checks.length ? [] : (bullets(prose).length ? bullets(prose) : lines(prose)).slice(0, 12).map((b) => ({ label: b.slice(0, 240) }));
  return { id, slug: base, title, type, status, blockedBy, blocks, checks, done, claimed, question, answer, rows, mtime, path: norm(path) };
}

export function parseMap(text) {
  const { meta, body } = splitFront(text);
  const decided = [];
  for (const b of bullets(section(body, "Decisions so far"))) {
    const m = /^\[([^\]]+)\]\(([^)]+)\)\s*[:：—–-]?\s*(.*)$/.exec(b);
    if (m) decided.push({ title: m[1], gist: m[3] });
    else {
      const at = b.search(/[:：]/);
      decided.push(at > 0 ? { title: b.slice(0, at), gist: b.slice(at + 1).trim() } : { title: b, gist: "" });
    }
  }
  return {
    title: String(meta.title ?? "").trim(),
    status: String(meta.status ?? "").trim(),
    destination: section(body, "Destination"),
    fog: bullets(section(body, "Not yet specified")),
    out: bullets(section(body, "Out of scope")),
    decided,
  };
}

// ---- the board the view draws

export function buildBoard({ key, dir, slug, map, tickets, files = 0 }) {
  const idx = new Map();
  for (const t of tickets) { idx.set(t.slug, t); if (!idx.has(t.id)) idx.set(t.id, t); }
  const resolve = (ref) => idx.get(ref) ?? idx.get((/^#?(\d{1,3})\b/.exec(ref) ?? [])[1] ?? "");
  const gistOf = (title) => {
    const pick = (map?.decided ?? []).find((d) => d.title && (d.title.includes(title) || title.includes(d.title)));
    return pick?.gist ?? "";
  };
  // Edges come from either side: a ticket's "blocked by", or another ticket's "blocks".
  const needsOf = new Map(tickets.map((t) => [t.id, new Set()]));
  for (const t of tickets) {
    for (const ref of t.blockedBy) { const b = resolve(ref); if (b && b.id !== t.id) needsOf.get(t.id).add(b.id); }
    for (const ref of t.blocks) { const d = resolve(ref); if (d && d.id !== t.id) needsOf.get(d.id).add(t.id); }
  }
  const plan = [];
  const status = new Map();
  const counts = { total: 0, done: 0, active: 0, blocked: 0, ready: 0 };
  const types = {};
  for (const t of tickets) {
    const needs = [...needsOf.get(t.id)];
    const open = needs.filter((id) => !idx.get(id)?.done);
    const s = t.done ? "done" : open.length ? "blocked" : t.claimed ? "active" : "pending";
    status.set(t.id, s);
    counts.total += 1;
    if (s === "done") counts.done += 1;
    else if (s === "active") counts.active += 1;
    else if (s === "blocked") counts.blocked += 1;
    else counts.ready += 1;
    const kind = t.type || "ticket"; // to-tickets states no type; call it by what it is
    types[kind] = (types[kind] ?? 0) + 1;
    plan.push({
      id: t.id, level: "component", parent: null, title: t.title, status: s, type: kind,
      tech: `#${t.id}`, needs, links: [], touchedAt: t.mtime, recent: [], rows: t.rows,
      gist: gistOf(t.title), blockedBy: t.blockedBy, slug: t.slug, path: t.path,
    });
    t.checks.forEach((check, i) => plan.push({
      id: `${t.id}:${i}`, level: "task", parent: t.id, title: check.title,
      status: check.done ? "done" : s === "active" ? "active" : "pending",
    }));
  }
  const comps = plan.filter((n) => n.level === "component");
  const newest = (list) => [...list].sort((a, b) => (b.touchedAt ?? 0) - (a.touchedAt ?? 0))[0];
  const current = (newest(comps.filter((n) => n.status === "active"))
    ?? newest(comps.filter((n) => n.status === "pending" && !n.blockedBy.length))
    ?? null)?.id ?? null;
  const stage = !tickets.length ? (map ? "charting" : "empty")
    : counts.done === counts.total ? "complete"
    : counts.active ? "working" : "ready";
  return {
    project: map?.title || slug, now: Date.now(), plan, runs: [], activity: null, recentActivity: [], derived: null,
    effort: {
      key, dir, slug, files, stage, counts, types, current, hasMap: Boolean(map),
      destination: map?.destination ?? "", fog: map?.fog ?? [], out: map?.out ?? [],
    },
  };
}

export const stageWord = (stage) => ({ working: "进行中", ready: "待开工", complete: "已完成", charting: "建图中", empty: "空" })[stage] ?? "";

// ---- where the files are

const LAYOUTS = [
  { dir: ".wayfinder/maps", map: (rel) => rel.length === 2 && rel[1] === "map.md", ticket: (rel) => rel.length === 3 && rel[1] === "tickets" },
  { dir: ".scratch", map: (rel) => rel.length === 2 && rel[1] === "map.md", ticket: (rel) => rel.length === 3 && rel[1] === "issues" },
];

function statLines(out) {
  const files = [];
  for (const line of String(out ?? "").split("\n")) {
    const m = /^(\d+)\s+(.+)$/.exec(line.trim());
    if (m) files.push({ path: norm(m[2]), at: Number(m[1]) * 1000 });
  }
  return files;
}

// state.kind: scanning, first look | efforts, a slate or map is shown | noeffort, nothing
//   found in this repo | plain, folder is not in a repo | none, no terminal seen yet
export class Feed {
  constructor({ exec, read, folder, now = Date.now }) {
    Object.assign(this, { exec, read, folder, now });
    this.board = null;
    this.state = { kind: "scanning", repo: null, efforts: [], slug: null };
    this.sig = "";
    this.at = undefined;
    this.place = undefined;
    this.chosen = null;
    this.roots = new Map();
    this.home = null; // the last place with a slate, so a terminal in /tmp still shows one
    this.pinned = null; // a folder picked by hand
  }

  async rootOf(folder) {
    if (!folder) return null;
    if (this.roots.has(folder)) return this.roots.get(folder);
    const r = await this.exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder }).catch(() => null);
    const root = r && r.code === 0 ? norm(r.stdout.trim()) : null;
    if (root) this.roots.set(folder, root);
    return root;
  }

  // Markdown files under a tree, with mtimes: one find, one stat per file.
  async listing(dir) {
    const r = await this.exec("find", [dir, "-maxdepth", "3", "-type", "f", "-name", "*.md", "-exec", "stat", "-f", "%m %N", "{}", "+"]).catch(() => null);
    if (r && r.code === 0) return statLines(r.stdout);
    const plain = await this.exec("find", [dir, "-maxdepth", "3", "-type", "f", "-name", "*.md"]).catch(() => null);
    if (!plain || plain.code !== 0) return null;
    return plain.stdout.split("\n").filter(Boolean).map((p) => ({ path: norm(p), at: null }));
  }

  async scan(root) {
    const efforts = [];
    for (const layout of LAYOUTS) {
      const base = `${root}/${layout.dir}`;
      const files = await this.listing(base);
      if (!files) continue;
      const groups = new Map();
      for (const f of files) {
        const rel = f.path.slice(base.length + 1).split("/");
        if (rel.length < 2 || rel.length > 3) continue;
        const slug = rel[0];
        const g = groups.get(slug) ?? { slug, mapFile: null, tickets: [], files: 0 };
        groups.set(slug, g);
        g.files += 1; // everything the slate holds, research/ included
        if (rel.length === 2 && layout.map(rel)) g.mapFile = f;
        else if (rel.length === 3 && layout.ticket(rel)) g.tickets.push(f);
      }
      for (const g of groups.values()) {
        if (!g.mapFile && !g.tickets.length) continue;
        const map = g.mapFile ? parseMap((await this.read(g.mapFile.path).catch(() => null)) ?? "") : null;
        const tickets = [];
        for (const f of g.tickets.slice(0, MAX_TICKETS)) {
          const text = await this.read(f.path).catch(() => null);
          if (text != null) tickets.push(parseTicket(f.path, text, f.at));
        }
        tickets.sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0) || a.id.localeCompare(b.id));
        const at = Math.max(g.mapFile?.at ?? 0, tickets.reduce((m, t) => Math.max(m, t.mtime ?? 0), 0));
        efforts.push({ key: `${base}:${g.slug}`, dir: `${base}/${g.slug}`, slug: g.slug, map, tickets, files: g.files, at });
      }
    }
    return efforts.sort((a, b) => b.at - a.at);
  }

  choose(key) {
    this.chosen = key;
  }

  pin(dir) {
    this.pinned = dir;
  }

  // The first place that has slates, so a folder inside a repo and the repo itself both count.
  async collect(places) {
    for (const dir of places) {
      if (!dir) continue;
      const efforts = await this.scan(dir).catch(() => []);
      if (efforts.length) return { place: dir, efforts };
    }
    return null;
  }

  // Resolves true when what to show changed. Focus can move during a slow read, so that
  // read's answer is followed at once by one for where focus is now.
  async tick() {
    let changed = false;
    let seen = undefined;
    do {
      const folder = this.folder();
      seen = folder;
      // A slate can live in the folder itself (`prism-link/.scratch`), in a repo it sits
      // in, or anywhere above: the focus and its git root are asked first, then the last
      // place that had one, so a terminal sitting in /tmp still shows the slate in use.
      const root = folder ? await this.rootOf(folder) : null;
      const focus = root ?? folder ?? null;
      let shown = await this.collect([root, folder]);
      if (!shown) shown = await this.collect([this.pinned, this.home]);
      if (shown && shown.place !== this.pinned) this.pinned = null;
      if (shown) this.home = shown.place;
      const efforts = shown ? shown.efforts : [];
      const kind = !folder ? "none" : !efforts.length ? "noeffort" : "efforts";
      // The slate the folder sits in wins; else a pick by hand; else the freshest.
      const holds = (e) => Boolean(folder) && (folder === e.dir || folder.startsWith(`${e.dir}/`));
      const effort = kind === "efforts"
        ? (efforts.find((e) => e.key === this.chosen) ?? efforts.filter(holds).sort((a, b) => b.dir.length - a.dir.length)[0] ?? efforts[0])
        : null;
      const board = effort ? buildBoard(effort) : null;
      const place = shown?.place ?? focus;
      if (place !== this.place) { this.place = place; this.chosen = null; }
      const state = {
        kind, repo: place, focus, away: shown && focus && shown.place !== focus ? focus : null, slug: effort?.slug ?? null,
        efforts: efforts.map((e) => ({ key: e.key, slug: e.slug, title: e.map?.title || e.slug, total: e.tickets.length, done: e.tickets.filter((t) => t.done).length, map: Boolean(e.map) })),
      };
      const sig = JSON.stringify({ state, board: board && { ...board, now: 0 } });
      this.at = place;
      if (sig === this.sig) break;
      Object.assign(this, { sig, state, board });
      changed = true;
    } while (this.folder() !== seen);
    return changed;
  }
}
