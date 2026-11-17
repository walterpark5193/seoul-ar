import { describe, expect, it } from "vitest";
import { renderCaption, renderHints, renderStart, renderTopBar } from "./hud";
import type { StageState } from "../types";

const base: StageState = { mode: "map", hover: null, lifted: null, focus: null, input: "hands", vote: null, month: "202611", metric: "price", round: 0 };
const o = (conn: "idle" | "connecting" | "open" | "error" | "closed", publishFailed = false) => ({ conn, publishFailed, monthLabel: "2026년 11월" });

describe("renderTopBar", () => {
  it("제목, 월, 지표", () => {
    const h = renderTopBar(base, o("open"));
    expect(h).toContain("서울이 선다 · 무대");
    expect(h).toContain("2026년 11월");
    expect(h).toContain("㎡당 가격");
    expect(renderTopBar({ ...base, metric: "count" }, o("open"))).toContain("거래 건수");
  });
  it("연결 상태 네 가지", () => {
    expect(renderTopBar(base, o("open"))).toContain("실시간 연결");
    expect(renderTopBar(base, o("connecting"))).toContain("연결 중");
    expect(renderTopBar(base, o("error"))).toContain("오프라인 모드");
    expect(renderTopBar(base, o("closed"))).toContain("오프라인 모드");
    expect(renderTopBar(base, o("idle"))).toContain("오프라인 모드");
  });
  it("publish failure flags top bar", () => {
    const h = renderTopBar(base, o("open", true));
    expect(h).toContain("발행 실패");
    expect(h).toContain("is-failed");
    expect(renderTopBar(base, o("open"))).not.toContain("발행 실패");
  });
  it("monthLabel 이스케이프", () => {
    expect(renderTopBar(base, { ...o("open"), monthLabel: "<i>" })).not.toContain("<i>");
  });
});

describe("renderHints", () => {
  it("손 모드", () => {
    expect(renderHints(base)).toContain("주먹: 들어올리기 · 두 손 펴기: 가격순 펼치기 · 브이: 전체 보기 · V: 투표 · M: 음소거");
  });
  it("마우스 모드", () => {
    expect(renderHints({ ...base, input: "mouse" })).toContain("누르고 있기: 들어올리기 · 스페이스: 가격순 펼치기 · Esc: 전체 보기 · V: 투표 · G: 손 모드");
  });
});

describe("renderStart", () => {
  it("두 버튼", () => {
    const h = renderStart({ modelReady: true, reason: null });
    expect(h).toContain('data-start="hands"');
    expect(h).toContain("무대 시작");
    expect(h).toContain('data-start="mouse"');
    expect(h).toContain("마우스로 시작");
    expect(h).not.toContain("start-note");
  });
  it("모델 없음 안내", () => {
    const h = renderStart({ modelReady: false, reason: "model-missing" });
    expect(h).toContain("동작 인식 모델이 없어 마우스로 진행합니다");
    expect(h).toContain('data-start="mouse"');
  });
  it("그 밖의 실패 사유는 사유별 안내", () => {
    expect(renderStart({ modelReady: true, reason: "denied" })).toContain("카메라 권한");
    expect(renderStart({ modelReady: true, reason: "no-camera" })).toContain("카메라를 찾지 못");
  });
});

describe("renderCaption", () => {
  it("null이면 빈 영역", () => {
    const h = renderCaption(null);
    expect(h).toContain("stage-caption");
    expect(h).not.toMatch(/<p/);
  });
  it("본문 이스케이프", () => {
    const h = renderCaption("<b>강남구</b>");
    expect(h).toContain("&lt;b&gt;");
    expect(h).not.toContain("<b>");
  });
});
