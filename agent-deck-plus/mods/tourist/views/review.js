// The post-review screen: your comments, the verdict, an optional summary, and a
// two-press post to GitHub.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { settings } from "herdr";
import { button, option } from "../ui.js";
import { spinner, textInput } from "../kit/controls.js";
import { paneHeader, paneTitle, paneDetail, paneBar, banner, sectionLabel } from "../kit/pane.js";
import { SIZE } from "../kit/theme.js";
import { eventsFor, DEFAULT_SUMMARY } from "../review.js";
import { linesOf } from "../comments.js";

/** `v` is the Tourist view: its state is read here and its methods run on clicks. */
export function reviewView(v, t) {
  const r = v.review, pr = v.pr, events = eventsFor(pr);
  const section = (title) => sectionLabel(t, title);
  const header = paneHeader(t)
    .child(paneTitle(t, `在 PR #${pr.number} 上发布评审`))
    .child(paneDetail(t, `作者 ${pr.author} · 以 ${pr.me || "gh 账号"} 身份发布 · ${v.comments.length} 条评论`))
    .child(v.shortcuts.button(t));
  const comments = v.comments.map(c => v_flex().gap(2).px(10).py(6).rounded(7).bg(t.raised)
    .child(div().text_size(SIZE.small).text_color(t.accent).font_family(settings().font_family).truncate()
      .child(`${c.file}:${linesOf(c)}${c.startLine === undefined && c.side === "old" ? " (已删除的行)" : ""}`))
    .child(div().text_size(SIZE.text).child(c.text)));
  // The key named for posting. With p turned off, enter still posts.
  const post = v.keyOf("review", "p") || "enter";
  const pick = (i) => (_e, cx) => { v.leaveBox(); r.cursor = i; r.confirm = false; cx.notify(); };
  const content = v_flex().gap(6).max_w(720)
    .when(Boolean(r.error), el => el.child(banner(t, r.error, t.ansi1)))
    .when(r.phase === "posted", el => el.child(banner(t, `已发布到 GitHub。${v.keyOf("open", "o") ? ` 按 ${v.keyOf("open", "o")} 打开。` : ""} 评论已清空。`, t.ansi2)))
    .when(r.phase !== "posted", el => el
      .child(section(comments.length ? "你的评论，发布在所在的代码行上" : "没有行内评论。你可以批准，或写一段摘要来评论。"))
      .children(comments)
      .child(section(pr.mine ? `裁决（自己的 PR 只能评论） · ${post} 发布` : `裁决 · 选一个，然后按 ${post} 发布`))
      .children(events.map((e, i) => option(t, `event-${e.id}`, e.key, e.label, e.hint, r.cursor === i, pick(i))))
      .child(section(v.comments.length ? `摘要（可选，tab 输入；留空则发布“${DEFAULT_SUMMARY}”）` : "摘要（可选，tab 输入）"))
      .child(textInput(t, v.summaryInput, v.typing === "summary")));
  const body = r.phase === "posting"
    ? v_flex().flex_1().items_center().justify_center().gap(8).child(spinner(t).text_size(SIZE.h1)).child(div().child("正在发布评审…"))
    : v_flex().id("review-body").flex_1().min_h(0).overflow_y_scrollbar().px(14).py(12).child(content);
  const event = events[r.cursor] ?? events[0];
  const bar = paneBar(t)
    .child(button(t, "review-back", "返回导览", "b", r.phase !== "posting", (_e, cx) => { v.closeReview(); cx.notify(); }))
    .when(r.phase === "posted", el => el.child(button(t, "review-open", "在 GitHub 上打开", v.keyOf("open", "o"), true, (_e, cx) => { v.openReview(); cx.notify(); })))
    .when(r.phase !== "posted", el => el.child(button(t, "review-post",
      `以${event.label}发布`,
      v.keyOf("review", "p"), v.canPost(), (_e, cx) => { v.postReview(cx); cx.notify(); })));
  return v_flex().flex_1().min_h(0).child(header).child(body)
    // The bar of key buttons is a key hint: it goes when key hints are hidden. The keys still work.
    .when(v.shortcuts.showHints, el => el.child(bar));
}
