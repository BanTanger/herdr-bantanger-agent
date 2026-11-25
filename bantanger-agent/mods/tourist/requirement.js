// Tours that start from a requirement instead of a branch: which projects the requirement
// touches (Beetle), and what each of their one branch changed against master (local git).
// The settings file names the folders the projects are cloned into.
import { appHome, exec, home, readTextFile } from "herdr";
import { git } from "./git.js";

/** The app's settings file, where this mod keeps its own section: `{ tourist: { roots, fetch } }`. */
const settingsFile = () => `${appHome()}/settings.json`;
const mineFile = () => `${home()}/.local/state/prism-link/mine.json`;
const prismCli = () => `${home()}/.local/bin/prism-link`;
const branchesScript = () => `${appHome()}/mods/tourist/branches.mjs`;

/** Commits that are bookkeeping, not the reader's work: Beetle's auto-merge and its bot account. */
const BOT_AUTHORS = new Set(["zzscm"]);
const BOT_SUBJECT = /^auto[ -]?merge\b|^Merge (remote-tracking )?branch '[^']*' into /i;

/**
 * This mod's settings, with the defaults when the file or the section is missing.
 * `roots` is where the projects are cloned, in order; a project's folder is its name under one of them.
 * @returns {Promise<{ roots: string[], fetch: "manual" | "open" }>}
 */
export async function loadSettings() {
  let section = {};
  try { section = JSON.parse((await readTextFile(settingsFile())) ?? "{}")?.tourist ?? {}; } catch { section = {}; }
  const roots = Array.isArray(section.roots) && section.roots.length
    ? section.roots.map(r => String(r).trim()).filter(Boolean)
    : ["~/hdProject"];
  const fetch = section.fetch === "open" ? "open" : "manual";
  return { roots, fetch };
}

/** A path with `~` written out, in the forward-slash form git and exec take. */
export function expandPath(path, userHome = home()) {
  const p = String(path).replace(/\\/g, "/");
  if (p === "~" || p.startsWith("~/")) return `${String(userHome).replace(/\\/g, "/").replace(/\/+$/, "")}${p.slice(1)}`;
  return p;
}

/**
 * The local folder of a project, or null when it isn't cloned under any of the roots.
 * The folder is the project's name, which is what Beetle calls each service.
 * @param {string} engine @param {string[]} roots @param {string | null} on
 */
export async function findRepo(engine, roots, on) {
  for (const raw of roots) {
    const dir = `${expandPath(raw).replace(/\/+$/, "")}/${engine}`;
    const top = await git(["rev-parse", "--show-toplevel"], { cwd: dir, on });
    if (top) return { dir: top, root: dir };
  }
  return null;
}

/** The cached list of my requirements (`prism-link mine`'s own cache), for an instant picker. */
export async function readMine() {
  try {
    const data = JSON.parse((await readTextFile(mineFile())) ?? "null");
    const items = Array.isArray(data?.items) ? data.items : [];
    return { items, fetchedAt: data?.fetchedAt ?? null, stale: Boolean(data?.stale), error: items.length ? null : "还没有拉取过需求列表" };
  } catch (e) { return { items: [], fetchedAt: null, stale: false, error: String(e?.message ?? e) }; }
}

/** Asks prism-link for a fresh list (it writes the cache the picker reads). Throws its own message. */
export async function refreshMine(on) {
  let r;
  try { r = await exec("env", [prismCli(), "mine", "--refresh"], { timeout: 25000, on }); }
  catch { throw new Error("无法运行 prism-link mine。"); }
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "prism-link mine 执行失败。").trim().slice(-400));
  const data = JSON.parse(r.stdout);
  return Array.isArray(data?.items) ? { items: data.items, fetchedAt: data.fetchedAt ?? null, stale: Boolean(data.stale) } : { items: [], fetchedAt: null, stale: false };
}

/**
 * The projects a requirement touches and each one's branch, from Beetle. Throws its own message:
 * the picker's failure is the tour's failure, there is nothing to show without it.
 * @param {string} id
 */
export async function loadBranches(id, on) {
  let r;
  try { r = await exec("node", [branchesScript(), String(id)], { timeout: 20000, on }); }
  catch { throw new Error("无法运行 node，读需求分支需要它。"); }
  let data;
  try { data = JSON.parse(r.stdout); } catch { throw new Error((r.stderr || r.stdout || "读需求分支失败。").trim().slice(-400)); }
  if (!data?.ok) throw new Error(String(data?.error ?? "读需求分支失败。"));
  return Array.isArray(data.branches) ? data.branches : [];
}

