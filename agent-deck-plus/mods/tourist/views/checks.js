// The checks screen (PR tours): the PR's CI checks, failures first. A failed GitHub Actions
// check can be explained: the agent reads the end of its log and says why it failed.
import { div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { button } from "../ui.js";
import { spinner } from "../kit/controls.js";
import { listRow, rowText, listNote } from "../kit/list.js";
import { paneHeader, paneTitle, paneDetail, paneBar, banner } from "../kit/pane.js";
import { SIZE } from "../kit/theme.js";
import { checkCounts, actionsJob } from "../checks.js";

const MARK = { pass: "✓", fail: "✗", cancel: "✗", pending: "●", skipping: "–" };

/** `v` is the Tourist view: its state is read here and its methods run on clicks. */
export function checksView(v, t) {
  const c = v.checks, pr = v.pr, list = c.list ?? [];
  const color = b => b === "pass" ? t.ansi2 : b === "fail" || b === "cancel" ? t.ansi1 : b === "pending" ? t.ansi3 : t.dim;
  const n = checkCounts(list);
  const header = paneHeader(t)
    .child(paneTitle(t, `PR #${pr.number} 的检查`))
    .child(paneDetail(t, c.list ? `${n.fail} 失败 · ${n.pending} 运行中 · ${n.pass} 通过 · ${pr.headOid.slice(0, 7)}` : ""))
    .when(c.loading, el => el.child(spinner(t)))
    .child(v.shortcuts.button(t));
  const cur = v.currentCheck();
  const rows = list.map((x, i) => {
    const on = c.cursor === i;
    return listRow(t, { id: `check-${i}`, on, tall: Boolean(x.description), click: cx => { c.cursor = i; cx.notify(); } })
      .child(div().w(14).flex_none().text_color(color(x.bucket)).child(MARK[x.bucket] ?? "?"))
      .child(rowText(t, x.workflow ? `${x.workflow} / ${x.name}` : x.name, x.description))
      .child(div().flex_none().text_size(SIZE.small).text_color(t.dim).child(i < 9 ? String(i + 1) : ""));
  });
  const failed = cur && (cur.check.bucket === "fail" || cur.check.bucket === "cancel");
  const notes = cur ? (c.notes[cur.key] ?? []).map((note, i) => v_flex().gap(4).pt(6).border_t_1().border_color(t.border)
    .child(div().text_size(SIZE.small).font_semibold().text_color(note.label === "Error" ? t.ansi1 : t.accent).child(note.label))
    .child(TextView.markdown(`check-note-${cur.key}-${i}`, note.text).selectable())) : [];
  const empty = text => listNote(t, text);
  const content = v_flex().gap(4).max_w(720)
    .when(Boolean(c.error), el => el.child(banner(t, c.error, t.ansi1)))
    .when(!c.list && !c.error, el => el.child(empty("正在加载检查…")))
    .when(Boolean(c.list) && list.length === 0, el => el.child(empty("此 PR 没有检查。")))
    .children(rows)
    .when(Boolean(failed) && notes.length === 0 && !v.busy, el => el.child(div().pt(8).text_size(SIZE.text).text_color(t.dim)
      .child(actionsJob(cur.check.link) ? `${v.keyOf("explain", "e") || "enter"} 询问失败原因：agent 会读取其日志末尾。` : `此检查不在 GitHub Actions 上运行。${v.keyOf("open", "o") ? ` 按 ${v.keyOf("open", "o")} 打开。` : ""}`)))
    .when(notes.length > 0, el => el.child(v_flex().pt(8).gap(10).children(notes)))
    .when(Boolean(v.busy), el => el.child(h_flex().pt(8).gap(8).items_center().text_color(t.dim)
      .child(spinner(t)).child(div().text_size(SIZE.text).child(`${v.busy}…`))));
  const body = v_flex().id("checks-body").flex_1().min_h(0).overflow_y_scrollbar().px(14).py(12).child(content);
  const bar = paneBar(t)
    .child(button(t, "checks-back", "返回导览", "b", true, (_e, cx) => { v.closeChecks(); cx.notify(); }))
    .child(button(t, "checks-explain", "失败原因", v.keyOf("explain", "e"), Boolean(failed) && !v.busy && Boolean(actionsJob(cur?.check.link)), (_e, cx) => { v.explainCheck(cx); cx.notify(); }))
    .child(button(t, "checks-open", "打开", v.keyOf("open", "o"), Boolean(cur?.check.link), (_e, cx) => { v.openCheck(); cx.notify(); }))
    .child(button(t, "checks-refresh", "刷新", v.keyOf("refresh", "r"), !c.loading, (_e, cx) => { v.loadChecks(cx); cx.notify(); }));
  return v_flex().flex_1().min_h(0).child(header).child(body)
    // The bar of key buttons is a key hint: it goes when key hints are hidden. The keys still work.
    .when(v.shortcuts.showHints, el => el.child(bar));
}
