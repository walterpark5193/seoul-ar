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

  it("sends unknown routes to landing and tolerates query or trailing slash", () => {
    expect(parseRoute("#/nope")).toBe("landing");
    expect(parseRoute("#ar")).toBe("landing");
    expect(parseRoute("#/3d/")).toBe("3d");
    expect(parseRoute("#/host?x=1")).toBe("host");
  });
});
