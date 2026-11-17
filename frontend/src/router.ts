// 해시 라우터 (CONTRACTS 8절): #/ 랜딩, #/ar, #/3d, #/host. 알 수 없으면 랜딩.

export type Route = "landing" | "ar" | "3d" | "host";

const ROUTES: Record<string, Route> = { "": "landing", ar: "ar", "3d": "3d", host: "host" };

export function parseRoute(hash: string): Route {
  if (hash === "" || hash === "#") return "landing";
  if (!hash.startsWith("#/")) return "landing";
  const path = hash.slice(2).split("?")[0]!.replace(/\/+$/, "");
  return ROUTES[path] ?? "landing";
}

/** 해시의 "?" 뒤(쿼리). 경로 판정은 이를 무시하지만, AR 뷰는 조정 파라미터로 쓴다. */
export function routeQuery(hash: string): string {
  const i = hash.indexOf("?");
  return i < 0 ? "" : hash.slice(i + 1);
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

/** hashchange마다 onRoute(경로, 쿼리)를 부른다. 처음 한 번은 즉시. 반환값은 해제 함수. */
export function startRouter(onRoute: (route: Route, query: string) => void): () => void {
  const fire = () => {
    const route = parseRoute(location.hash);
    // 알 수 없는 주소는 #/로 정리한다(새 기록 없이).
    if (route === "landing" && location.hash !== "" && location.hash !== "#" && location.hash !== "#/") {
      history.replaceState(null, "", "#/");
    }
    onRoute(route, route === "landing" ? "" : routeQuery(location.hash));
  };
  window.addEventListener("hashchange", fire);
  fire();
  return () => window.removeEventListener("hashchange", fire);
}
