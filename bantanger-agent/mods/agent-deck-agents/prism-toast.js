// agent-deck: toast payloads for a prism-link event file.
// Only failures toast. "Unlinked" is a standing fact about one agent, so it lives on that agent's
// card (prism-prompt-view.js) instead of a floating notice shared by the whole window: a toast
// stacks in a corner for every session, outlives the session, and cannot say whose binding it is.
export function prismToastPayload(event) {
  const e = event || {};
  return {
    title: e.title || "prism-link 失败",
    body: `${e.branch || "unknown"} · ${e.reason || "未知原因"}`,
    level: e.level === "warning" ? "warning" : "error",
    timeout: 15000,
  };
}
