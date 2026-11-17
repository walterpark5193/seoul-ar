// 뷰어(AR·3D) 공용: 상태가 바뀌면 필요한 구 데이터를 읽고, 씬과 시트를 다시 그리게 한다.
// 씬은 월·구·지표·데이터가 바뀔 때만, 시트는 매번(연결 상태·따라가기 표시 때문에).
// 같은 구에서 달만 바뀌면(시간 여행, CONTRACTS 11) 새 달 자료가 올 때까지 씬은 이전 달 자료를 그대로 두고,
// 도착하면 focus(gu, 새 자료)를 바로 부른다(중간에 null을 넣지 않아 막대가 현재 높이에서 새 높이로 바뀐다).
// 구 자체가 바뀌면 보여 줄 것이 없으므로 focus(gu, null)로 구를 먼저 올리고, 자료가 오면 막대를 키운다.
// AI 해설(CONTRACTS 12.3)은 달마다 읽고, 없으면 잠시 뒤 다시 확인한다(발표 중에 새로 생성될 수 있다).
import type { Narration } from "../data/narration";
import type { DataIndex, GuData } from "../data/types";
import type { SeoulScene } from "../scene/seoulScene";
import type { AppState, Store } from "../state/store";

export interface ViewerSyncOptions {
  store: Store;
  loadGu(month: string, gu: string): Promise<GuData>;
  onScene(state: AppState, data: GuData | null): void;
  onSheet(state: AppState, data: GuData | null, narration: Narration | null): void;
  loadNarration?(month: string): Promise<Narration | null>;
  /** 해설이 없을 때 다시 확인하는 간격(기본 60초). */
  narrationRetryMs?: number;
}

export function bindViewer(o: ViewerSyncOptions): () => void {
  let alive = true;
  let data: GuData | null = null;
  let dataKey: string | null = null;
  let sceneKey: string | null = null;
  let sceneGu: string | null | undefined; // 씬이 지금 보여 주는 구(아직 안 그렸으면 undefined)
  let sceneData: GuData | null = null;    // 씬에 마지막으로 넘긴 자료
  let holding = false;                    // 같은 구의 새 달 자료를 기다리며 씬을 그대로 두는 중
  let token = 0;
  let narration: Narration | null = null;
  let narrationMonth: string | null = null;
  let narrationToken = 0;
  let narrationTimer: ReturnType<typeof setTimeout> | null = null;
  const retryMs = o.narrationRetryMs ?? 60_000;

  const sheet = (s: AppState) => o.onSheet(s, data, narration && narration.month === s.month ? narration : null);

  const loadNarration = (month: string) => {
    if (!o.loadNarration) return;
    if (narrationTimer) { clearTimeout(narrationTimer); narrationTimer = null; }
    const mine = ++narrationToken;
    o.loadNarration(month)
      .then((n) => n, () => null)
      .then((n) => {
        if (!alive || mine !== narrationToken) return;
        narration = n && n.month === month ? n : null;
        sheet(o.store.getState());
        if (!narration) narrationTimer = setTimeout(() => loadNarration(month), retryMs);
      });
  };

  const drawScene = (s: AppState, d: GuData | null) => {
    const key = `${s.month}|${s.gu ?? ""}|${s.metric}|${d ? `data:${d.month}` : "none"}`;
    if (key === sceneKey) return;
    sceneKey = key;
    sceneGu = s.gu;
    sceneData = d;
    o.onScene(s, d);
  };

  const apply = (s: AppState) => {
    if (s.month !== narrationMonth) {
      narrationMonth = s.month;
      narration = null;
      loadNarration(s.month);
    }
    const key = `${s.month}|${s.gu ?? ""}`;
    if (key !== dataKey) {
      dataKey = key;
      data = null;
      const mine = ++token;
      if (s.gu) {
        holding = sceneGu === s.gu && sceneData !== null;
        if (!holding) drawScene(s, null);
        sheet(s);
        o.loadGu(s.month, s.gu)
          .then((d): GuData | null => d, (err: unknown) => { console.warn("[data] 구 자료를 읽지 못함", err); return null; })
          .then((d) => {
            if (!alive || mine !== token) return;
            data = d;
            holding = false;
            const now = o.store.getState();
            drawScene(now, data);
            sheet(now);
          });
        return;
      }
      holding = false;
    }
    if (!holding) drawScene(s, data);
    sheet(s);
  };

  apply(o.store.getState());
  const off = o.store.subscribe((s) => apply(s));
  return () => {
    alive = false;
    off();
    if (narrationTimer) clearTimeout(narrationTimer);
  };
}

/** 계약 4절 순서: 전체 색을 먼저 칠하고, 그다음 선택 구(없으면 전체 보기). */
export function drawCity(city: SeoulScene, index: DataIndex, s: AppState, data: GuData | null): void {
  city.setOverview(index.summary[s.month] ?? {}, s.metric);
  city.focus(s.gu, data, s.metric);
}
