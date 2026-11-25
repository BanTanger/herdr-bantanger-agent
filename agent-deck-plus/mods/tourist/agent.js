// Finding the installed agent CLIs and talking to one of them.
import { exec, hc, readTextFile, writeTextFile, appHome, window } from "herdr";
import * as fs from "fs/promises";
import { AGENTS, TOOLS, FIX_TOOLS, OMP_TOOLS, OMP_FIX_TOOLS } from "./constants.js";

let jobs = 0; // numbers each call's temp files

export function agentName(id) { return AGENTS.find(a => a.id === id)?.name ?? "该 agent"; }

const PS_ARGS = ["-NoLogo", "-NoProfile", "-Command"]; // -NoProfile: a user profile can take seconds to load
let psExe = null; // "pwsh" or "powershell.exe" once one has run; asked once per load of the mod
// Herdr's PATH on Windows can miss the folders the claude and codex installers use.
const PS_PATH = `$env:Path = "$env:USERPROFILE\\.local\\bin;$env:APPDATA\\npm;$env:Path"; `;

/**
 * Runs a PowerShell script, preferring PowerShell 7 (pwsh) and falling back to Windows
 * PowerShell. The first call finds out which exists, so later calls start only one process.
 */
async function runPs(script, on) {
  for (const exe of psExe ? [psExe] : ["pwsh", "powershell.exe"]) {
    let r;
    try { r = await exec(exe, [...PS_ARGS, script], { on }); } catch { continue; }
    psExe = exe;
    return r;
  }
  throw new Error("Tourist 需要 PowerShell（pwsh 或 powershell.exe）。");
}

/** The shell that runs an agent job: [argv..., script]. */
export async function shell() {
  if (window()?.platform !== "windows") return { argv: ["sh", "-c"], ps: false };
  if (!psExe) await runPs("exit 0");
  return { argv: [psExe, ...PS_ARGS], ps: true };
}

/** The installed agent ids, and the one to use: the last one picked, else the first found. */
export async function findAgents(on) {
  // One lookup for every agent, in the same shell the jobs run in, so PATH matches.
  const ids = AGENTS.map(a => a.id);
  const r = window()?.platform === "windows"
    ? await runPs(`${PS_PATH}Get-Command ${ids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }`, on).catch(() => null)
    : await exec("sh", ["-c", `for a in ${ids.join(" ")}; do command -v "$a" >/dev/null 2>&1 && echo "$a"; done`], { on }).catch(() => null);
  // Windows names come back with an extension (claude.exe, codex.cmd).
  const names = (r?.stdout ?? "").split(/\r?\n/).map(n => n.trim().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, ""));
  const agents = ids.filter(id => names.includes(id));
  let saved = null;
  try { saved = localStorage.getItem("agent"); } catch {}
  return { agents, agent: agents.includes(saved) ? saved : agents[0] ?? null };
}

/** Remembers the picked agent for the next time Tourist opens. */
export function rememberAgent(id) { try { localStorage.setItem("agent", id); } catch {} }

/** The omp model last picked: a `provider/model[:level]` selector, or null for omp's own default. */
export function savedModel() { try { return localStorage.getItem("model") || null; } catch { return null; } }

/** Remembers the omp model for the next time Tourist opens. `null` goes back to omp's default. */
export function rememberModel(selector) { try { selector ? localStorage.setItem("model", selector) : localStorage.removeItem("model"); } catch {} }

