// The git worktree a fix runs in: a second folder on the commit being reviewed, so the agent's
// edits never touch your own checkout. Pushing sends the fix to the branch it came from — a pull
// request's head, or a requirement branch.
import { appHome, exec } from "herdr";
import * as fs from "fs/promises";
import { git } from "./git.js";

/**
 * What a fix edits and where it pushes: `{ path, branch, sha, key, label }`.
 * `path` is the worktree folder, `branch` the branch on origin its commits go to, `sha` the
 * commit the worktree starts from, `key` the ref that keeps the pushed commit alive here.
 */
export function prFixTarget(root, pr) {
  const key = `pr-${pr.number}`;
  return { key, path: pathFor(root, key), branch: pr.head, sha: pr.headOid, label: `PR #${pr.number}` };
}

/** A requirement branch's target: one folder per branch at its current head. */
export function branchFixTarget(project, reqId) {
  const key = `req-${String(project.branch).replace(/[^A-Za-z0-9._-]+/g, "_")}`;
  return { key, path: pathFor(project.dir, key), branch: project.branch, sha: project.head, label: `${project.engine} · ${project.branch}`, engine: project.engine, req: reqId, dir: project.dir };
}

const pathFor = (root, key) => `${appHome()}/data/tourist/worktrees/${`${root}#${key}`.replace(/[^A-Za-z0-9._-]+/g, "_")}`.replace(/\\/g, "/");

/** The local branch the worktree uses. Its own name, so the reviewed branch can stay checked out elsewhere. */
export function fixBranch(target) { return `tourist/fix-${target.key}`; }

/** The worktree for this target, created on its commit. One left by an earlier fix is reused as it is. */
export async function openWorktree(root, on, target) {
  const list = (await git(["worktree", "list", "--porcelain"], { cwd: root, on })) ?? "";
  if (list.split("\n").some(l => l.toLowerCase() === `worktree ${target.path}`.toLowerCase())) return target.path;
  await fs.mkdir(target.path.replace(/\/[^/]+$/, ""), { recursive: true });
  const made = await git(["worktree", "add", "-B", fixBranch(target), target.path, target.sha], { cwd: root, on });
  if (made === null) throw new Error(`无法在 ${target.path} 创建工作树。`);
  return target.path;
}

/** Everything the fix changed against the commit it started from, new files included. */
export async function worktreeDiff(path, on) {
  await git(["add", "--intent-to-add", "--all"], { cwd: path, on });
  return (await git(["diff", "--no-color", "HEAD"], { cwd: path, on })) ?? "";
}

/**
 * Commits the fix in the worktree and pushes it to `target.branch` on origin. Returns the pushed
 * commit. `root` is the main checkout, whose `refs/tourist/<key>` moves to it so the commit
 * outlives the worktree.
 */
export async function pushFix(path, root, on, target, message) {
  const run = async (args, cwd = path) => {
    const r = await exec("git", args, { cwd, on });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || `git ${args[0]} 执行失败。`).trim().slice(-500));
    return r.stdout.trim();
  };
  await run(["add", "--all"]);
  await run(["commit", "-q", "-m", message]);
  await run(["push", "origin", `HEAD:refs/heads/${target.branch}`]);
  const head = await run(["rev-parse", "HEAD"]);
  await run(["update-ref", `refs/tourist/${target.key}`, head], root).catch(() => {});
  return head;
}

/** Deletes the worktree and its local branch. Unpushed edits in it are lost. */
export async function removeWorktree(root, on, target) {
  await git(["worktree", "remove", "--force", target.path], { cwd: root, on });
  await git(["branch", "-D", fixBranch(target)], { cwd: root, on });
}
