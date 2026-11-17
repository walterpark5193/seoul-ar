// 짧은 알림. 화면 위쪽(바텀시트와 겹치지 않게), 보조기기에는 polite로 읽힌다.

const SHOW_MS = 5000;
let region: HTMLElement | null = null;

export function toast(message: string): void {
  if (typeof document === "undefined") return;
  if (!region || !region.isConnected) {
    region = document.createElement("div");
    region.className = "toast-region";
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    document.body.append(region);
  }
  const el = document.createElement("p");
  el.className = "toast";
  el.textContent = message;
  region.append(el);
  setTimeout(() => el.remove(), SHOW_MS);
}
