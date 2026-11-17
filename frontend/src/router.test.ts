import { describe, expect, it } from "vitest";
import { parseRoute } from "./router";

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
