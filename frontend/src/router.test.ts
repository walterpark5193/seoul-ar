import { describe, expect, it } from "vitest";
import { parseRoute, queryFor, routeQuery } from "./router";

describe("queryFor", () => {
  it("passes the hash query to the AR and 3D views only", () => {
    expect(queryFor("ar", "cf=0.0001")).toBe("cf=0.0001");
    expect(queryFor("3d", "stage=1")).toBe("stage=1");
    expect(queryFor("host", "stage=1")).toBeUndefined();
    expect(queryFor("landing", "x=1")).toBeUndefined();
  });

  it("keeps the hand-gesture stage (#/stage) apart from the 3D big-screen mode (#/3d?stage=1)", () => {
    // 이름만 겹친다: stage=1은 3D 뷰의 큰 화면 모드, #/stage는 별도 라우트(?vote=는 stageView가 location.hash에서 읽는다).
    expect(parseRoute("#/3d?stage=1")).toBe("3d");
    expect(queryFor("3d", routeQuery("#/3d?stage=1"))).toBe("stage=1");
    expect(parseRoute("#/stage?vote=강남구,마포구")).toBe("stage");
    expect(queryFor("stage", routeQuery("#/stage?vote=강남구,마포구"))).toBeUndefined();
  });
});

describe("routeQuery", () => {
  it("returns the part after ? in the hash, or an empty string", () => {
    expect(routeQuery("#/ar?cf=0.0001&beta=0.01")).toBe("cf=0.0001&beta=0.01");
    expect(routeQuery("#/ar")).toBe("");
    expect(routeQuery("#/ar?")).toBe("");
    expect(routeQuery("")).toBe("");
  });
});

describe("parseRoute", () => {
  it("maps the four hash routes", () => {
    expect(parseRoute("#/")).toBe("landing");
    expect(parseRoute("")).toBe("landing");
    expect(parseRoute("#/ar")).toBe("ar");
    expect(parseRoute("#/3d")).toBe("3d");
    expect(parseRoute("#/host")).toBe("host");
  });

  it("maps the stage route with or without a vote query", () => {
    expect(parseRoute("#/stage")).toBe("stage");
    expect(parseRoute("#/stage?vote=강남구")).toBe("stage");
    expect(parseRoute("#/stage?vote=%EA%B0%95%EB%82%A8%EA%B5%AC,%EB%A7%88%ED%8F%AC%EA%B5%AC")).toBe("stage");
    expect(parseRoute("#/stage/")).toBe("stage");
  });

  it("sends unknown routes to landing and tolerates query or trailing slash", () => {
    expect(parseRoute("#/nope")).toBe("landing");
    expect(parseRoute("#ar")).toBe("landing");
    expect(parseRoute("#/3d/")).toBe("3d");
    expect(parseRoute("#/host?x=1")).toBe("host");
  });
});
