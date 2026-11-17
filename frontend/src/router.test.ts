import { describe, expect, it } from "vitest";
import { parseRoute, queryFor, routeQuery } from "./router";

describe("queryFor", () => {
  it("passes the hash query to the AR and 3D views only", () => {
    expect(queryFor("ar", "cf=0.0001")).toBe("cf=0.0001");
    expect(queryFor("3d", "stage=1")).toBe("stage=1");
    expect(queryFor("host", "stage=1")).toBeUndefined();
    expect(queryFor("landing", "x=1")).toBeUndefined();
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

  it("sends unknown routes to landing and tolerates query or trailing slash", () => {
    expect(parseRoute("#/nope")).toBe("landing");
    expect(parseRoute("#ar")).toBe("landing");
    expect(parseRoute("#/3d/")).toBe("3d");
    expect(parseRoute("#/host?x=1")).toBe("host");
  });
});
