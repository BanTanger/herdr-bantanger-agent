#!/usr/bin/env node
// Narrows omp's `-p --mode json` stream to what agent.js reads.
//
// omp prints every event: token and thinking deltas (message_update), each tool call
// (tool_execution_start/update/end) and its result (message_start/end of role toolResult),
// the message twice (start and end), and the whole conversation again in agent_end. A tour
// of a large branch produces 1.7 MB that way, and herdr.readTextFile refuses anything over
// 1 MiB, so the call failed and the tour stopped.
//
// claude answers with one small JSON object and codex with a small session-id stream, so this
// does the same for omp: the session id, failures, and the assistant's text. ~50 KB.
//
//   node omp-events.mjs < 1795…-2.out.json > tour.jsonl
//
// Not needed by agent.js itself: it is one process on the pipe that already writes the file.
const out = (event) => process.stdout.write(JSON.stringify(event) + "\n");

/** An assistant message cut to the fields the tour reads: its text, and how the turn ended. */
function message(m) {
  const kept = { role: m.role, content: (m.content ?? []).filter((part) => part?.type === "text") };
  for (const key of ["stopReason", "errorMessage", "errorStatus", "error"]) {
    if (m[key] !== undefined && m[key] !== null) kept[key] = m[key];
  }
  return kept;
}

/** A failed turn, as turn_end and message_end both report it. */
function failed(m) {
  return Boolean(m && (m.stopReason === "error" || m.errorMessage || m.errorStatus || m.error));
}

function line(raw) {
  const text = raw.replace(/^\uFEFF/, "").trim();
  if (!text) return;
  let event;
  try { event = JSON.parse(text); } catch { return; } // a torn last line when the agent was killed
  if (event.type === "session" || event.type === "error") return out(event);
  if (event.type === "message_end" && event.message?.role === "assistant") {
    return out({ type: "message_end", message: message(event.message) });
  }
  if (event.type === "turn_end" && failed(event.message)) {
    return out({ type: "turn_end", message: message(event.message) });
  }
  if (event.type === "agent_end" && Array.isArray(event.messages)) {
    const last = [...event.messages].reverse().find((m) => m?.role === "assistant");
    if (last) out({ type: "agent_end", messages: [message(last)] });
    return;
  }
  // Everything else is thinking, deltas, tool traffic or a repeat: dropped.
}

let rest = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  rest += chunk;
  let nl;
  while ((nl = rest.indexOf("\n")) >= 0) {
    line(rest.slice(0, nl));
    rest = rest.slice(nl + 1);
  }
});
process.stdin.on("end", () => {
  if (rest) line(rest);
});
