import { describe, expect, it } from "vitest";
import { buildDeps, makeLog, venueEnv } from "../../src/index/wire.js";
import type { Config } from "../../src/index/config.js";
import type { Sql } from "../../src/index/db.js";

describe("venueEnv", () => {
  it("passes only the NetTS key, and nothing when there is none", () => {
    expect(venueEnv("n-key")).toEqual({ NETTS_API_KEY: "n-key" });
    expect(venueEnv(null)).toEqual({});
    expect(venueEnv(undefined)).toEqual({});
    expect(venueEnv("")).toEqual({});
  });
});

describe("makeLog", () => {
  it("writes a timestamped redacted line to the stream it is given", () => {
    const written: string[] = [];
    makeLog({ TRONGRID_API_KEY: "abcd1234efgh" }, { write: (s: string | Uint8Array) => (written.push(String(s)), true) })("key abcd1234efgh");
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z key \[redacted\]\n$/);
  });
  it("never throws when the stream does", () => {
    expect(() => makeLog({}, { write: () => { throw new Error("EPIPE"); } })("x")).not.toThrow();
  });
});

describe("buildDeps", () => {
  const cfg: Config = { databaseUrl: "postgres://u:p@h/db", trongridApiKey: "k", publish: false, alertWebhookUrl: null, healthcheckPingUrl: null, publicDir: "public", port: 3000, nettsApiKey: null, verifyWalletsFile: null, verifyRps: null, collectOnly: new Set() };
  it("uses the logger it is given, so a script can keep stdout for its result", () => {
    const lines: string[] = [];
    const deps = buildDeps({ ...cfg, healthcheckPingUrl: "https://hc-ping.com/x" }, {} as Sql, {}, (l) => lines.push(l));
    deps.log("hello");
    expect(lines).toEqual(["hello"]);
  });
});
