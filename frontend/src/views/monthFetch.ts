// 발표자 화면 "월 가져오기"(CONTRACTS 10.5)와 "해설 생성"(12.3).
// 월 입력 → (처음이면 발표자 암호) → POST → 진행 표시 → 완료 시 index(수집) 또는 해설(생성)을 다시 읽는다.
// 두 작업은 같은 암호·같은 진행 채널(JobMessage, kind로 구분)·같은 폴링 폴백을 쓰고, 한 번에 하나만 돈다.
// 상태 전이는 createMonthFetch, 화면은 순수 함수 renderMonthFetch. DOM 연결은 hostView가 한다.
import { requestFetchMonth, requestNarrateMonth } from "../data/fetchMonth";
import { MIN_MONTH, currentMonth, inFetchRange, shiftMonth } from "../data/months";
import type { DataIndex } from "../data/types";
import { isJobMessage, type JobMessage } from "../realtime/types";
import { fmtMonth } from "../ui/format";
import { esc } from "../ui/html";

export const PRESENTER_KEY = "seoul-ar.presenter";
const TOTAL_GUS = 25;

export type JobKind = "fetch" | "narration";

export type FetchView =
  | { phase: "idle"; note?: string; error?: string }
  | { phase: "key"; kind: JobKind; month: string; error?: string }
  | { phase: "sending"; kind: JobKind; month: string }
  | { phase: "running"; kind: JobKind; month: string; jobId: string; done: number; total: number; gu?: string }
  | { phase: "loading"; kind: JobKind; month: string };

/** 호스트가 고른 달의 해설 유무(버튼 활성 판단). */
export interface NarrationAvailability { month: string; state: "unknown" | "present" | "absent"; }

