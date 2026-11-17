// 테스트 전용 가짜 I/O (Lambda 자산에서 제외: infra/lib/seoul-ar-stack.js 의 exclude).
// 실제 서울 API, S3, SSM, CloudFront, Lambda 를 부르지 않는다.
import { PreconditionFailed } from "./job.mjs";
import { GU_ORDER } from "./gu.mjs";

export const SERVICE = "tbLnOpendataRtmsV";
export const FAKE_KEY = "fake-seoul-key-5e3c1d9a7b";

/** 조건부 쓰기(IfNoneMatch "*", IfMatch etag)를 S3 처럼 흉내 내는 메모리 저장소. */
export function fakeStore(initial = {}) {
  const objects = new Map();
  let seq = 0;
  const nextEtag = () => `"etag-${++seq}"`;
  for (const [key, value] of Object.entries(initial)) {
    objects.set(key, { text: typeof value === "string" ? value : JSON.stringify(value), etag: nextEtag(), opts: {} });
  }
  const puts = [];
  return {
    objects,
    puts,
    failPut: null, // (key) => Error | null
    async get(key) {
      const o = objects.get(key);
      return o ? { text: o.text, etag: o.etag } : null;
    },
    async put(key, text, opts = {}) {
      const err = this.failPut?.(key);
      if (err) throw err;
      const cur = objects.get(key);
      if (opts.ifNoneMatch === "*" && cur) throw new PreconditionFailed();
      if (opts.ifMatch !== undefined && (!cur || cur.etag !== opts.ifMatch)) throw new PreconditionFailed();
      const etag = nextEtag();
      objects.set(key, { text, etag, opts });
      puts.push({ key, text, opts });
      return { etag };
    },
    json(key) {
      const o = objects.get(key);
      return o ? JSON.parse(o.text) : undefined;
    },
    failList: null, // () => Error | null
    async list(prefix) {
      const err = this.failList?.();
      if (err) throw err;
      return [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
  };
}

/** 원자료 행. 출력에 들어가면 안 되는 필드(MNO, SNO, BLDG_NM)도 실제처럼 채운다. */
export function row(over = {}) {
  return {
    RCPT_YR: "2026", CGG_CD: "11680", CGG_NM: "강남구", STDG_CD: "10300", STDG_NM: "대치동",
    LOTNO_SE: "1", LOTNO_SE_NM: "대지", MNO: "0316", SNO: "0001", BLDG_NM: "비밀아파트테스트",
    CTRT_DAY: "20261015", THING_AMT: "200000", ARCH_AREA: 80, LAND_AREA: 0, FLR: 10,
    RGHT_SE: "", RTRCN_DAY: "", ARCH_YR: "1990", BLDG_USG: "아파트", DCLR_SE: "중개거래",
    OPBIZ_RESTAGNT_SGG_NM: "서울 강남구",
    ...over,
  };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** 서울 API 경로(/{key}/json/{SERVICE}/{start}/{end}/{RCPT_YR}/%20/{CGG_NM}/)를 푼다. */
export function parseSeoulUrl(url) {
  const parts = new URL(url).pathname.split("/");
  return {
    key: decodeURIComponent(parts[1]),
    type: parts[2],
    service: parts[3],
    start: Number(parts[4]),
    end: Number(parts[5]),
    year: parts[6],
    cggCd: parts[7],
    gu: decodeURIComponent(parts[8]),
    trailingSlash: url.endsWith("/"),
  };
}

/**
 * 가짜 서울 API. data[gu] = 최근 계약부터 정렬된 행 배열(해당 접수연도 전체).
 * 범위 밖이거나 행이 없으면 실제 API 처럼 최상위 {RESULT: INFO-200} 을 준다.
 */
export function fakeSeoulFetch(data = {}, { onCall } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    const p = parseSeoulUrl(url);
    calls.push({ url, init, ...p });
    const override = onCall?.(p, calls.length);
    if (override) return typeof override === "function" ? override() : override;
    const all = data[p.gu] ?? [];
    const slice = all.slice(p.start - 1, p.end);
    if (slice.length === 0) return jsonResponse({ RESULT: { CODE: "INFO-200", MESSAGE: "해당하는 데이터가 없습니다." } });
    return jsonResponse({
      [SERVICE]: { list_total_count: all.length, RESULT: { CODE: "INFO-000", MESSAGE: "정상 처리되었습니다" }, row: slice },
    });
  };
  fn.calls = calls;
  return fn;
}

export { jsonResponse };

/** 처리기 의존성 묶음. 덮어쓸 것만 넘긴다. */
export function fakeDeps(over = {}) {
  const published = [];
  const logs = [];
  const invokes = [];
  const invalidations = [];
  let clock = over.nowMs ?? Date.UTC(2026, 10, 17, 3, 0, 0); // 2026-11-17 12:00 KST
  const params = { "/seoul-ar/seoul-api-key": FAKE_KEY, "/seoul-ar/presenter-passcode": "open-sesame", ...(over.params ?? {}) };
  const deps = {
    env: {
      BUCKET: "test-bucket",
      DISTRIBUTION_ID: "EDISTTEST",
      EVENTS_HTTP_ENDPOINT: "https://example.appsync-api.us-east-1.amazonaws.com/event",
      EVENTS_API_KEY: "da2-fakeeventskey",
      SSM_API_KEY_NAME: "/seoul-ar/seoul-api-key",
      SSM_PASSCODE_NAME: "/seoul-ar/presenter-passcode",
      SELF_FUNCTION_NAME: "SeoulArStack-FetchMonthWorker",
      ...(over.env ?? {}),
    },
    fetch: over.fetch ?? fakeSeoulFetch({}),
    store: over.store ?? fakeStore(),
    async getParameter(name) {
      if (over.getParameter) return over.getParameter(name);
      if (!(name in params)) throw new Error(`ParameterNotFound: ${name}`);
      return params[name];
    },
    async invoke(args) {
      invokes.push(args);
      if (over.invoke) return over.invoke(args);
    },
    async invalidate(args) {
      invalidations.push(args);
      if (over.invalidate) return over.invalidate(args);
    },
    async publish(msg) {
      published.push(msg);
      if (over.publish) return over.publish(msg);
    },
    now: () => clock,
    randomId: over.randomId ?? (() => "job-0001-aaaa"),
    log: (level, msg, fields) => logs.push({ level, msg, fields }),
    concurrency: over.concurrency ?? 1,
  };
  return {
    deps,
    published,
    logs,
    invokes,
    invalidations,
    setNow: (ms) => { clock = ms; },
  };
}

/** Function URL 이벤트(페이로드 2.0). */
export function httpEvent({ method = "POST", path = "/api/fetch-month", headers = {}, body, isBase64Encoded = false } = {}) {
  return {
    version: "2.0",
    rawPath: path,
    headers: { "content-type": "application/json", ...headers },
    requestContext: { http: { method, path } },
    body,
    isBase64Encoded,
  };
}

export { GU_ORDER };
