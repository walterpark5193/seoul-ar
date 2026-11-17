// 뷰어(AR·3D) 공용: 상태가 바뀌면 필요한 구 데이터를 읽고, 씬과 시트를 다시 그리게 한다.
// 씬은 월·구·지표·데이터가 바뀔 때만, 시트는 매번(연결 상태·따라가기 표시 때문에).
import type { DataIndex, GuData } from "../data/types";
import type { SeoulScene } from "../scene/seoulScene";
import type { AppState, Store } from "../state/store";

export interface ViewerSyncOptions {
  store: Store;
  loadGu(month: string, gu: string): Promise<GuData>;
  onScene(state: AppState, data: GuData | null): void;
  onSheet(state: AppState, data: GuData | null): void;
}

export function bindViewer(o: ViewerSyncOptions): () => void {
  let alive = true;
  let data: GuData | null = null;
  let dataKey: string | null = null;
  let sceneKey: string | null = null;
  let token = 0;

  const drawScene = (s: AppState) => {
    const key = `${s.month}|${s.gu ?? ""}|${s.metric}|${data ? "data" : "none"}`;
    if (key === sceneKey) return;
    sceneKey = key;
    o.onScene(s, data);
  };

  const apply = (s: AppState) => {
    const key = `${s.month}|${s.gu ?? ""}`;
    if (key !== dataKey) {
      dataKey = key;
      data = null;
      const mine = ++token;
      if (s.gu) {
        o.onSheet(s, null);
        o.loadGu(s.month, s.gu)
          .then((d): GuData | null => d, (err: unknown) => { console.warn("[data] 구 자료를 읽지 못함", err); return null; })
          .then((d) => {
            if (!alive || mine !== token) return;
            data = d;
            const now = o.store.getState();
            drawScene(now);
            o.onSheet(now, data);
          });
        return;
      }
    }
    drawScene(s);
    o.onSheet(s, data);
  };

  apply(o.store.getState());
  const off = o.store.subscribe((s) => apply(s));
  return () => { alive = false; off(); };
}

/** 계약 4절 순서: 전체 색을 먼저 칠하고, 그다음 선택 구(없으면 전체 보기). */
export function drawCity(city: SeoulScene, index: DataIndex, s: AppState, data: GuData | null): void {
  city.setOverview(index.summary[s.month] ?? {}, s.metric);
  city.focus(s.gu, data, s.metric);
}
