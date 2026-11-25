// The dialogs over a screen. Before a fix is pushed, a review posted, a PR merged or a ticket's comments sent, a card a
// little above the middle of the pane says what will happen: y goes ahead, n or esc cancels.
// After a merge, a card says it's done and offers what's next. The pane behind is dimmed and
// takes no clicks while one is open.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { button } from "../ui.js";
import { SIZE } from "../kit/theme.js";
import { eventsFor } from "../review.js";

/** `{ title, text, go, cancel }` for the action waiting on a yes, or null when none is. */
export function pendingConfirm(v) {
  const pr = v.pr;
  if (!pr) return null;
  if (v.phase === "fix" && v.fix?.confirm && v.fix.phase === "ready") return {
    title: "推送修复？",
    text: `将修复提交为 "Address review comments on #${pr.number}"，并推送到 GitHub 上的 ${pr.head}。`,
    go: cx => v.pushFix(cx), cancel: () => { v.fix.confirm = false; },
  };
  if (v.phase === "review" && v.review?.confirm && v.review.phase === "editing") {
    const event = eventsFor(pr)[v.review.cursor] ?? eventsFor(pr)[0], n = v.comments.length;
    return {
      title: `发布“${event.label}”？`,
      text: `以 ${pr.me || "gh 账号"} 身份发布到 PR #${pr.number}${n ? `，附带 ${n} 条评论` : ""}。PR 上的所有人都会看到。`,
      go: cx => v.postReview(cx), cancel: () => { v.review.confirm = false; },
    };
  }
  const ticket = v.ticketTour();
  if (v.phase === "tour" && v.handBack?.confirm && ticket) {
    const n = v.comments.length, error = v.handBack.error;
    return {
      title: error ? "再次发送评论？" : `将 ${n} 条评论发送到工单 #${ticket.number}？`,
      text: error ? `未能发送：${error}`
        : `将它们作为待改项保存到工单 #${ticket.number}，并在其 agent 运行时发送过去。本评审保持打开，agent 再次提交时会刷新。不会向 GitHub 发布任何内容。`,
      go: cx => v.requestChanges(cx), cancel: () => { v.handBack = null; },
    };
  }
  const m = v.merge, method = m?.methods?.[m.cursor];
  if (v.phase === "merge" && m?.confirm && m.phase === "picking" && method) return {
    title: `${method.label}？`,
    text: `将 PR #${pr.number} 合入 ${pr.base}，前提是其 head 仍是 ${pr.headOid.slice(0, 7)}。`,
    go: cx => v.doMerge(cx), cancel: () => { m.confirm = false; },
  };
  return null;
}

/** The dialog over the whole pane, or null. */
export function confirmDialog(v, t) {
  const m = v.merge;
  if (v.phase === "merge" && m?.phase === "merged") {
    const method = m.methods?.[m.cursor], ticket = v.ticketTour(), a = m.approve;
    // On a ticket's tour the merge also approves the ticket.
    const approval = !ticket || !a ? ""
      : a.phase === "approving" ? ` 正在批准工单 #${ticket.number}…`
      : a.phase === "approved" ? ` 工单 #${ticket.number} 已批准并完成。${a.error ? ` ${a.error}` : ""}`
      : ` 工单 #${ticket.number} 未获批准：${a.error}`;
    return card(t, `已合入 ${v.pr.base}`, `PR #${v.pr.number}，${method ? method.label.toLowerCase() : "已合并"}。${approval}`, [
      button(t, "merged-back", "返回导览", "b", true, (_e, cx) => { v.closeMerge(); cx.notify(); }),
      button(t, "merged-new", "新导览", "q", true, (_e, cx) => { v.reset(cx); cx.notify(); }),
      button(t, "merged-open", "打开 PR", v.keyOf("open", "o"), true, (_e, cx) => { v.openPR(); cx.notify(); }),
      ...(ticket ? [button(t, "merged-close", "关闭标签页", "c", a?.phase !== "approving", (_e, cx) => { v.closeTab(cx); cx.notify(); })] : []),
    ]);
  }
  const c = pendingConfirm(v);
  if (!c) return null;
  return card(t, c.title, c.text, [
    button(t, "confirm-no", "否", "n", true, (_e, cx) => { c.cancel(); cx.notify(); }),
    button(t, "confirm-yes", "是", "y", true, (_e, cx) => { c.go(cx); cx.notify(); }),
  ]);
}

/** A card a little above the middle of the pane: a title, a line of text and buttons on the right. */
function card(t, title, text, buttons) {
  // Clicks stop at the backdrop, so the screen behind can't be used while the dialog is open.
  // The dialog's buttons sit in front of it and get their clicks first.
  const dim = /^#[0-9a-f]{6}/i.test(t.background) ? `${t.background.slice(0, 7)}b3` : t.background;
  // pb pushes the card above the middle of the pane.
  return div().id("confirm-backdrop").absolute().inset_0().flex().items_center().justify_center().p(16).pb(160)
    .bg(dim).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .child(v_flex().id("confirm").w(440).max_w_full().p(SIZE.framePad).gap(10).rounded(SIZE.frameRadius)
      .border_1().border_color(t.accent).bg(t.popover) // the theme's color for floating surfaces
      .child(div().text_size(SIZE.title).font_semibold().child(title))
      .child(div().text_size(SIZE.text).text_color(t.muted).child(text))
      .child(h_flex().pt(6).gap(8).justify_end().children(buttons)));
}
