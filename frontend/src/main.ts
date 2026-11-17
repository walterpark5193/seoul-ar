// 앱 셸: 설정 → 실시간(없으면 모의) → 연결(기다리지 않음) → 데이터 인덱스 → 라우터.
import "./app.css";
import { loadConfig } from "./config";
import { createIndexSource } from "./data/indexSource";
import { forgetNarrations, loadGu, loadIndex, loadNarration, reloadIndex } from "./data/loader";
import { loadGeo, westToEast } from "./geoSource";
import { createAppSyncRealtime } from "./realtime/appsync";
import { withFallback } from "./realtime/fallback";
import { createMockRealtime } from "./realtime/mock";
import type { RealtimeClient } from "./realtime/types";
import { queryFor, redirect, startRouter, type Route } from "./router";
import { createSeoulScene } from "./scene/seoulScene";
import { bindRemote } from "./state/remote";
import { createStore, initialStateFor } from "./state/store";
import { toast } from "./ui/toast";
import { mountArView } from "./views/arView";
import { mountHostView } from "./views/hostView";
import { createLandingView } from "./views/landing";
import { mountOrbitView } from "./views/orbitView";
import type { ArDeps, MountView, ViewContext } from "./views/types";

/** AR 모듈(MindAR·tfjs)은 무거워서 #/ar에 들어갈 때만 읽는다. 못 읽으면 "미지원"으로 보고 3D로 폴백. */
const AR_UNAVAILABLE: ArDeps = {
  arSupported: () => false,
  createArSession: () => { throw new Error("AR 모듈을 읽지 못했습니다"); },
};
let arModule: Promise<ArDeps> | null = null;
function loadAr(): Promise<ArDeps> {
  arModule ??= import("./ar/session")
    .then((m): ArDeps => ({ arSupported: m.arSupported, createArSession: m.createArSession }))
    .catch((err: unknown) => {
      console.warn("[ar] 모듈을 읽지 못함", err);
      arModule = null;
      return AR_UNAVAILABLE;
    });
  return arModule;
}

const TITLES: Record<Route, string> = {
  landing: "서울이 선다",
  ar: "카메라로 보기 | 서울이 선다",
  "3d": "3D로 보기 | 서울이 선다",
  host: "발표자 화면 | 서울이 선다",
};

function makeRealtime(events: Parameters<typeof createAppSyncRealtime>[0] | null): RealtimeClient {
  let primary: RealtimeClient | null = null;
  if (events) {
    try {
      primary = createAppSyncRealtime(events);
    } catch (err) {
      console.warn("[realtime] AppSync 설정 실패", err);
    }
  }
  return withFallback(primary, () => createMockRealtime());
}

function renderDataError(root: HTMLElement): void {
  root.innerHTML = `<main class="boot boot--fail"><h1>자료를 불러오지 못했습니다</h1>` +
    `<p>네트워크를 확인한 뒤 다시 시도해 주세요.</p>` +
    `<button type="button" class="btn btn-primary" data-retry>다시 시도</button></main>`;
  root.querySelector("[data-retry]")?.addEventListener("click", () => location.reload());
}

async function main(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) return;
  root.innerHTML = `<p class="boot" role="status">불러오는 중</p>`;

  const config = await loadConfig();
  const realtime = makeRealtime(config.events);
  const connecting = realtime.connect().catch((err) => console.warn("[realtime] 연결 실패", err));

  let index;
  try {
    index = await loadIndex();
  } catch (err) {
    console.error("[data] index.json을 읽지 못함", err);
    renderDataError(root);
    return;
  }

  const store = createStore({ ...initialStateFor(index), conn: realtime.status });
  realtime.onStatus((status) => store.dispatch({ type: "conn", status }));
  void connecting.then(() => store.dispatch({ type: "conn", status: realtime.status }));

  let route: Route = "landing";
  // 새 달을 가져오면(호스트) 또는 원격 상태가 모르는 달을 가리키면(뷰어) index를 no-store로 다시 읽는다.
  // index를 다시 읽으면 해설 캐시도 비운다(CONTRACTS 12.3).
  const indexSource = createIndexSource(index, async () => {
    const next = await reloadIndex();
    forgetNarrations();
    return next;
  });
  bindRemote({
    realtime, store,
    index: () => indexSource.current,
    refreshIndex: () => indexSource.refresh(),
    isHost: () => route === "host",
  });

  const geo = loadGeo();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ctx: ViewContext = {
    store,
    get index() { return indexSource.current; },
    indexSource,
    config,
    realtime,
    loadGu: (month, gu) => loadGu(month, gu),
    loadNarration: (month) => loadNarration(month),
    navigate: redirect,
    toast,
    createScene: () => createSeoulScene(geo, { reducedMotion }),
    reducedMotion,
    ar: AR_UNAVAILABLE, // #/ar 진입 직전에 실제 모듈로 바뀐다
  };

  const views: Record<Route, MountView> = {
    landing: createLandingView(westToEast(geo)),
    ar: mountArView,
    "3d": mountOrbitView,
    host: mountHostView,
  };

  let unmount: () => void = () => {};
  let seq = 0;
  startRouter(async (next, query) => {
    const mine = ++seq;
    unmount();
    unmount = () => {};
    route = next;
    document.title = TITLES[next];
    document.body.dataset.route = next;
    root.innerHTML = "";
    if (next === "ar") {
      root.innerHTML = `<p class="boot" role="status">카메라 화면을 준비하는 중</p>`;
      ctx.ar = await loadAr();
      if (mine !== seq) return; // 기다리는 사이 다른 화면으로 이동했다
      root.innerHTML = "";
    }
    ctx.query = queryFor(next, query); // AR(조정값)과 3D(stage=1)만 쿼리를 받는다
    unmount = views[next](root, ctx);
  });
}

void main();
