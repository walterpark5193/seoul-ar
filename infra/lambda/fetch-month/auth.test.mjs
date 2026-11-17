import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { clientIp, keyMaterial } from "./auth.mjs";

describe("clientIp / keyMaterial", () => {
  test("CloudFront-Viewer-Address(ip:port)를 먼저, 없으면 sourceIp", () => {
    assert.equal(clientIp({ headers: { "cloudfront-viewer-address": "198.51.100.10:46532" } }), "198.51.100.10");
    assert.equal(clientIp({ headers: { "CloudFront-Viewer-Address": "2001:db8::1:443" } }), "2001:db8::1");
    assert.equal(clientIp({ headers: { "cloudfront-viewer-address": "[2001:db8::1]:443" } }), "2001:db8::1");
    assert.equal(clientIp({ headers: {}, requestContext: { http: { sourceIp: "192.0.2.5" } } }), "192.0.2.5");
    assert.equal(clientIp({}), "unknown");
  });

  test("IPv4 는 그대로, IPv6 는 /64 접두사(정규화), IPv4-mapped 는 IPv4", () => {
    assert.equal(keyMaterial("198.51.100.10"), "198.51.100.10");
    assert.equal(keyMaterial("2001:db8:1:2::10"), "2001:db8:1:2::/64");
    assert.equal(keyMaterial("2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
    assert.equal(keyMaterial("2001:db8::1"), "2001:db8:0:0::/64");
    assert.equal(keyMaterial("::1"), "0:0:0:0::/64");
    assert.equal(keyMaterial("::ffff:198.51.100.10"), "198.51.100.10");
    assert.equal(keyMaterial("unknown"), "unknown");
  });
});
