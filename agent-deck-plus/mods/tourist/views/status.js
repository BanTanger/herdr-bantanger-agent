// The screens shown while the agent plans, and when a tour stops on an error.
import { div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { SCOPES } from "../constants.js";
import { spinner } from "../kit/controls.js";
import { legend } from "../kit/legend.js";
import { SIZE } from "../kit/theme.js";

export function planningView(v, t) {
  const scope = SCOPES.find(s => s.id === v.scope)?.label ?? "";
  return v_flex().flex_1().items_center().justify_center().gap(8).p(24)
    .child(spinner(t).text_size(SIZE.h1))
    .child(div().font_medium().child(v.planNote ? `${v.planNote}…` : `${v.agentName()} 正在规划导览`))
    .child(div().text_size(SIZE.small).text_color(t.dim).child(`${scope} · ${v.depthLabel?.() ?? v.depth}。通常 30 到 90 秒，整个仓库会更久。`))
    .child(div().pt(6).child(legend(t, [["q/esc", "取消"]])));
}

export function errorView(v, t) {
  return v_flex().flex_1().p(SIZE.framePad).gap(10)
    .child(div().font_semibold().text_color(t.ansi1).child("导览已停止"))
    .child(div().text_size(SIZE.text).text_color(t.muted).child(v.error ?? ""))
    .child(legend(t, [["enter/q", "重新开始"]]));
}
