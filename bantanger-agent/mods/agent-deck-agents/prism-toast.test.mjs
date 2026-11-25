import assert from "node:assert/strict";
import test from "node:test";
import { prismToastPayload } from "./prism-toast.js";

test("a failure event is an error toast that times out", () => {
  const p = prismToastPayload({ branch: "feature-x", reason: "解析失败" });
  assert.equal(p.title, "prism-link 失败");
  assert.equal(p.level, "error");
  assert.equal(p.body, "feature-x · 解析失败");
  assert.equal(p.timeout, 15000);
  assert.equal(p.action, undefined);
});

test("an event that says warning stays a warning", () => {
  const p = prismToastPayload({ branch: "main", reason: "仓库状态不对", level: "warning" });
  assert.equal(p.level, "warning");
});

test("empty event falls back to placeholders", () => {
  const p = prismToastPayload(null);
  assert.equal(p.title, "prism-link 失败");
  assert.equal(p.body, "unknown · 未知原因");
  assert.equal(p.level, "error");
});
