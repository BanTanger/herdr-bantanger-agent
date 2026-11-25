// Merging your own PR from the end of a review. GitHub won't let you approve your own PR,
// so this is the step that finishes one.
import { gh } from "./pr.js";

const METHODS = [
  { id: "squash", setting: "allow_squash_merge", label: "压平并合并", hint: "在基础分支上得到一个提交" },
  { id: "merge", setting: "allow_merge_commit", label: "创建合并提交", hint: "保留每个提交，外加一个合并提交" },
  { id: "rebase", setting: "allow_rebase_merge", label: "变基并合并", hint: "把每个提交逐个重放到基础分支上" },
];

/** The merge methods the repo allows, in GitHub's order. Key 1 to 3 picks one. */
export async function mergeMethods(root, on, pr) {
  const out = await gh(["api", `repos/${pr.repo}`, "--jq", "{allow_squash_merge, allow_merge_commit, allow_rebase_merge}"], { cwd: root, on });
  const allowed = JSON.parse(out);
  const list = METHODS.filter(m => allowed[m.setting] !== false);
  if (list.length === 0) throw new Error(`${pr.repo} 没有允许的合并方式。`);
  return list.map((m, i) => ({ ...m, key: String(i + 1) }));
}

/**
 * Merges the PR with the picked method, only if its head is still the commit the tour
 * reviewed. Branch deletion is left to the repo's own setting, and nothing local is touched.
 * Throws GitHub's reason when the merge is blocked (checks, required reviews, conflicts).
 */
export async function mergePR(root, on, pr, method) {
  try { await gh(["pr", "merge", String(pr.number), "-R", pr.repo, `--${method}`, "--match-head-commit", pr.headOid], { cwd: root, on }); }
  catch (e) {
    // Someone pushed since the tour started: say so, rather than GitHub's terse refusal.
    if (/head branch was modified|match-head-commit|expected head sha/i.test(String(e?.message ?? e)))
      throw new Error(`PR 有比 ${pr.headOid.slice(0, 7)} 更新的提交，那是本次导览评审的提交。按 q 退出后重新打开 PR，先评审这些提交再合并。`);
    throw e;
  }
}
