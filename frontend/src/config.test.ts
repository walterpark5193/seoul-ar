import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config";

const DEFAULT = { v: 1, appUrl: null, events: null };
const events = {
  httpEndpoint: "https://example.appsync-api.us-east-1.amazonaws.com/event",
  realtimeEndpoint: "wss://example.appsync-realtime-api.us-east-1.amazonaws.com/event/realtime",
  region: "us-east-1",
  apiKey: "da2-test",
};
const respond = (body: unknown, ok = true) =>
  vi.fn(async () => ({ ok, status: ok ? 200 : 404, json: async () => body }) as unknown as Response);

describe("loadConfig", () => {
  it("fetches /config.json without cache", async () => {
    const f = respond({ v: 1, appUrl: "https://d1.cloudfront.net", events });
    const cfg = await loadConfig(f);
    expect(f).toHaveBeenCalledWith("/config.json", { cache: "no-store" });
    expect(cfg).toEqual({ v: 1, appUrl: "https://d1.cloudfront.net", events });
  });

  it("returns the default on 404, network error or a bad shape", async () => {
    expect(await loadConfig(respond({}, false))).toEqual(DEFAULT);
    expect(await loadConfig(vi.fn(async () => { throw new Error("offline"); }))).toEqual(DEFAULT);
    expect(await loadConfig(respond({ v: 2 }))).toEqual(DEFAULT);
    expect(await loadConfig(respond({ v: 1, appUrl: null, events: { region: "us-east-1" } }))).toEqual(DEFAULT);
  });

  it("accepts the development file", async () => {
    expect(await loadConfig(respond(DEFAULT))).toEqual(DEFAULT);
  });
});