/** The text blocks of an omp message, without its thinking. @param {any} message */
function ompText(message) {
  return (message?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join("");
}

/**
 * One conversation with Claude or Codex in a folder. Each `ask` after the first
 * resumes the same session, so the agent keeps what it already read. Read-only
 * unless `write` is set, which lets it edit files in `cwd` (a fix's worktree).
 */
export class AgentSession {
  constructor(agent, cwd, { write = false, model = null } = {}) { this.agent = agent; this.cwd = cwd; this.write = write; this.model = model; this.id = null; this.job = null; }

  /** Stops the call in progress, if any. */
  async stop() {
    const job = this.job;
    this.job = null;
    if (job) await hc(["kill", job]).catch(() => {});
  }

  /**
   * exec stops anything over 30 s, so the agent runs as a hidden herdr-core terminal
   * that reads the prompt from a file and writes its reply to another.
   * Claude: `claude -p`, one JSON reply. Codex: `codex exec` in its sandbox (read-only,
   * or workspace-write for a fix), JSONL events on stdout (the session id) and its last
   * message in a file. omp: `omp -p --mode json`, whose raw stream carries every token delta
   * and tool result (megabytes); omp-events.mjs on the pipe cuts it to the session id, the
   * failures and the assistant's text before the file is read back.
   */
  async ask(prompt) {
    const sandbox = this.write ? "workspace-write" : "read-only";
    const agent = this.agent, name = agentName(agent);
    const dir = `${appHome()}/data/tourist`.replace(/\\/g, "/");
    await fs.mkdir(dir, { recursive: true });
    const id = `${Date.now()}-${++jobs}`;
    const inFile = `${dir}/${id}.in.txt`, outFile = `${dir}/${id}.out.json`, errFile = `${dir}/${id}.err.txt`, lastFile = `${dir}/${id}.last.txt`;
    await writeTextFile(inFile, prompt, null);
    const flags = agent === "codex"
      ? ["exec", ...(this.id ? ["resume", this.id, "-c", `sandbox_mode="${sandbox}"`] : ["--sandbox", sandbox]), "--json", "-o", lastFile, "-"]
      : agent === "omp"
      ? ["-p", "--mode", "json", ...(this.model ? ["--model", this.model] : []), ...(this.id ? ["-r", this.id] : []), ...(this.write ? OMP_FIX_TOOLS : OMP_TOOLS)]
      : ["-p", "--output-format", "json", ...(this.id ? ["--resume", this.id] : []), ...(this.write ? FIX_TOOLS : TOOLS)];
    const { argv, ps } = await shell();
    const q = ps ? (s => `'${s.replace(/'/g, "''")}'`) : (s => `'${s.replace(/'/g, `'\\''`)}'`);
    // omp prints megabytes of deltas and tool traffic; claude and codex answer small. Only omp
    // gets a process on its pipe that narrows the stream (omp-events.mjs) before it is read back.
    const filter = agent === "omp" ? `node ${q(`${appHome().replace(/\\/g, "/")}/mods/tourist/omp-events.mjs`)}` : null;
    const script = ps
      ? `${PS_PATH}$OutputEncoding =[Console]::InputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); Get-Content -Raw -Encoding utf8 -LiteralPath ${q(inFile)} | ${agent} ${flags.map(q).join(" ")} 2> ${q(errFile)}${filter ? ` | ${filter} 2>> ${q(errFile)}` : ""} | Set-Content -NoNewline -Encoding utf8 -LiteralPath ${q(outFile)}`
      : filter
      ? `${agent} ${flags.map(q).join(" ")} < ${q(inFile)} 2> ${q(errFile)} | ${filter} 2>> ${q(errFile)} > ${q(outFile)}`
      : `${agent} ${flags.map(q).join(" ")} < ${q(inFile)} > ${q(outFile)} 2> ${q(errFile)}`;
    const started = await hc(["run", "--bg", "--no-parent", "--outlive-parent", "--cwd", this.cwd ?? "", "--json", "--", ...argv, script]);
    if (started.code !== 0) throw new Error(started.stderr || `${agent} 启动失败。`);
    const address = JSON.parse(started.stdout).address;
    this.job = address;
    try {
      for (;;) {
        const w = await hc(["wait", address, "--timeout", "20", "--json"]);
        if (w.code !== 0 || JSON.parse(w.stdout).ended) break;
      }
    } finally {
      this.job = null;
      await hc(["rm", address]).catch(() => {});
    }
    let text = "", err = "", last = "";
    try {
      text = ((await readTextFile(outFile)) ?? "").replace(/^﻿/, "");
      err = (await readTextFile(errFile)) ?? "";
      last = agent === "codex" ? ((await readTextFile(lastFile).catch(() => null)) ?? "").replace(/^﻿/, "") : "";
    } finally {
      // Deleted even when a read throws: a failed call used to leave its files on disk for good.
      for (const f of [inFile, outFile, errFile, lastFile]) await fs.unlink(f).catch(() => {});
    }
    if (agent === "omp") {
      // JSONL events: the session id comes from `session`, the reply from the last assistant
      // message, and a failed turn from its `stopReason`, `error` event or `errorStatus`.
      let failure = null, reply = "";
      const turnFailure = (/** @type {any} */ message) => {
        if (!message || message.stopReason !== "error") return null;
        const detail = message.errorMessage ?? message.error?.message;
        const status = message.errorStatus ? `（HTTP ${message.errorStatus}）` : "";
        return `${detail || "请求失败"}${status}${this.model ? ` · 模型 ${this.model}，按 m 换一个` : ""}`;
      };
      for (const line of text.split(/\r?\n/)) {
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === "session" && ev.id) this.id = ev.id;
        else if (ev.type === "error") failure = ev.message ?? ev.error?.message ?? failure;
        else if (ev.type === "turn_end") failure = turnFailure(ev.message) ?? failure;
        else if (ev.type === "message_end" && ev.message?.role === "assistant") {
          failure = turnFailure(ev.message) ?? failure;
          reply = ompText(ev.message) || reply;
        } else if (ev.type === "agent_end" && Array.isArray(ev.messages)) {
          const last = [...ev.messages].reverse().find((m) => m.role === "assistant");
          failure = turnFailure(last) ?? failure;
          if (last && ompText(last)) reply = ompText(last);
        }
      }
      if (failure || !reply.trim()) throw new Error(String(failure || err || `${name} 没有返回内容。`).trim().slice(-600));
      return reply;
    }
    if (agent === "codex") {
      let failure = null;
      for (const line of text.split(/\r?\n/)) {
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === "thread.started" && ev.thread_id) this.id = ev.thread_id;
        if (ev.type === "turn.failed" || ev.type === "error") failure = ev.error?.message ?? ev.message ?? failure;
      }
      if (failure || !last.trim()) throw new Error(String(failure || err || text || `${name} 没有返回内容。`).trim().slice(-600));
      return last;
    }
    let out;
    try { out = JSON.parse(text); }
    catch { throw new Error((err || text || `${name} 没有返回内容。`).trim().slice(-600)); }
    if (out.session_id) this.id = out.session_id;
    if (out.is_error) throw new Error(String(out.result || `${name} 报了错误。`));
    return String(out.result ?? "");
  }
}
