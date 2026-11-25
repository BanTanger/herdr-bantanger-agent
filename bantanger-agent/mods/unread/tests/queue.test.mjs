import test from "node:test";
import assert from "node:assert/strict";

import {
  QUEUE_MAX, ago, extensionOf, groups, markAllRead, progressFor, requestFile, rowMeta,
  shortName, splitQueue,
} from "../queue.js";

test("splitQueue folds objects, strings and duplicates into one list", () => {
  const raw = JSON.stringify([
    { file: "/a.md", at: 1 },
    "/b.md",
    { file: "/a.md", at: 9 },
    { nope: true },
    { file: "" },
    "/b.md",
  ]);
  assert.deepEqual(splitQueue(raw), [
    { file: "/a.md", at: 1 },
    { file: "/b.md", at: 0 },
  ]);
});

test("splitQueue survives an unreadable or missing queue", () => {
  assert.deepEqual(splitQueue(null), []);
  assert.deepEqual(splitQueue(""), []);
  assert.deepEqual(splitQueue("{not json"), []);
  assert.deepEqual(splitQueue({ files: [{ file: "/c.md", at: 3 }] }), [{ file: "/c.md", at: 3 }]);
});

test("splitQueue keeps the newest QUEUE_MAX entries", () => {
  const raw = Array.from({ length: QUEUE_MAX + 3 }, (_, i) => ({ file: `/f${i}.md`, at: i }));
  const out = splitQueue(raw);
  assert.equal(out.length, QUEUE_MAX);
  assert.equal(out[0].file, "/f3.md");
  assert.equal(out.at(-1).file, `/f${QUEUE_MAX + 2}.md`);
});

test("requestFile names the file the preview tab shows", () => {
  assert.equal(requestFile('{"file":"/Users/me/video-notes/a.md"}'), "/Users/me/video-notes/a.md");
  assert.equal(requestFile(""), null);
  assert.equal(requestFile(null), null);
  assert.equal(requestFile("{bad"), null);
  assert.equal(requestFile('{"file":""}'), null);
});

test("progressFor defaults an unopened file to unread at the top", () => {
  assert.deepEqual(progressFor({}, "/x.md"), { opened: false, ratio: 0, line: null, snippet: "", at: 0 });
  assert.deepEqual(progressFor({ "/x.md": { opened: true, ratio: 0.62, line: 41, snippet: "- 断言", at: 7 } }, "/x.md"),
    { opened: true, ratio: 0.62, line: 41, snippet: "- 断言", at: 7 });
  assert.equal(progressFor({ "/x.md": { ratio: 4 } }, "/x.md").ratio, 1, "a ratio past the end clamps");
  assert.equal(progressFor({ "/x.md": { ratio: -1 } }, "/x.md").ratio, 0);
  assert.equal(progressFor({ "/x.md": { line: "41" } }, "/x.md").line, 41);
});

test("groups splits unread from read, most recently read first", () => {
  const files = [{ file: "/a.md" }, { file: "/b.md" }, { file: "/c.md" }];
  const store = { "/a.md": { opened: true, at: 10 }, "/b.md": { opened: true, at: 20 } };
  const { unread, read } = groups(store, files);
  assert.deepEqual(unread.map((e) => e.file), ["/c.md"]);
  assert.deepEqual(read.map((e) => e.file), ["/b.md", "/a.md"]);
});

test("markAllRead reads every file but the open one", () => {
  const files = [{ file: "/a.md" }, { file: "/b.md" }, { file: "/c.md" }];
  const next = markAllRead({ "/a.md": { ratio: 0.3 } }, files, "/b.md", 5);
  assert.deepEqual(next["/a.md"], { ratio: 1, opened: true, at: 5 });
  assert.equal(next["/b.md"], undefined, "the open file keeps where the reader is");
  assert.deepEqual(next["/c.md"], { opened: true, ratio: 1, at: 5 });
});

test("rowMeta says where the reader stopped", () => {
  const now = 1_700_000_000_000;
  const store = { "/a.md": { opened: true, ratio: 0.62, line: 41, at: now - 5 * 60_000 } };
  assert.equal(rowMeta(store, "/a.md", now), "第 41 行 · 62% · 5 分钟前");
  assert.equal(rowMeta(store, "/b.md", now), "未读 · 点击开始");
  assert.equal(rowMeta({ "/a.md": { opened: true, ratio: 1, at: now - 10_000 } }, "/a.md", now), "第 1 行 · 100% · 刚刚");
});

test("ago names the gap in the panel's units", () => {
  const now = 1_700_000_000_000;
  assert.equal(ago(now, now - 10_000), "刚刚");
  assert.equal(ago(now, now - 5 * 60_000), "5 分钟前");
  assert.equal(ago(now, now - 3 * 3_600_000), "3 小时前");
  assert.equal(ago(now, now - 2 * 86_400_000), "2 天前");
  assert.equal(ago(now, 0), "");
});

test("names and extensions come off the path", () => {
  assert.equal(shortName("/Users/me/video-notes/lauren-tan-all-code-is-slop.md"), "lauren-tan-all-code-is-slop.md");
  assert.equal(shortName(`/tmp/${"x".repeat(50)}.md`).length, 39);
  assert.equal(extensionOf("/Users/me/a.MD"), "md");
  assert.equal(extensionOf("/Users/me/Makefile"), "");
});
