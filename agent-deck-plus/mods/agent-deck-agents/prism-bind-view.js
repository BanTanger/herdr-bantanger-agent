// agent-deck: builds the prism-link bind dialog. Its own file (not review.js style logic) so the
// view's imports of gpui-kit stay out of the pure helpers' tests.
//
// 720px, one search box over the cached "my requirements" list, a status filter, and a refresh that
// never empties the list (contract: .scratch/prism-mine/issues/06 + 04).
import { div } from "gpui-kit";
import { v_flex, h_flex, Input, Scrollbar } from "gpui-base";
import { ackLabel, saveLabel, mineFresh } from "./prism-bind.js";

// The status pill's tone: shipped work is blue, in-flight is amber, anything else is grey.
function statusTone(t, status) {
  if (status === "已上线") return t.done ?? t.blue ?? t.accent;
  if (status === "开发中" || status === "测试中" || status === "上线中") return t.working;
  return t.dim;
}

// `s`: { target, note, input, query, status, statuses, items, index, fetchedAt, stale, loading,
//      error, busy, confirm, lookup, handle, onQuery(cx), onStatus(status, cx), onPick(id, cx),
//      onMove(delta, cx), onRefresh(cx), onBind(cx), onUse(id, cx), onLookup(cx), onAck(cx),
//      onCancel(cx) }. `note` (bindTargetNote) names the agent card the label lands on.
export function prismBindView(t, s) {
  const target = s.target ?? {};
  const note = s.note ?? {};
  const identity = note.problem || note.note || "";
  const blocked = Boolean(note.problem || note.other);
  const meta = [target.branch, target.session ? String(target.session).slice(0, 8) : ""].filter(Boolean).join(" · ");
  const items = s.items ?? [];
  const button = (id, text, primary, on_click) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
    .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
    .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
    .hover((el) => el.opacity(0.88)).on_click(on_click).child(text);
  const row = (item, i) => h_flex().id(`prism-mine-${item.id}`).w_full().flex_none().gap(9).items_start()
    .px(8).py(6).rounded(7).cursor_pointer()
    .when(i === s.index, (el) => el.bg(t.selected))
    .when(i !== s.index, (el) => el.hover((x) => x.bg(t.hover)))
    .on_click((_e, cx) => { cx.stop_propagation(); s.onPick(String(item.id), cx); })
    .child(div().flex_none().mt(1).px(5).py(1).rounded(4).text_size(10.5)
      .bg(statusTone(t, item.status) + "26").text_color(statusTone(t, item.status))
      .child(item.status || "—"))
    .child(div().flex_1().min_w(0).text_size(12.5).text_color(t.foreground).child(item.title || String(item.id)))
    .child(div().flex_none().mt(1).text_size(10.5).text_color(t.dim).child(String(item.id)));
  const statusChip = (st) => h_flex().id(`prism-status-${st}`).flex_none().h(24).px(8).items_center().rounded(6)
    .border_1().border_color(st === s.status ? t.accent : t.border)
    .bg(st === s.status ? t.raised : t.popover)
    .text_color(st === s.status ? t.foreground : t.muted).text_size(11.5).cursor_pointer()
    .hover((el) => el.bg(t.hover))
    .on_click((_e, cx) => { cx.stop_propagation(); s.onStatus(st, cx); })
    .child(st);

  return v_flex().id("prism-bind").w_full().h_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
    .track_focus(s.handle).on_key_down((e, cx) => {
      if (e.key === "escape") { cx.stop_propagation(); s.onCancel(cx); return; }
      if (e.key === "down") { cx.stop_propagation(); s.onMove(1, cx); return; }
      if (e.key === "up") { cx.stop_propagation(); s.onMove(-1, cx); return; }
      if (e.key === "enter") { cx.stop_propagation(); s.onBind(cx); }
    })
    .child(h_flex().items_center()
      .child(div().flex_1().text_size(15).font_semibold().child("关联 prism 需求"))
      .child(div().text_size(11).text_color(t.dim).child("Esc")))
    .when(Boolean(identity), (el) => el.child(div().pt(4).text_size(11.5)
      .text_color(note.problem ? t.blocked : note.other ? t.working : t.dim).child(identity)))
    .when(Boolean(meta), (el) => el.child(div().pt(4).text_size(11.5).text_color(t.dim).child(meta)))
    .child(div().pt(14).pb(7).text_size(11.5).text_color(t.dim).child("需求"))
    .child(Input.new(s.input).h(36).px(10).rounded(9).border_1().border_color(t.accent)
      .bg(t.background).text_size(12.8).text_color(t.foreground))
    .child(div().pt(6).text_size(11.5).text_color(t.dim)
      .child("搜索标题或需求号 · ↑↓ 选择 · Enter 关联 · 粘贴飞书链接也可以"))
    .child(h_flex().pt(8).gap(6).items_center().flex_none()
      .children((s.statuses ?? ["全部"]).map(statusChip)))
    .child(h_flex().pt(8).pb(4).items_center().flex_none()
      .child(div().flex_1().text_size(11.5).text_color(t.dim)
        .child(s.loading ? "读取中…" : `${items.length} 条${s.query ? ` · 匹配「${s.query}」` : ""}`))
      .when(Boolean(s.fetchedAt), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(mineFresh(s.fetchedAt))))
      .child(h_flex().id("prism-mine-refresh").flex_none().ml(10).px(6).py(2).rounded(5).text_size(11.5)
        .text_color(s.loading ? t.dim : t.muted).cursor_pointer()
        .hover((x) => x.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { if (!s.loading) s.onRefresh(cx); })
        .child(s.loading ? "刷新中…" : "刷新")))
    .when(Boolean(s.stale || s.error), (el) => el.child(h_flex().flex_none().gap(6).pb(4)
      .child(div().text_size(11.5).text_color(t.blocked)
        .child(`${s.stale ? "刷新失败，仍显示上次结果" : "读取失败"}${s.error ? `：${s.error}` : ""}`))))
    .child(v_flex().flex_1().min_h(0).relative()
      .child(v_flex().id("prism-bind-list").size_full().gap(1).overflow_y_scroll()
        .when(Boolean(items.length), (el) => el.children(items.map(row)))
        .when(!items.length && !s.loading, (el) => el.child(div().pt(10).text_size(11.5).text_color(t.dim)
          .child(s.query ? "没有匹配的需求" : "还没有数据，点「刷新」重试"))))
      .child(Scrollbar.vertical("prism-bind-list").absolute().inset_0()))
    .when(Boolean(s.lookup), (el) => el.child(h_flex().pt(8).gap(8).items_center().flex_none()
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t[s.lookup.tone] ?? t.dim).child(s.lookup.text))
      .when(Boolean(s.lookup.use), (el) => el.child(h_flex().id("prism-bind-use").h(24).px(8).items_center().rounded(6)
        .border_1().border_color(t.input).text_size(11.5).text_color(blocked ? t.dim : t.foreground).cursor_pointer()
        .hover((x) => x.bg(t.hover)).on_click((_e, cx) => { if (!s.busy && !blocked) s.onUse(s.lookup.use, cx); })
        .child(`使用 ${s.lookup.use}`)))
      .when(s.lookup.retry, (el) => el.child(div().id("prism-bind-lookup").flex_none().px(6).py(2).rounded(5).text_size(11.5)
        .text_color(t.muted).cursor_pointer().hover((x) => x.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => s.onLookup(cx)).child("重试")))))
    .when(Boolean(s.errorParams), (el) => el.child(div().id("prism-bind-error").pt(8).text_size(11.5).text_color(t.blocked).child(s.errorParams)))
    .child(h_flex().pt(16).gap(8).justify_end().flex_none()
      .child(button("prism-bind-cancel", "取消", false, (_e, cx) => s.onCancel(cx)))
      .when(Boolean(note.other), (el) => el.child(button("prism-bind-ack", ackLabel(note.agent), true,
        (_e, cx) => { if (!s.busy) { s.onAck(cx); cx.notify(); } })))
      .when(!note.other && !note.problem, (el) => el.child(button("prism-bind-save", saveLabel(s.busy, s.confirm), true,
        (_e, cx) => { if (!s.busy) s.onBind(cx); }))));
}
