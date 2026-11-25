// The merge screen, for your own PRs: pick a merge method, press enter or m, then y to confirm.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { button, option } from "../ui.js";
import { spinner } from "../kit/controls.js";
import { paneHeader, paneTitle, paneDetail, paneBar, banner } from "../kit/pane.js";
import { SIZE } from "../kit/theme.js";

/** `v` is the Tourist view: its state is read here and its methods run on clicks. */
export function mergeView(v, t) {
  const m = v.merge, pr = v.pr, methods = m.methods ?? [];
  const header = paneHeader(t)
    .child(paneTitle(t, `合并 PR #${pr.number}`))
    .child(paneDetail(t, `${pr.head} 合入 ${pr.base}`))
    .child(v.shortcuts.button(t));
  const pick = i => (_e, cx) => { v.moveMethod(i); cx.notify(); };
  let body;
  if (m.phase === "loading" || m.phase === "merging") {
    body = v_flex().flex_1().items_center().justify_center().gap(8)
      .child(spinner(t).text_size(SIZE.h1))
      .child(div().child(m.phase === "loading" ? "正在读取仓库的合并设置…" : `正在合入 ${pr.base}…`));
  } else {
    const content = v_flex().gap(6).max_w(720)
      .when(Boolean(m.error), el => el.child(banner(t, m.error, t.ansi1)))
      .when(m.phase === "merged", el => el.child(banner(t, `已合入 ${pr.base}。${v.keyOf("open", "o") ? ` 按 ${v.keyOf("open", "o")} 打开 PR。` : ""}`, t.ansi2)))
      .when(m.phase === "picking", el => el
        .child(div().pb(4).text_size(SIZE.small).text_color(t.dim).child("如何合并（仅限此仓库允许的方式） · enter 合并"))
        .children(methods.map((x, i) => option(t, `merge-${x.id}`, x.key, x.label, x.hint, m.cursor === i, pick(i))))
        .child(div().pt(8).text_size(SIZE.small).text_color(t.dim)
          .child(`仅当 PR 的 head 仍是你评审过的那个提交时才合并。GitHub 自身的规则（检查、评审、冲突）仍然生效。`)));
    body = v_flex().id("merge-body").flex_1().min_h(0).overflow_y_scrollbar().px(14).py(12).child(content);
  }
  const method = methods[m.cursor];
  const bar = paneBar(t)
    .child(button(t, "merge-back", "返回导览", "b", m.phase !== "merging", (_e, cx) => { v.closeMerge(); cx.notify(); }))
    .when(m.phase === "merged", el => el.child(button(t, "merge-open", "在 GitHub 上打开", v.keyOf("open", "o"), true, (_e, cx) => { v.openPR(); cx.notify(); })))
    .when(m.phase === "picking", el => el.child(button(t, "merge-go",
      method?.label ?? "合并",
      v.keyOf("merge", "m"), Boolean(method), (_e, cx) => { v.doMerge(cx); cx.notify(); })));
  return v_flex().flex_1().min_h(0).child(header).child(body)
    // The bar of key buttons is a key hint: it goes when key hints are hidden. The keys still work.
    .when(v.shortcuts.showHints, el => el.child(bar));
}
