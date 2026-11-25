// The requirement screen: every project the requirement touches, its one branch and the commits
// on it, with the selected commit's diff beside them. Read-only: the tour (g) is where comments
// and fixes live, because that is where the agent explains what to change.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { settings } from "herdr";
import { button } from "../ui.js";
import { spinner } from "../kit/controls.js";
import { paneHeader, paneBar, paneTitle, paneDetail, tag, banner } from "../kit/pane.js";
import { SIZE } from "../kit/theme.js";
import { diffBlock } from "./diff.js";
import { windowRows } from "../diff.js";
import { agoLabel } from "../requirement.js";

const RAIL_WIDTH = 360;
// What one frame may draw: the app abandons a frame that asks for more.
const MAX_TOTAL_ROWS = 600;
const MAX_FILE_ROWS = 200;

/** 1548 → 1.5k: the rail is narrow and the exact number is in the commit below. */
const short = (n) => n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);

/** `v` is the Tourist view: its state is read here and its methods run on clicks. */
export function requireView(v, t) {
  const req = v.req;
  if (!req) return loading(v, t);
  const commits = v.reqRowList();
  const total = commits.length;
  const at = commits.findIndex(r => r.p === v.reqSel.p && r.c === v.reqSel.c);
  const header = paneHeader(t)
    .child(paneTitle(t, req.title || `需求 ${req.id}`))
    .when(Boolean(req.status), el => el.child(tag(t, req.status)))
    .child(div().text_size(SIZE.small).text_color(t.dim).font_family(settings().font_family).child(req.id))
    .child(v.shortcuts.button(t));
  const sub = h_flex().px(14).py(5).gap(10).items_center().text_size(SIZE.small).text_color(t.dim)
    .child(div().child(`${req.projects.length} 个工程 · ${total} 个提交`))
    .child(div().child(`详细程度 ${v.depthLabel()}`))
    .child(v.keyOf("guide", "g") ? div().text_color(t.accent).child(`${v.keyOf("guide", "g")} 开始导览`) : null)
    .child(div().child("相对 master 比较"))
    .when(Boolean(v.reqLoading), el => el.child(h_flex().gap(6).text_color(t.dim).child(spinner(t)).child(v.reqLoading)));
  const rail = v_flex().id("req-projects").size_full().overflow_y_scrollbar().py(6).border_r_1().border_color(t.border)
    .children(req.projects.flatMap((p, pi) => projectRows(v, t, p, pi)));
  const right = v_flex().id("req-diff").flex_1().min_w(0).min_h(0).overflow_y_scrollbar().px(14).py(10)
    .children(commitPanel(v, t));
  const bar = paneBar(t)
    .child(button(t, "req-guide", "开始导览", "g", total > 0, (_e, cx) => { v.startReqTour(cx); cx.notify(); }))
    .child(button(t, "req-refresh", "刷新", "r", !v.reqLoading, (_e, cx) => { v.refreshReq(cx); cx.notify(); }))
    .child(button(t, "req-back", "换需求", "esc", true, (_e, cx) => { v.reset(cx); cx.notify(); }));
  return v_flex().flex_1().min_h(0).child(header).child(sub)
    .child(h_flex().flex_1().min_h(0)
      .child(div().w(RAIL_WIDTH).flex_none().h_full().child(rail))
      .child(right))
    .when(v.shortcuts.showHints, el => el.child(bar));
}

function loading(v, t) {
  return v_flex().flex_1().p(SIZE.framePad).gap(10)
    .child(h_flex().gap(8).items_center().child(spinner(t)).child(div().font_medium().child(v.reqLoading ?? "正在读需求…")))
    .child(div().text_size(SIZE.small).text_color(t.dim).child("分支来自 Beetle，提交和 diff 来自本机克隆；工程目录在设置文件的 tourist.roots 里。"));
}

