// node --test title.test.mjs  (from this folder)
import { test } from "node:test";
import assert from "node:assert/strict";
import { liveTitle } from "./title.js";

const claude = { name: "Claude Code", key: "claude" };

test("the agent's own title, without Claude's status glyphs", () => {
  assert.equal(liveTitle("review release", claude), "review release");
  assert.equal(liveTitle("✳ review release", claude), "review release");
  assert.equal(liveTitle("⠂ Fix login", claude), "Fix login");
});

const omp = { name: "omp", key: "omp" };
test("omp's π brand and state separator are dropped, so the rail reads the tab bar's name", () => {
  assert.equal(liveTitle("π ⠏ 支付回调超时排查", omp), "支付回调超时排查");
  assert.equal(liveTitle("π > 支付回调超时排查", omp), "支付回调超时排查");
  assert.equal(liveTitle("π ! 支付回调超时排查", omp), "支付回调超时排查");
  assert.equal(liveTitle("π: 支付回调超时排查", omp), "支付回调超时排查");
  assert.equal(liveTitle("π ⠏ 🏷️ AGENTS: Fix agents tab name mismatch", omp), "AGENTS: Fix agents tab name mismatch");
});

test("a bare omp brand says nothing", () => {
  for (const t of ["π", "π >", "π ⠏ ", "π:"]) assert.equal(liveTitle(t, omp), null, String(t));
});

test("a path title doesn't count, even after the glyph strip would eat its ~ or /", () => {
  for (const t of ["~/src", "~", "/root/ai-workspace", "C:\\x"]) assert.equal(liveTitle(t, claude), null, t);
});

test("the program's own name, user@host and empty titles don't count", () => {
  for (const t of ["Claude Code", "claude", "root@vm: ~", "", "✳ ", undefined, null]) assert.equal(liveTitle(t, claude), null, String(t));
  assert.equal(liveTitle("anything", undefined), "anything");
});
