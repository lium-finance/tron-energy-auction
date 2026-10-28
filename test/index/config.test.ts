import { describe, expect, it } from "vitest";
import { loadConfig, parseVerifyRps } from "../../src/index/config.js";

const base = { DATABASE_URL: "postgres://u:p@h/db", TRONGRID_API_KEY: "k", PUBLISH: "off" };

describe("loadConfig", () => {
  it("reads the env with defaults for the optional values", () => {
    expect(loadConfig(base)).toEqual({ databaseUrl: "postgres://u:p@h/db", trongridApiKey: "k", publish: false, alertWebhookUrl: null, healthcheckPingUrl: null, publicDir: "public", port: 3000, nettsApiKey: null, verifyWalletsFile: null, verifyRps: null, collectOnly: new Set(["itrx", "tronenergy-market", "tronzap", "tokengoodies"]) });
  });
  it("requires HEALTHCHECK_PING_URL when PUBLISH is on", () => {
    expect(() => loadConfig({ ...base, PUBLISH: "on" })).toThrow("HEALTHCHECK_PING_URL is required when PUBLISH=on");
    expect(loadConfig({ ...base, PUBLISH: "on", HEALTHCHECK_PING_URL: "https://hc-ping.com/x" }).publish).toBe(true);
  });
  it("rejects a missing DATABASE_URL and a bad PORT", () => {
    expect(() => loadConfig({ TRONGRID_API_KEY: "k" })).toThrow("DATABASE_URL is required");
    expect(() => loadConfig({ TRONGRID_API_KEY: "k" })).toThrow(expect.objectContaining({ name: "ConfigError" }));
    expect(() => loadConfig({ ...base, PORT: "abc" })).toThrow("PORT must be a number");
  });
  it("trims every value it reads and treats a blank value as unset", () => {
    const c = loadConfig({ DATABASE_URL: "  postgres://u:p@h/db \n", TRONGRID_API_KEY: " k ", PUBLISH: " on ", HEALTHCHECK_PING_URL: " https://hc-ping.com/x ", ALERT_WEBHOOK_URL: "  ", PUBLIC_DIR: " out ", PORT: " 8080 ", NETTS_API_KEY: " n ", VERIFY_WALLETS_FILE: " docs/verification/wallets.json ", VERIFY_RPS: " 3 " });
    expect(c).toEqual({ databaseUrl: "postgres://u:p@h/db", trongridApiKey: "k", publish: true, alertWebhookUrl: null, healthcheckPingUrl: "https://hc-ping.com/x", publicDir: "out", port: 8080, nettsApiKey: "n", verifyWalletsFile: "docs/verification/wallets.json", verifyRps: "3", collectOnly: new Set(["itrx", "tronenergy-market", "tronzap", "tokengoodies"]) });
    expect(loadConfig({ ...base, PUBLISH: "  ", PORT: "" }).publish).toBe(false);
    expect(() => loadConfig({ DATABASE_URL: "  ", TRONGRID_API_KEY: "k" })).toThrow("DATABASE_URL is required");
  });
  it("keeps each gated venue collect-only unless its PUBLISH_<VENUE> is on, and accepts only on or off", () => {
    expect(loadConfig({ ...base, PUBLISH_ITRX: "on", PUBLISH_TOKENGOODIES: "off" }).collectOnly).toEqual(new Set(["tronenergy-market", "tronzap", "tokengoodies"]));
    expect(loadConfig({ ...base, PUBLISH_ITRX: "on", PUBLISH_TRONENERGY_MARKET: "on", PUBLISH_TRONZAP: "on", PUBLISH_TOKENGOODIES: "on" }).collectOnly).toEqual(new Set());
    expect(() => loadConfig({ ...base, PUBLISH_TRONENERGY_MARKET: "true" })).toThrow("PUBLISH_TRONENERGY_MARKET must be on or off");
  });
  it("accepts only on or off for PUBLISH", () => {
    expect(loadConfig({ ...base, PUBLISH: "off" }).publish).toBe(false);
    for (const bad of ["true", "ON", "1", "yes"]) expect(() => loadConfig({ ...base, PUBLISH: bad })).toThrow("PUBLISH must be on or off");
    expect(loadConfig({ DATABASE_URL: base.DATABASE_URL, TRONGRID_API_KEY: "k" }).publish).toBe(false);
  });
  it("requires PORT to be an integer from 1 to 65535", () => {
    expect(loadConfig({ ...base, PORT: "1" }).port).toBe(1);
    expect(loadConfig({ ...base, PORT: "65535" }).port).toBe(65535);
    for (const bad of ["0", "65536", "-1", "80.5", "1e3", "0x50", "8 0"]) expect(() => loadConfig({ ...base, PORT: bad })).toThrow("PORT must be a number");
  });
  it("requires the webhook and ping URLs to be https and never echoes them", () => {
    for (const name of ["ALERT_WEBHOOK_URL", "HEALTHCHECK_PING_URL"]) {
      const secret = "SECRET-TOKEN-123";
      for (const bad of [`http://hooks.example/${secret}`, `not a url ${secret}`, `ftp://h/${secret}`]) {
        let message = "";
        try { loadConfig({ ...base, [name]: bad }); } catch (e) { message = (e as Error).message; }
        expect(message).toContain(name);
        expect(message).not.toContain(secret);
      }
      expect(loadConfig({ ...base, [name]: "https://hooks.example/x" })).toBeDefined();
    }
    expect(loadConfig({ ...base, ALERT_WEBHOOK_URL: "https://hooks.example/x" }).alertWebhookUrl).toBe("https://hooks.example/x");
  });
  it("keeps VERIFY_RPS as given: a bad value never stops the index (parseVerifyRps checks it where the reads are wired)", () => {
    expect(loadConfig({ ...base, VERIFY_RPS: "abc" }).verifyRps).toBe("abc");
  });
});

describe("parseVerifyRps", () => {
  it("accepts a whole number from 1 to 10, defaulting to 2 when unset or blank", () => {
    expect(parseVerifyRps(undefined)).toBe(2);
    expect(parseVerifyRps("  ")).toBe(2);
    expect(parseVerifyRps("1")).toBe(1);
    expect(parseVerifyRps(" 10 ")).toBe(10);
    for (const bad of ["0", "11", "1.5", "-2", "abc", "2 rps"]) expect(() => parseVerifyRps(bad)).toThrow("VERIFY_RPS must be a whole number from 1 to 10");
  });
});
