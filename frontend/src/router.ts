// 해시 라우터 (CONTRACTS 8절, CONTRACTS-stage 9절): #/ 랜딩, #/ar, #/3d, #/host, #/stage. 알 수 없으면 랜딩.

export type Route = "landing" | "ar" | "3d" | "host" | "stage";

const ROUTES: Record<string, Route> = { "": "landing", ar: "ar", "3d": "3d", host: "host", stage: "stage" };

export function parseRoute(hash: string): Route {
  if (hash === "" || hash === "#") return "landing";
  if (!hash.startsWith("#/")) return "landing";
  const path = hash.slice(2).split("?")[0]!.replace(/\/+$/, "");
  return ROUTES[path] ?? "landing";
}

export function navigate(hash: string): void {
  if (location.hash === hash) return;
  location.hash = hash;
}

/** 폴백용 이동: 기록을 바꿔치기해서 뒤로 가기가 실패한 화면으로 되돌아가지 않게 한다. */
export function redirect(hash: string): void {
  if (location.hash === hash) return;
  location.replace(hash);
}

/** hashchange마다 onRoute를 부른다. 처음 한 번은 즉시. 반환값은 해제 함수. */
export function startRouter(onRoute: (route: Route) => void): () => void {
  const fire = () => {
    const route = parseRoute(location.hash);
    // 알 수 없는 주소는 #/로 정리한다(새 기록 없이).
    if (route === "landing" && location.hash !== "" && location.hash !== "#" && location.hash !== "#/") {
      history.replaceState(null, "", "#/");
    }
    onRoute(route);
  };
  window.addEventListener("hashchange", fire);
  fire();
  return () => window.removeEventListener("hashchange", fire);
}
