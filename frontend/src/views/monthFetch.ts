// 발표자 화면 "월 가져오기" (CONTRACTS 10.5): 월 입력 → (처음이면 발표자 암호) → POST → 진행 표시 → 완료 시 index 다시 읽기.
// 상태 전이는 createMonthFetch, 화면은 순수 함수 renderMonthFetch. DOM 연결은 hostView가 한다.
import { requestFetchMonth } from "../data/fetchMonth";
import { MIN_MONTH, currentMonth, inFetchRange, shiftMonth } from "../data/months";
import type { DataIndex } from "../data/types";
import { isJobMessage, type JobMessage } from "../realtime/types";
import { fmtMonth } from "../ui/format";
import { esc } from "../ui/html";

export const PRESENTER_KEY = "seoul-ar.presenter";
const TOTAL_GUS = 25;

export type FetchView =
  | { phase: "idle"; note?: string; error?: string }
  | { phase: "key"; month: string; error?: string }
  | { phase: "sending"; month: string }
  | { phase: "running"; month: string; jobId: string; done: number; total: number; gu?: string }
  | { phase: "loading"; month: string };

const MSG = {
  badMonth: "월은 2006년 1월부터 이번 달 사이로 골라 주세요.",
  unauthorized: "발표자 암호가 맞지 않습니다. 다시 입력해 주세요.",
  emptyKey: "발표자 암호를 입력해 주세요.",
  busy: "다른 달을 가져오는 중입니다. 끝난 뒤 다시 눌러 주세요.",
  unavailable: "이 배포에서는 월 가져오기를 쓸 수 없습니다.",
  network: "수집 서버에 연결하지 못했습니다. 네트워크를 확인한 뒤 다시 눌러 주세요.",
  failed: (status: number) => `수집 서버에 연결하지 못했습니다(HTTP ${status}). 잠시 뒤 다시 눌러 주세요.`,
  stale: "수집 상태를 받지 못했습니다. 잠시 뒤 다시 눌러 주세요.",
  ready: (m: string) => `${fmtMonth(m)} 데이터가 준비됐습니다`,
  reloadFailed: (m: string) => `${fmtMonth(m)} 데이터는 준비됐지만 월 목록을 새로 읽지 못했습니다. 새로고침해 주세요.`,
  jobError: (m: string, why?: string) => `${fmtMonth(m)} 수집 실패: ${why || "알 수 없는 오류가 났습니다."}`,
};

