// node --test name.test.mjs  (from this folder)
import { test } from "node:test";
import assert from "node:assert/strict";
import { tabName } from "./name.js";

const claude = { name: "Claude Code", key: "claude", agent: true };
const lead = (title, program = claude) => ({ title, program });

test("a tab named after its program shows the session's title", () => {
  assert.equal(tabName({ name: "Claude Code", named: true }, lead("Herdr layout")), "Herdr layout");
});

test("an unnamed tab shows the session's title", () => {
  assert.equal(tabName({ name: "2", named: false }, lead("Fix login")), "Fix login");
});

test("Claude's status glyphs before the title are dropped", () => {
  assert.equal(tabName({ name: "Claude Code", named: true }, lead("✳ Herdr layout")), "Herdr layout");
  assert.equal(tabName({ name: "Claude Code", named: true }, lead("⠂ Herdr layout")), "Herdr layout");
});

const omp = { name: "omp", key: "omp", agent: true };
test("omp's π brand and state separator are dropped like Claude's glyphs", () => {
  for (const t of ["π ⠏ 支付回调超时排查", "π > 支付回调超时排查", "π ! 支付回调超时排查", "π: 支付回调超时排查"]) {
    assert.equal(tabName({ name: "omp", named: true }, lead(t, omp)), "支付回调超时排查", t);
  }
  assert.equal(tabName({ name: "2", named: false }, lead("π ⠏ 支付回调超时排查", omp)), "支付回调超时排查");
});

test("a tab someone named something else keeps its name", () => {
  assert.equal(tabName({ name: "fix login", named: true }, lead("Herdr layout")), "fix login");
});

test("titles that only say the program, a path or user@host don't count", () => {
  for (const t of ["Claude Code", "claude", "~/src", "/root/ai-workspace", "C:\\x", "root@vm: ~", "", "✳ ", undefined]) {
    assert.equal(tabName({ name: "Claude Code", named: true }, lead(t)), "Claude Code", String(t));
  }
});

test("no pane, or an old tbN name, falls back as before", () => {
  assert.equal(tabName({ name: "Claude Code", named: true }, undefined), "Claude Code");
  assert.equal(tabName({ name: "tb3", named: false }, lead("")), "Claude Code");
  assert.equal(tabName({ name: "tb3", named: false }, undefined), "Terminal");
  assert.equal(tabName({ name: "3", named: false }, lead("/root")), "3");
});
