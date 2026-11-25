#!/usr/bin/env node
// A requirement's project branches, straight from Beetle's open API: one GET, no login.
//
//   node branches.mjs <需求号>
//
// Prints one JSON line: { ok, count, branches: [{ engine, branch, parent, state, head, at }] }
// or { ok: false, error }. `engine` is the project's name in that service, which is also its
// folder name under the roots in settings. A requirement has one branch per project; a closed
// branch is a leftover from a re-created one, so the live branch wins.
//
// The service is yours to name:
//   TOURIST_BEETLE_HOST=https://your-branch-service
// It must answer `<host>/apiBeetle/openapi/getBranchsByTapdIds?tapdIds=<id>` with
// `{ respData: [{ clusterName, name, parentName, stateName, commitId, createtime }] }`.
// Unset, the requirement scope says so instead of calling a guessed host.
const HOST = String(process.env.TOURIST_BEETLE_HOST ?? "").trim().replace(/\/+$/, "");
const id = String(process.argv[2] ?? "").trim();
if (!HOST) {
  console.log(JSON.stringify({ ok: false, error: "未设置 TOURIST_BEETLE_HOST：需求分支服务未配置" }));
  process.exit(2);
}
if (!/^\d+$/.test(id)) {
  console.log(JSON.stringify({ ok: false, error: "需要一个数字需求号" }));
  process.exit(2);
}
const stop = new AbortController();
const timer = setTimeout(() => stop.abort(), 12000);
try {
  const res = await fetch(`${HOST}/apiBeetle/openapi/getBranchsByTapdIds?tapdIds=${id}`, { signal: stop.signal });
  const data = await res.json();
  const rows = Array.isArray(data?.respData) ? data.respData : [];
  const byEngine = new Map();
  for (const row of rows) {
    const engine = String(row?.clusterName ?? "").trim();
    const branch = String(row?.name ?? "").trim();
    if (!engine || !branch) continue;
    const item = {
      engine, branch,
      parent: String(row?.parentName ?? "master").trim() || "master",
      state: String(row?.stateName ?? "").trim(),
      head: String(row?.commitId ?? "").trim(),
      at: String(row?.createtime ?? "").trim(),
    };
    const old = byEngine.get(engine);
    // One branch per project: keep the live one over a closed leftover, else the newest.
    if (!old || (old.state === "已关闭" && item.state !== "已关闭")
      || (old.state === item.state && item.at > old.at)) byEngine.set(engine, item);
  }
  console.log(JSON.stringify({ ok: true, count: byEngine.size, branches: [...byEngine.values()] }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
  process.exit(1);
} finally {
  clearTimeout(timer);
}
