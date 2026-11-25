// A PR's CI checks through gh, and the log of a failed GitHub Actions job for the agent to read.
import { execGh } from "./pr.js";

const FIELDS = "name,workflow,state,bucket,link,description";
// bucket from gh: pass, fail, pending, skipping or cancel. Failures sort first.
const ORDER = { fail: 0, cancel: 1, pending: 2, pass: 3, skipping: 4 };

/**
 * The PR's checks: `[{ name, workflow, state, bucket, link, description }]`, failures first.
 * Empty when the PR has no checks. gh exits 8 while checks are pending, and that output is fine.
 */
export async function listChecks(root, on, pr) {
  let r;
  try { r = await execGh(["pr", "checks", String(pr.number), "-R", pr.repo, "--json", FIELDS], { cwd: root, on }); }
  catch { throw new Error("检查需要 PATH 上有 GitHub CLI（gh）。"); }
  const text = (r.stderr || r.stdout || "").trim();
  if (/no checks reported/i.test(text)) return [];
  if (r.code !== 0 && r.code !== 8) throw new Error(text.slice(-400) || "gh pr checks 执行失败。");
  const list = JSON.parse(r.stdout || "[]");
  return list.sort((a, b) => (ORDER[a.bucket] ?? 9) - (ORDER[b.bucket] ?? 9) || a.name.localeCompare(b.name));
}

/** `{ fail, pending, pass, total }` counts for the header badge. Skipped checks don't count. */
export function checkCounts(list) {
  const n = b => list.filter(c => c.bucket === b).length;
  return { fail: n("fail") + n("cancel"), pending: n("pending"), pass: n("pass"), total: list.filter(c => c.bucket !== "skipping").length };
}

/** The run and job ids in a GitHub Actions job link, or null for checks from other services. */
export function actionsJob(link) {
  const m = /\/actions\/runs\/(\d+)\/job\/(\d+)/.exec(String(link ?? ""));
  return m ? { run: m[1], job: m[2] } : null;
}

const MAX_LINES = 250, MAX_CHARS = 20000;

/**
 * The end of a failed job's log, up to its last `##[error]` line (what follows is cleanup).
 * Each line loses gh's job and step columns and its timestamp.
 */
export async function failedLog(root, on, pr, check) {
  const job = actionsJob(check.link);
  if (!job) throw new Error(`${check.name} 不在 GitHub Actions 上运行，这里读不到它的日志。按 o 打开。`);
  let r;
  try { r = await execGh(["run", "view", job.run, "--job", job.job, "--log-failed", "-R", pr.repo], { cwd: root, on }); }
  catch { throw new Error("读取日志需要 PATH 上有 GitHub CLI（gh）。"); }
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "gh run view 执行失败。").trim().slice(-400));
  let lines = r.stdout.replace(/\r/g, "").split("\n")
    .map(l => l.split("\t").slice(2).join("\t").replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, ""));
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].startsWith("##[error]")) last--;
  if (last >= 0) lines = lines.slice(0, last + 1);
  const text = lines.slice(-MAX_LINES).join("\n");
  if (!text.trim()) throw new Error(`GitHub 没有返回 ${check.name} 的失败日志。`);
  return text.slice(-MAX_CHARS);
}
