// The setup steps: what to tour, which pull request (PR tours only), then how deep.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { SCOPES, DEPTHS, PASSES } from "../constants.js";
import { ago } from "../since.js";
import { option } from "../ui.js";
import { spinner, textInput, chip } from "../kit/controls.js";
import { sectionLabel } from "../kit/pane.js";
import { legend } from "../kit/legend.js";
import { listNote } from "../kit/list.js";
import { SIZE } from "../kit/theme.js";

/** `v` is the Tourist view: its state is read here and its methods run on clicks. */
export function setupView(v, t) {
  const g = v.git;
  const noChanges = g.changed.length === 0;
  const note = (text) => listNote(t, text);
  const head = v_flex()
    .child(h_flex().items_center().child(div().flex_1().text_size(SIZE.title).font_semibold().child("Tourist")).child(v.shortcuts.button(t)))
    .when(Boolean(g.root), el => el.child(div().pt(2).text_size(SIZE.small).text_color(t.dim).child(`${g.root} · ${g.branch}`)))
    .when(Boolean(v.agent), el => el.child(h_flex().id("agent").pt(2).gap(4).text_size(SIZE.small).text_color(t.dim)
      .when(v.agents.length > 1, el => el.cursor_pointer().on_click((_e, cx) => { v.switchAgent(); cx.notify(); }))
      .child(`导览者 ${v.agentName()}`)
      .when(v.agents.length > 1 && Boolean(v.keyOf("agent", "a")), el => el.child(div().text_color(t.accent).child(`· ${v.keyOf("agent", "a")} 切换`)))
      .when(v.agent === "omp", el => el.cursor_pointer().on_click((_e, cx) => { v.goStep("model"); v.loadModels(cx); cx.notify(); })
        .child(div().child(`· 模型 ${v.model ? v.model.split("/").pop() : "默认"}`))
        .when(Boolean(v.keyOf("model", "m")), el => el.child(div().text_color(t.accent).child(`· ${v.keyOf("model", "m")} 换`))))));
  // Nothing can be picked until the repo and the agents are found (a second or two).
  if (!g.root) return v_flex().id("setup").flex_1().min_h(0).p(SIZE.framePad).child(head)
    .child(h_flex().pt(18).gap(10).items_center().text_size(SIZE.text).text_color(t.muted)
      .child(spinner(t).text_size(SIZE.title)).child("正在查找仓库和 agent…"));
  // A click works like moving there and pressing enter.
  const click = (i) => (_e, cx) => { v.leaveBox(); v.cursor = i; v.pick(cx); cx.notify(); };
  // On the first step, the count follows the highlighted scope.
  const steps = v.steps(v.step === "scope" ? SCOPES[v.cursor]?.id : v.scope);
  const stepTitle = (name) => `第 ${steps.indexOf(v.step) + 1} 步，共 ${steps.length} 步 · ${name}`;
  /** @type {import("../kit/legend.js").Hint[]} */
  let help;
  let rows, title;
  if (v.step === "scope") {
    title = stepTitle("导览什么");
    rows = SCOPES.map((s, i) => {
      const hint = s.id === "branch" ? (g.base ? (noChanges ? `相对 ${g.base} 无改动` : `相对 ${g.base} 有 ${g.changed.length} 个文件`) : "未找到基线分支")
        : s.id === "commit" ? (g.head || s.hint) : s.hint;
      return option(t, `scope-${s.id}`, s.key, s.label, hint, v.cursor === i, click(i));
    });
    const onFeature = SCOPES[v.cursor]?.id === "feature";
    if (onFeature) rows.splice(v.cursor + 1, 0, div().pl(44).pr(12).pt(2).pb(6).child(textInput(t, v.featureInput, v.typing === "feature")));
    help = v.typing === "feature" ? [["enter", "下一步"], ["tab/esc", "返回列表"]]
      : onFeature ? [["j/k", "移动"], ["tab", "输入特性"], ["enter", "下一步"]] : [["j/k", "移动"], ["enter", "下一步"]];
  } else if (v.step === "req") {
    title = stepTitle("哪个需求");
    const list = v.reqRows();
    const chips = h_flex().gap(6).px(12).pb(6).flex_wrap().children(v.reqChips().map((name) => chip(t, {
      id: `req-chip-${name}`, label: name, on: v.reqChip === name, click: cx => { v.setReqChip(name, cx); cx.notify(); },
    })));
    const filter = div().pl(12).pr(12).pb(6).child(textInput(t, v.reqFilterInput, v.typing === "reqfilter"));
    // The count and where the list came from go above it: the list runs past the bottom of the pane.
    const status = !v.reqs ? listNote(t, spinner(t)).child("正在读取需求列表…")
      : v.reqsError ? note(v.reqsError)
      : list.length === 0 ? note("没有匹配的需求。列表来自 prism-link 的本地缓存。")
      : listNote(t, `${list.length} 条${v.reqs.fetchedAt ? ` · ${String(v.reqs.fetchedAt).replace("T", " ").slice(0, 16)} 拉取` : ""}${v.reqs.stale ? "（旧缓存）" : ""} · r 刷新`);
    rows = [chips, filter, status, ...list.map((r, i) => option(t, `req-${r.id}`, i < 9 ? String(i + 1) : "·",
      r.title || `需求 ${r.id}`,
      `${r.id} · ${r.status}${r.updatedAt ? ` · ${r.updatedAt}` : ""}`,
      v.cursor === i, click(i)))];
    help = v.typing === "reqfilter" ? [["enter", "下一步"], ["tab/esc", "返回列表"]]
      : [["j/k", "移动"], ["1-9", "选择"], ["/", "筛选"], ["r", "刷新"], ["enter", "下一步"], ["esc", "返回"]];
  } else if (v.step === "pr") {
    title = stepTitle("哪个 PR");
    const prs = v.prs ?? [];
    rows = prs.map((p, i) => option(t, `pr-${p.number}`, i < 9 ? String(i + 1) : "·", `#${p.number} ${p.title}`,
      `${p.author?.login ?? ""} · ${p.headRefName} → ${p.baseRefName} · ${p.changedFiles} 个文件 +${p.additions} −${p.deletions}${p.isDraft ? " · 草稿" : ""}`,
      v.cursor === i, click(i)));
    if (v.prsError) rows = [note(v.prsError)];
    else if (!v.prs) rows = [note("正在加载未关闭的 PR…")];
    else if (prs.length === 0) rows = [note("此仓库没有未关闭的 PR。")];
    if (v.sinceLoading) rows.push(listNote(t, spinner(t)).child(`正在核对你对 #${v.prNumber} 的上次评审…`));
    help = [["j/k", "移动"], ["1-9", "选择"], ["enter", "下一步"], ["esc", "返回"]];
  } else if (v.step === "pass") {
    title = stepTitle("评审什么");
    const at = v.since?.at ? `，${ago(v.since.at)}` : "";
    rows = PASSES.map((p, i) => option(t, `pass-${p.id}`, p.key, p.label,
      p.id === "since" ? `你在 ${v.since?.oid.slice(0, 7)}${at} 评审过。只含此后改动过的 PR 文件。` : p.hint,
      v.cursor === i, click(i)));
    help = [["j/k", "移动"], ["s/w", "选择"], ["enter", "下一步"], ["esc", "返回"]];
  } else if (v.step === "model") {
    title = stepTitle("哪个模型");
    const choices = v.modelChoices();
    rows = choices.map((m, i) => option(t, `model-${i}`, i === 0 ? "·" : i < 10 ? String(i) : "·", m.label, m.hint, v.cursor === i, click(i)));
    if (v.modelsError) rows = [note(v.modelsError)];
    else if (!v.models) rows.unshift(listNote(t, spinner(t)).child("正在读取 omp 的模型列表…"));
    else if (!v.modelAll && v.models.some((m) => !m.common)) {
      // Only this machine's providers are listed until asked: the catalog holds every provider.
      const hidden = v.models.filter((m) => !m.common).length;
      rows.push(listNote(t, "").cursor_pointer().on_click((_e, cx) => { v.modelAll = true; cx.notify(); })
        .child(div().text_color(t.accent).child(`显示全部模型（另 ${hidden} 个）`)));
    }
    help = [["j/k", "移动"], ["enter", "选择"], ["esc", "返回"]];
  } else {
    const s = SCOPES.find(s => s.id === v.scope);
    const pr = v.prs?.find(p => p.number === v.prNumber);
    title = stepTitle("详细程度");
    rows = DEPTHS.map((d, i) => option(t, `depth-${d.id}`, d.key, d.label, d.text.split(". ")[0], v.cursor === i, click(i)));
    rows.unshift(div().pb(8).text_size(SIZE.text).text_color(t.muted)
      .child(`导览：${s?.label ?? ""}${v.scope === "feature" ? ` · "${v.featureInput.value().trim()}"` : ""}${pr ? ` · #${pr.number} ${pr.title}` : ""}${v.steps().includes("pass") && v.pass === "since" ? " · 自上次评审以来的改动" : ""}${v.agent === "omp" ? ` · 模型 ${v.model ? v.model.split("/").pop() : "默认"}` : ""}`));
    help = [["j/k", "移动"], ["enter", "开始导览"], ["esc", "返回"]];
  }
  if (!v.typing) help.push([",", "设置"]);
  return v_flex().id("setup").flex_1().min_h(0).overflow_y_scrollbar().p(SIZE.framePad)
    .child(head)
    .child(sectionLabel(t, title))
    .children(rows)
    .when(v.shortcuts.showHints, (el) => el.child(div().pt(SIZE.frameGap).child(legend(t, help))));
}
