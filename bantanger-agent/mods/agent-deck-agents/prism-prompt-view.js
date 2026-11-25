// agent-deck: the prism prompt as one chip on the agent's card. It used to be a sticky toast, which
// is app-wide: four unlinked sessions stacked four notices in the corner, none of them saying which
// agent was unbound, and every one of them permanent. Here the chip sits on the card whose terminal
// the binding labels, a press opens the dialog for that session, and a swipe dismisses it. The box
// is chip.js's, the same one an 已关联 requirement and a review get: only the tone and the word
// say which state it is.
import { chip } from "./chip.js";
import { SWIPE_PX } from "./prism-bind.js";

// `s`: { address, dx (travel so far, for the fade), onDown(x, cx), onMove(e, cx), onUp(e, cx),
// onLeave(cx), onWheel(e, cx), onOpen(cx) }. The chip owns no state: a gesture that covers
// several renders must not be restarted by one of them, and the press position is handed over so
// the swipe starts there rather than at the first move.
export function prismPromptChip(t, s) {
  const fade = Math.min(0.6, (Math.abs(Number(s.dx) || 0) / SWIPE_PX) * 0.6);
  return chip(`prism-prompt-${s.address}`, "未关联", t.working, {
    // A press on a prompt is about this card only: the row's own click would focus the pane first
    // and the dialog would then read a different agent as the one in front.
    press: (_e, cx) => { cx.stop_propagation(); s.onOpen(cx); },
  })
    .flex_none()
    .opacity(1 - fade)
    .tooltip("点击填写需求号或飞书链接 · 左滑取消提示")
    .on_mouse_down("left", (e, cx) => s.onDown(e?.local_position?.x, cx))
    .on_mouse_move((e, cx) => s.onMove(e, cx))
    // The pointer can leave mid-gesture: a fade must not be left behind on a card nobody swiped.
    .on_hover((on, cx) => { if (!on) s.onLeave(cx); })
    .on_mouse_up("left", (e, cx) => s.onUp(e, cx))
    .on_scroll_wheel((e, cx) => s.onWheel(e, cx));
}