/** "今天", "昨天", "3 天前", else the date. */
export function agoLabel(date) {
  const at = Date.parse(`${date}T00:00:00`);
  if (!Number.isFinite(at)) return date ?? "";
  const days = Math.round((Date.now() - at) / 86400000);
  return days <= 0 ? "今天" : days === 1 ? "昨天" : days < 30 ? `${days} 天前` : date;
}

/** The local ref for a project's branch, with origin's first so git has the pushed history. */
async function branchRef(dir, branch, on) {
  return (await git(["rev-parse", "--verify", "--quiet", `origin/${branch}`], { cwd: dir, on }))
    ?? (await git(["rev-parse", "--verify", "--quiet", branch], { cwd: dir, on }));
}

/** "1 file changed, 12 insertions(+), 3 deletions(−)" → { files, add, del }. */
export function parseShortstat(text) {
  const n = (re) => Number(re.exec(text ?? "")?.[1] ?? 0);
  return {
    files: n(/(\d+) files? changed/),
    add: n(/(\d+) insertions?\(\+\)/),
    del: n(/(\d+) deletions?\(-\)/),
  };
}

/**
 * The commits on a branch since it left its base, newest first, with the bookkeeping ones
 * counted apart. Each: { sha, date, author, subject }.
 */
export function parseLog(out) {
  const commits = [], robots = [];
  for (const line of (out ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [sha, date, author, ...subject] = line.split("\u001f");
    if (!sha) continue;
    const c = { sha, date, author: author ?? "", subject: subject.join("\u001f") ?? "" };
    (BOT_AUTHORS.has(c.author.toLowerCase()) || BOT_SUBJECT.test(c.subject) ? robots : commits).push(c);
  }
  return { commits, robots: robots.length };
}

/**
 * One requirement: its projects, each project's branch, the commits on it and the change
 * against the base branch. A project that isn't cloned here keeps its branch and state, and
 * says so instead of failing the whole list.
 * @param {{ id: string, title: string, status: string }} item
 * @param {{ roots: string[], fetch: "manual" | "open" }} settings
 * @param {string | null} on
 */
export async function loadRequirement(item, settings, on) {
  const branches = await loadBranches(item.id, on);
  const projects = await Promise.all(branches.map(async (b) => {
    const found = await findRepo(b.engine, settings.roots, on);
    const project = { ...b, dir: found?.dir ?? null, base: b.parent || "master", head: "", commits: [], robots: 0, local: null, files: [], stats: { files: 0, add: 0, del: 0 }, error: null };
    if (!found) return project;
    project.local = "ok";
    if (settings.fetch === "open") await git(["fetch", "--prune", "origin", b.branch], { cwd: found.dir, on }).catch(() => null);
    const ref = await branchRef(found.dir, b.branch, on);
    if (!ref) { project.error = `本地没有 ${b.branch}，推送后按 r 刷新`; project.local = "missing-ref"; return project; }
    project.head = ref;
    const baseRef = (await git(["rev-parse", "--verify", "--quiet", `origin/${project.base}`], { cwd: found.dir, on })) ?? project.base;
    const [log, shortstat, files] = await Promise.all([
      git(["log", `--pretty=%h%x1f%ad%x1f%an%x1f%s`, "--date=short", `${baseRef}..${ref}`], { cwd: found.dir, on }),
      git(["diff", "--shortstat", `${baseRef}...${ref}`], { cwd: found.dir, on }),
      git(["diff", "--name-only", `${baseRef}...${ref}`], { cwd: found.dir, on }),
    ]);
    Object.assign(project, parseLog(log), { stats: parseShortstat(shortstat) });
    project.files = (files ?? "").split(/\r?\n/).filter(Boolean);
    project.baseRef = baseRef;
    // Beetle's head is what the platform built; a local ref behind it means the list is stale.
    project.behind = Boolean(b.head && ref && !ref.startsWith(b.head));
    return project;
  }));
  return { id: String(item.id), title: item.title ?? "", status: item.status ?? "", url: item.url ?? "", projects };
}

/** The commits a project's branch adds, as one list for the tour's prompt. */
export function commitsText(project) {
  return project.commits.map(c => `- ${c.sha} ${c.date} ${c.subject}`).join("\n") || "（没有提交）";
}

/** One commit's diff, rows-ready. Null when git can't produce it. */
export function commitDiff(dir, sha, on) {
  return git(["show", "--no-color", "--format=", "--unified=3", sha], { cwd: dir, on });
}

/** One file's change on a project's branch against its base, rows-ready. */
export function branchFileDiff(dir, base, head, file, on) {
  return git(["diff", "--no-color", "--unified=3", `${base}...${head}`, "--", file], { cwd: dir, on });
}