/** One project: its branch and state, then its commits, the selected one highlighted. */
function projectRows(v, t, p, pi) {
  const mono = settings().font_family;
  const head = v_flex().gap(1).px(12).pt(10).pb(4)
    .child(h_flex().gap(8).items_center()
      .child(div().font_semibold().child(p.engine))
      .child(tag(t, p.state))
      .when(Boolean(p.behind), el => el.child(tag(t, "平台头不同", t.ansi3))))
    .child(h_flex().gap(8).items_center().text_size(SIZE.small).text_color(t.dim)
      // The branch's own name repeats the project's: only its tail is worth the room.
      .child(div().min_w(0).truncate().font_family(mono).child(String(p.branch).replace(`${p.engine}-`, "")))
      .when(Boolean(p.stats.files), el => el.child(div().flex_none().font_family(mono).child(`${p.stats.files} 个文件`)))
      .when(Boolean(p.stats.add), el => el.child(div().flex_none().font_family(mono).text_color(t.ansi2).child(`+${short(p.stats.add)}`)))
      .when(Boolean(p.stats.del), el => el.child(div().flex_none().font_family(mono).text_color(t.ansi1).child(`−${short(p.stats.del)}`))));
  const note = (text) => div().px(12).pb(6).text_size(SIZE.small).text_color(t.dim).child(text);
  if (!p.dir) return [head, note("本地没有这个工程，检查设置文件的 tourist.roots。")];
  if (p.error) return [head, note(p.error)];
  if (!p.commits.length) return [head, note("相对基线没有提交。")];
  const rows = p.commits.map((c, ci) => {
    const on = v.reqSel.p === pi && v.reqSel.c === ci;
    const name = String(c.subject);
    return h_flex().id(`req-${pi}-${ci}`).gap(8).items_center().pl(on ? 10 : 12).pr(10).py(4).cursor_pointer()
      .when(on, el => el.border_l_2().border_color(t.accent).bg(t.selected))
      .hover(s => s.bg(on ? t.selected : t.hover))
      .on_click((_e, cx) => { v.selectCommit(pi, ci, cx); cx.notify(); })
      .child(div().flex_none().text_size(SIZE.small).text_color(t.accent).font_family(mono).child(c.sha))
      .child(div().flex_1().min_w(0).truncate().text_size(SIZE.text).child(name))
      .child(div().flex_none().text_size(SIZE.small).text_color(t.dim).child(agoLabel(c.date)));
  });
  const folded = p.robots ? [note(`另有 ${p.robots} 条机器人提交（已折叠）`)] : [];
  return [head, ...rows, ...folded];
}

/** The selected commit's diff, one block per file. */
function commitPanel(v, t) {
  const req = v.req, sel = v.reqSel;
  const p = req.projects[sel.p], c = p?.commits?.[sel.c];
  if (!c) return [div().p(4).text_size(SIZE.text).text_color(t.dim).child("选一个提交看它的改动。")];
  const head = h_flex().gap(10).items_center().pb(8)
    .child(div().text_size(SIZE.text).font_semibold().child(c.subject))
    .child(div().text_size(SIZE.small).text_color(t.dim).font_family(settings().font_family).child(c.sha))
    .child(div().text_size(SIZE.small).text_color(t.dim).child(`${p.engine} · ${c.date}`));
  const body = [];
  if (v.reqCommit?.loading) body.push(h_flex().gap(8).items_center().text_color(t.dim).py(6).child(spinner(t)).child("正在读这次提交的 diff…"));
  else if (v.reqCommit?.error) body.push(banner(t, v.reqCommit.error));
  else {
    // The app gives up on a frame that draws too much (it says "could not be re-rendered"), and
    // one commit can carry thousands of rows across dozens of files: draw a bounded part of it.
    const files = v.reqCommit?.files ?? [];
    let budget = MAX_TOTAL_ROWS, shown = 0;
    for (const [i, file] of files.entries()) {
      if (budget <= 0) break;
      const rows = windowRows(file.rows, 0, Math.min(MAX_FILE_ROWS, budget));
      budget -= rows.length; shown++;
      body.push(v_flex().rounded(8).border_1().border_color(t.border).bg(t.background).overflow_hidden().mb(10)
        .child(div().px(12).py(6).border_b_1().border_color(t.border).text_size(SIZE.small).text_color(t.accent)
          .font_family(settings().font_family).child(file.file))
        .child(div().py(4).child(diffBlock(`req-diff-${v.reqSel.p}-${v.reqSel.c}-${i}`, rows, t)))
        .when(rows.length < file.rows.length, el => el.child(div().px(12).py(4).border_t_1().border_color(t.border)
          .text_size(SIZE.small).text_color(t.dim).child(`此处只显示前 ${rows.length} 行（共 ${file.rows.length} 行），按 o 在编辑器里打开`))));
    }
    if (shown < files.length) body.push(div().text_size(SIZE.small).text_color(t.dim)
      .child(`另 ${files.length - shown} 个文件未显示（这次提交改了 ${files.length} 个文件）`));
  }
  return [head, ...body];
}
