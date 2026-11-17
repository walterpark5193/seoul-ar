import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./sha256";

const node = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("sha256Hex", () => {
  it("matches the empty-string vector", async () => {
    await expect(sha256Hex("")).resolves.toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("matches Node's digest for the exact JSON request body, lowercase hex", async () => {
    const body = JSON.stringify({ month: "202610" });
    expect(body).toBe('{"month":"202610"}');
    const hex = await sha256Hex(body);
    expect(hex).toBe(node(body));
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes UTF-8 bytes (non-ASCII)", async () => {
    await expect(sha256Hex("서울이 선다")).resolves.toBe(node("서울이 선다"));
  });
});