const MSG = {
  badMonth: "월은 2006년 1월부터 이번 달 사이로 골라 주세요.",
  narrBadMonth: "이 달의 데이터가 없어 해설을 만들 수 없습니다. 먼저 월을 가져와 주세요.",
  unauthorized: "발표자 암호가 맞지 않습니다. 다시 입력해 주세요.",
  emptyKey: "발표자 암호를 입력해 주세요.",
  busy: "다른 달을 가져오는 중입니다. 끝난 뒤 다시 눌러 주세요.",
  unavailable: "이 배포에서는 월 가져오기를 쓸 수 없습니다.",
  narrUnavailable: "이 배포에서는 해설 생성을 쓸 수 없습니다.",
  network: "수집 서버에 연결하지 못했습니다. 네트워크를 확인한 뒤 다시 눌러 주세요.",
  failed: (status: number) => `수집 서버에 연결하지 못했습니다(HTTP ${status}). 잠시 뒤 다시 눌러 주세요.`,
  stale: "수집 상태를 받지 못했습니다. 잠시 뒤 다시 눌러 주세요.",
  ready: (m: string) => `${fmtMonth(m)} 데이터가 준비됐습니다`,
  reloadFailed: (m: string) => `${fmtMonth(m)} 데이터는 준비됐지만 월 목록을 새로 읽지 못했습니다. 새로고침해 주세요.`,
  jobError: (m: string, why?: string) => `${fmtMonth(m)} 수집 실패: ${why || "알 수 없는 오류가 났습니다."}`,
  narrReady: "해설이 준비됐습니다",
  narrReloadFailed: "해설은 준비됐지만 다시 읽지 못했습니다. 새로고침해 주세요.",
  narrError: (m: string, why?: string) => `${fmtMonth(m)} 해설 생성 실패: ${why || "알 수 없는 오류가 났습니다."}`,
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

/**
 * 구역을 다시 그릴지. 작업 상태(view)가 바뀌면 언제나, 바깥 사정(월·index·해설 유무)이 바뀌면
 * 암호 입력 중이 아닐 때만 다시 그린다(입력 중인 암호가 지워지지 않게).
 */
export function needsFetchRender(phase: FetchView["phase"], cause: "view" | "context"): boolean {
  return cause === "view" || phase !== "key";
}

export function isBusy(v: FetchView): boolean {
  return v.phase === "sending" || v.phase === "running" || v.phase === "loading";
}

/** 진행 한 줄. 수집은 계약 10.5 표기 "2026년 10월 수집 중 12/25 · 강서구" 그대로. */
export function statusLine(v: FetchView): string {
  if (v.phase === "idle") return v.note ?? "";
  if (v.phase === "key") return "";
  const m = fmtMonth(v.month);
  if (v.kind === "narration") {
    if (v.phase === "sending") return `${m} 해설 생성을 요청하는 중`;
    if (v.phase === "loading") return `${m} 해설을 새로 읽는 중`;
    return v.done > 0 && v.total > 0 ? `${m} 해설 생성 중 ${v.done}/${v.total}` : `${m} 해설 생성 중`;
  }
  if (v.phase === "sending") return `${m} 수집을 요청하는 중`;
  if (v.phase === "loading") return `${m} 수집 완료, 월 목록을 새로 읽는 중`;
  if (v.done === 0 && !v.gu) return `${m} 수집 시작`;
  return `${m} 수집 중 ${v.done}/${v.total}${v.gu ? ` · ${v.gu}` : ""}`;
}

function renderNarrate(n: NarrationAvailability | undefined, locked: boolean): string {
  if (!n) return "";
  const enabled = n.state === "absent" && !locked;
  const hint = n.state === "present" ? `${fmtMonth(n.month)} 해설이 있습니다`
    : n.state === "absent" ? `${fmtMonth(n.month)} 해설이 아직 없습니다`
      : `${fmtMonth(n.month)} 해설을 확인하는 중`;
  return `<div class="fetch-row fetch-narrate">` +
    `<button type="button" class="chip" data-action="narrate"${enabled ? "" : " disabled"}>해설 생성</button>` +
    `<span class="fetch-hint">${esc(hint)}</span></div>`;
}

export function renderMonthFetch(v: FetchView, o: { value: string; max: string; narration?: NarrationAvailability }): string {
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
    renderNarrate(o.narration, locked) +
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
  /** 해설 생성이 끝나면 그 달 해설을 다시 읽는다(캐시 비우고 다시 확인). */
  reloadNarration?(month: string): Promise<unknown>;
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
  /** 월 가져오기 */
  submit(input: string): Promise<void>;
  /** 해설 생성(이미 있는 달) */
  narrate(month: string): Promise<void>;
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

  const finishFetch = async (month: string) => {
    set({ phase: "loading", kind: "fetch", month });
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

  const finishNarration = async (month: string) => {
    set({ phase: "loading", kind: "narration", month });
    try {
      await d.reloadNarration?.(month);
      if (!alive) return;
      d.toast(MSG.narrReady);
      set({ phase: "idle", note: MSG.narrReady });
    } catch (err) {
      console.warn("[host] 해설을 다시 읽지 못함", err);
      if (!alive) return;
      d.toast(MSG.narrReloadFailed);
      set({ phase: "idle", error: MSG.narrReloadFailed });
    }
  };

  /** 작업 기록 파일(data/jobs/{jobId}.json, no-store). 없거나(SPA 폴백 HTML 포함) 모양이 틀리면 null. */
  const readRecord = async (jobId: string): Promise<JobMessage | null> => {
    try {
      const res = await doFetch(`/data/jobs/${encodeURIComponent(jobId)}.json`, { cache: "no-store" });
      if (!res.ok) return null;
      const body: unknown = await res.json();
      return isJobMessage(body) && body.jobId === jobId ? body : null;
    } catch {
      return null;
    }
  };

  /**
   * /seoul/jobs는 공개 API 키로 누구나 발행할 수 있다. 완료·실패 이벤트는 그대로 믿지 않고
   * 작업 기록이 같은 상태일 때만 따른다. 기록이 없거나 아직 running이면 무시한다(폴링이 따라잡는다).
   * running(진행 숫자)은 확인 없이 반영한다.
   * verified: 기록 파일에서 읽은 것(폴링 또는 확인을 거친 것)이면 true.
   */
  const onJob = (msg: JobMessage, verified = false) => {
    if (!alive) return;
    const msgKind: JobKind = msg.kind ?? "fetch";
    // 202 응답보다 진행 이벤트가 먼저 오면 그 작업을 받아들인다.
    if (view.phase === "sending" && msg.month === view.month && msgKind === view.kind && msg.state === "running") {
      lastProgress = now();
      set({ phase: "running", kind: view.kind, month: view.month, jobId: msg.jobId, done: msg.done, total: msg.total || TOTAL_GUS, gu: msg.gu });
      return;
    }
    if (view.phase !== "running" || msg.jobId !== view.jobId) return;
    // 기록 파일은 우리 202 응답의 jobId로 읽은 것이라 kind가 비어 있어도 우리 작업이다. 이벤트만 kind를 맞춰 본다.
    if (!verified && msgKind !== view.kind) return;
    if (msg.state === "running") {
      if (msg.done <= view.done) return; // 폴링과 이벤트가 겹치거나 순서가 바뀐 경우
      lastProgress = now();
      set({ ...view, done: msg.done, total: msg.total || view.total, gu: msg.gu });
      return;
    }
    if (!verified) { void confirm(msg); return; }
    stopPoll();
    const { kind, month } = view;
    if (msg.state === "error") {
      set({ phase: "idle", error: kind === "narration" ? MSG.narrError(month, msg.message) : MSG.jobError(month, msg.message) });
      return;
    }
    void (kind === "narration" ? finishNarration(month) : finishFetch(month));
  };

  const confirm = async (event: JobMessage) => {
    const record = await readRecord(event.jobId);
    if (!record || record.state !== event.state) return;
    onJob(record, true);
  };

  const poll = async (jobId: string) => {
    if (view.phase !== "running" || view.jobId !== jobId) return;
    if (now() - lastProgress > staleMs) {
      stopPoll();
      set({ phase: "idle", error: MSG.stale });
      return;
    }
    const record = await readRecord(jobId); // 없으면 다음 차례에 다시
    if (record) onJob(record, true);
  };

  const startPoll = (jobId: string) => {
    stopPoll();
    lastProgress = now();
    pollTimer = setInterval(() => { void poll(jobId); }, pollMs);
  };

  const send = async (kind: JobKind, month: string, key: string) => {
    offJobs ??= d.subscribeJobs(onJob); // 첫 진행 이벤트 전에 구독이 서도록 요청보다 먼저
    set({ phase: "sending", kind, month });
    const request = kind === "narration" ? requestNarrateMonth : requestFetchMonth;
    const r = await request(month, key, doFetch);
    if (!alive) return;
    switch (r.kind) {
      case "started":
        if (view.phase !== "running" || view.jobId !== r.jobId) {
          set({ phase: "running", kind, month: r.month, jobId: r.jobId, done: 0, total: kind === "fetch" ? TOTAL_GUS : 0 });
        }
        startPoll(r.jobId);
        return;
      case "unauthorized":
        clearKey();
        set({ phase: "key", kind, month, error: MSG.unauthorized });
        return;
      case "bad-month": set({ phase: "idle", error: kind === "narration" ? MSG.narrBadMonth : MSG.badMonth }); return;
      case "busy": set({ phase: "idle", error: MSG.busy }); return;
      case "unavailable": set({ phase: "idle", error: kind === "narration" ? MSG.narrUnavailable : MSG.unavailable }); return;
      case "network": set({ phase: "idle", error: MSG.network }); return;
      case "failed": set({ phase: "idle", error: MSG.failed(r.status) }); return;
    }
  };

  const start = async (kind: JobKind, month: string) => {
    const key = readKey();
    if (!key) { set({ phase: "key", kind, month }); return; }
    await send(kind, month, key);
  };

  return {
    get view() { return view; },
    async submit(input) {
      if (!alive || isBusy(view)) return;
      const month = parseMonthInput(input, now());
      if (!month) { set({ phase: "idle", error: MSG.badMonth }); return; }
      await start("fetch", month);
    },
    async narrate(month) {
      if (!alive || isBusy(view) || !/^\d{6}$/.test(month)) return;
      await start("narration", month);
    },
    async submitKey(key) {
      if (!alive || view.phase !== "key") return;
      if (key.length === 0) { set({ ...view, error: MSG.emptyKey }); return; }
      writeKey(key);
      await send(view.kind, view.month, key);
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
