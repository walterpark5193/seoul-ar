// innerHTML로 다시 그릴 때 키보드 포커스를 잃지 않게 같은 컨트롤로 되돌린다.

function keyOf(el: Element | null): string | null {
  if (!(el instanceof HTMLElement)) return null;
  const action = el.dataset.action;
  if (!action) return null;
  return `[data-action="${CSS.escape(action)}"]` + (el.dataset.value !== undefined ? `[data-value="${CSS.escape(el.dataset.value)}"]` : "");
}

export function replaceKeepingFocus(host: HTMLElement, html: string): void {
  const active = document.activeElement;
  const key = active && host.contains(active) ? keyOf(active) : null;
  host.innerHTML = html;
  if (key) host.querySelector<HTMLElement>(key)?.focus({ preventScroll: true });
}