/** "2026-10"(input type=month) 또는 "202610". 형식이 틀렸거나 200601~이번 달 밖이면 null. */
export function parseMonthInput(raw: string, now: number): string | null {
  const m = /^(\d{4})-?(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const mm = Number(m[2]);
  if (mm < 1 || mm > 12) return null;
  const v = `${m[1]}${m[2]}`;
  return inFetchRange(v, now) ? v : null;
}

/** "202610" → "2026-10" (input type=month 값) */
export function monthInputValue(yyyymm: string): string {
  return `${yyyymm.slice(0, 4)}-${yyyymm.slice(4, 6)}`;
}

/** 이미 있는 가장 이른 달의 바로 앞 달(없으면 지난달). */
export function defaultFetchMonth(index: Pick<DataIndex, "months">, now: number): string {
  const earliest = [...index.months].sort()[0] ?? currentMonth(now);
  const prev = shiftMonth(earliest, -1);
  return prev < MIN_MONTH ? MIN_MONTH : prev;
}

export function isBusy(v: FetchView): boolean {
  return v.phase === "sending" || v.phase === "running" || v.phase === "loading";
}

/** 진행 한 줄. 계약 10.5의 표기 "2026년 10월 수집 중 12/25 · 강서구" 그대로. */
export function statusLine(v: FetchView): string {
  switch (v.phase) {
    case "sending": return `${fmtMonth(v.month)} 수집을 요청하는 중`;
    case "running":
      if (v.done === 0 && !v.gu) return `${fmtMonth(v.month)} 수집 시작`;
      return `${fmtMonth(v.month)} 수집 중 ${v.done}/${v.total}${v.gu ? ` · ${v.gu}` : ""}`;
    case "loading": return `${fmtMonth(v.month)} 수집 완료, 월 목록을 새로 읽는 중`;
    case "idle": return v.note ?? "";
    case "key": return "";
  }
}

export function renderMonthFetch(v: FetchView, o: { value: string; max: string }): string {
  const locked = isBusy(v) || v.phase === "key";
  const keyForm = v.phase !== "key" ? "" :
    `<form class="fetch-key" data-form="key">` +
    `<label for="presenter-key">발표자 암호</label>` +
    `<div class="fetch-row"><input id="presenter-key" type="password" name="key" autocomplete="current-password" required data-action="presenter-key">` +
    `<button type="submit" class="chip chip--primary">확인</button>` +
    `<button type="button" class="chip" data-action="fetch-cancel">취소</button></div>` +
    (v.error
      ? `<p class="fetch-error" role="alert">${esc(v.error)}</p>`
      : `<p class="fetch-hint">처음 한 번만 묻습니다. 이 탭을 닫으면 잊습니다.</p>`) +
    `</form>`;
  const error = v.phase === "idle" && v.error ? `<p class="fetch-error" role="alert">${esc(v.error)}</p>` : "";
  return `<section class="host-group host-fetch" aria-labelledby="h-fetch">` +
    `<h2 id="h-fetch">월 가져오기</h2>` +
    `<p class="host-unit">서울 열린데이터광장에서 그 달의 매매 실거래를 새로 모읍니다. 몇 분 걸리고, 끝나면 모든 화면의 월 목록에 나타납니다.</p>` +
    `<form class="fetch-row" data-form="fetch">` +
    `<label class="vh" for="fetch-month">가져올 월</label>` +
    `<input id="fetch-month" type="month" name="month" min="${monthInputValue(MIN_MONTH)}" max="${esc(o.max)}" value="${esc(o.value)}" required data-action="fetch-month">` +
    `<button type="submit" class="chip" data-fetch-submit${locked ? " disabled" : ""}>가져오기</button>` +
    `</form>` +
    keyForm +
    `<p class="fetch-status" role="status">${esc(statusLine(v))}</p>` +
    error +
    `</section>`;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface MonthFetchDeps {
  fetch: typeof fetch;
  storage: StorageLike | null;
  subscribeJobs(handler: (msg: JobMessage) => void): () => void;
  refreshIndex(): Promise<DataIndex>;
  toast(message: string): void;
  onChange(view: FetchView): void;
  /** 같은 달을 다시 가져온 경우를 위해 구 데이터 캐시를 비운다. */
  forgetMonth?(month: string): void;
  now?: () => number;
  /** 진행 이벤트가 안 올 때 data/jobs/{jobId}.json을 읽는 간격(계약 10.4 폴링 폴백). */
  pollMs?: number;
  /** 이만큼 진행이 없으면 포기한다(Lambda 제한 600초 + 여유). */
  staleMs?: number;
}

export interface MonthFetch {
  readonly view: FetchView;
  submit(input: string): Promise<void>;
  submitKey(key: string): Promise<void>;
  cancelKey(): void;
  dispose(): void;
}

export function createMonthFetch(d: MonthFetchDeps): MonthFetch {
  const now = d.now ?? Date.now;
  const pollMs = d.pollMs ?? 4000;
  const staleMs = d.staleMs ?? 11 * 60 * 1000;
  const doFetch: typeof fetch = (input, init) => d.fetch(input, init); // 메서드 호출로 this가 바뀌지 않게
  let view: FetchView = { phase: "idle" };
  let alive = true;
  let memoryKey: string | null = null; // 세션 저장소를 못 쓰는 브라우저(사생활 모드 등)
  let offJobs: (() => void) | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let lastProgress = 0;

  const set = (v: FetchView) => {
    if (!alive) return;
    view = v;
    d.onChange(v);
  };

  const readKey = (): string | null => {
    try { return d.storage?.getItem(PRESENTER_KEY) ?? memoryKey; } catch { return memoryKey; }
  };
  const writeKey = (k: string) => {
    memoryKey = k;
    try { d.storage?.setItem(PRESENTER_KEY, k); } catch { /* 메모리에만 */ }
  };
  const clearKey = () => {
    memoryKey = null;
    try { d.storage?.removeItem(PRESENTER_KEY); } catch { /* 없음 */ }
  };

  const stopPoll = () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  };

  const finish = async (month: string) => {
    set({ phase: "loading", month });
    d.forgetMonth?.(month);
    try {
      await d.refreshIndex();
      if (!alive) return;
      const note = MSG.ready(month);
      d.toast(note);
      set({ phase: "idle", note });
    } catch (err) {
      console.warn("[host] index를 다시 읽지 못함", err);
      if (!alive) return;
      const msg = MSG.reloadFailed(month);
      d.toast(msg);
      set({ phase: "idle", error: msg });
    }
  };

  const onJob = (msg: JobMessage) => {
    if (!alive) return;
    // 202 응답보다 진행 이벤트가 먼저 오면 그 작업을 받아들인다.
    if (view.phase === "sending" && msg.month === view.month && msg.state === "running") {
      lastProgress = now();
      set({ phase: "running", month: view.month, jobId: msg.jobId, done: msg.done, total: msg.total || TOTAL_GUS, gu: msg.gu });
      return;
    }
    if (view.phase !== "running" || msg.jobId !== view.jobId) return;
    if (msg.state === "running") {
      if (msg.done <= view.done) return; // 폴링과 이벤트가 겹치거나 순서가 바뀐 경우
      lastProgress = now();
      set({ ...view, done: msg.done, total: msg.total || view.total, gu: msg.gu });
      return;
    }
    stopPoll();
    if (msg.state === "error") {
      set({ phase: "idle", error: MSG.jobError(view.month, msg.message) });
      return;
    }
    void finish(view.month);
  };

  const poll = async (jobId: string) => {
    if (view.phase !== "running" || view.jobId !== jobId) return;
    if (now() - lastProgress > staleMs) {
      stopPoll();
      set({ phase: "idle", error: MSG.stale });
      return;
    }
    try {
      const res = await doFetch(`/data/jobs/${encodeURIComponent(jobId)}.json`, { cache: "no-store" });
      if (!res.ok) return;
      const body: unknown = await res.json();
      if (isJobMessage(body)) onJob(body);
    } catch { /* 다음 차례에 다시 */ }
  };

  const startPoll = (jobId: string) => {
    stopPoll();
    lastProgress = now();
    pollTimer = setInterval(() => { void poll(jobId); }, pollMs);
  };

  const send = async (month: string, key: string) => {
    offJobs ??= d.subscribeJobs(onJob); // 첫 진행 이벤트 전에 구독이 서도록 요청보다 먼저
    set({ phase: "sending", month });
    const r = await requestFetchMonth(month, key, doFetch);
    if (!alive) return;
    switch (r.kind) {
      case "started":
        if (view.phase !== "running" || view.jobId !== r.jobId) {
          set({ phase: "running", month: r.month, jobId: r.jobId, done: 0, total: TOTAL_GUS });
        }
        startPoll(r.jobId);
        return;
      case "unauthorized":
        clearKey();
        set({ phase: "key", month, error: MSG.unauthorized });
        return;
      case "bad-month": set({ phase: "idle", error: MSG.badMonth }); return;
      case "busy": set({ phase: "idle", error: MSG.busy }); return;
      case "unavailable": set({ phase: "idle", error: MSG.unavailable }); return;
      case "network": set({ phase: "idle", error: MSG.network }); return;
      case "failed": set({ phase: "idle", error: MSG.failed(r.status) }); return;
    }
  };

  return {
    get view() { return view; },
    async submit(input) {
      if (!alive || isBusy(view)) return;
      const month = parseMonthInput(input, now());
      if (!month) { set({ phase: "idle", error: MSG.badMonth }); return; }
      const key = readKey();
      if (!key) { set({ phase: "key", month }); return; }
      await send(month, key);
    },
    async submitKey(key) {
      if (!alive || view.phase !== "key") return;
      if (key.length === 0) { set({ ...view, error: MSG.emptyKey }); return; }
      writeKey(key);
      await send(view.month, key);
    },
    cancelKey() {
      if (view.phase === "key") set({ phase: "idle" });
    },
    dispose() {
      alive = false;
      stopPoll();
      offJobs?.();
      offJobs = null;
    },
  };
}
