/** 选中对象后，把边栏里对应那块「拉进视野并闪一下」。
 *
 * 老板 2026-10-16：「选中家具时，边栏的对应内容要能被明显的看到，包括空间选择也是如此。」
 * 在画布上点中一件东西，右边的面板可能滚在下面看不见——统一用这个函数把它顶出来 + 高亮。
 *
 * 只滚**最近的可滚动面板**（边栏自己），绝不碰页面/画布的滚动：
 * 用 `el.scrollIntoView()` 会把整页滚下去、画布跟着位移，正在拖的把手坐标就飘了（实测踩过）。
 * 纯 DOM、不 import 其它模块。
 */
function scrollableAncestor(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node) {
    const style = getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 4) return node;
    node = node.parentElement;
  }
  return null;
}

export function revealFlash(el: HTMLElement | null | undefined, ms = 1500) {
  if (!el) return;
  const panel = scrollableAncestor(el);
  if (panel) {
    const target = el.getBoundingClientRect();
    const frame = panel.getBoundingClientRect();
    if (target.top < frame.top + 8 || target.bottom > frame.bottom - 8) {
      panel.scrollTop += (target.top - frame.top) - Math.max(8, (frame.height - target.height) / 2);
    }
  } else {
    el.scrollIntoView({ block: "nearest" });        // 没有内层滚动容器时，就近对齐（不用 smooth：动画期间坐标会飘）
  }
  el.classList.remove("flash-target");
  void el.offsetWidth;                              // 强制重排，动画才能重放（同一块连续两次也要闪）
  el.classList.add("flash-target");
  window.setTimeout(() => el.classList.remove("flash-target"), ms);
}
