import { describe, expect, it } from "vitest";
import { redactConfiguredSecrets, redactSecrets } from "../../src/index/redact.js";

const env = {
  TRONGRID_API_KEY: "abcdef12-3456-7890-abcd-ef1234567890",
  DATABASE_URL: "postgres://index:s3cretpassw0rd@db.railway.internal:5432/index",
  NILE_PRIVATE_KEY: "0x" + "ab".repeat(32),
  PATH: "/usr/bin",
};

describe("redactSecrets", () => {
  it("removes configured secrets wherever they appear", () => {
    expect(redactSecrets(`401 from TronGrid with key ${env.TRONGRID_API_KEY}`, env)).toBe("401 from TronGrid with key [redacted]");
    expect(redactSecrets("password authentication failed for s3cretpassw0rd", env)).toBe("password authentication failed for [redacted]");
    expect(redactSecrets(`signer ${"ab".repeat(32)}`, env)).toBe("signer [redacted]");
  });
  it("reduces every URL to scheme and host", () => {
    expect(redactSecrets("GET https://api.trongrid.io/wallet/getchainparameters?x=1 failed", env)).toBe("GET https://api.trongrid.io/[redacted] failed");
    expect(redactSecrets("https://hc-ping.com/", env)).toBe("https://hc-ping.com/");
  });
  it("is idempotent and never throws", () => {
    const once = redactSecrets("see https://a.b/c/d.", env);
    expect(redactSecrets(once, env)).toBe(once);
    expect(redactSecrets("plain", {})).toBe("plain");
  });

  it.each([
    ["TRONGRID_API_KEY", "tg-0f1e2d3c4b5a69788796"],
    ["NETTS_API_KEY", "netts-a5b4c3d2e1f0aabbccdd"],
    ["NILE_PRIVATE_KEY", "0x" + "cd".repeat(32)],
    ["DATABASE_URL", "postgres://u:pw-9f8e7d6c5b4a@db.internal:5432/app"],
    ["DATABASE_PUBLIC_URL", "postgres://u:pub-1a2b3c4d5e6f@proxy.rlwy.net:7777/app"],
    ["PGPASSWORD", "pgpass-77aa88bb99cc"],
    ["ALERT_WEBHOOK_URL", "https://hooks.example.com/services/T000/B000/XXXXXXXXXXXX"],
    ["HEALTHCHECK_PING_URL", "https://hc-ping.com/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"],
  ])("removes the value of %s from text", (name, value) => {
    const out = redactSecrets(`error talking to upstream: ${value} (end)`, { [name]: value });
    expect(out).not.toContain(value);
    expect(out).toContain("[redacted]");
  });
  it("handles a ping URL and its bare uuid", () => {
    const uuid = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
    const pingEnv = { HEALTHCHECK_PING_URL: `https://hc-ping.com/${uuid}` };
    expect(redactSecrets(`failed: https://hc-ping.com/${uuid}`, pingEnv)).toBe("failed: https://hc-ping.com/[redacted]");
    expect(redactSecrets(uuid, pingEnv)).toBe("[redacted]");
  });
  it("leaves non-secret names and short values alone", () => {
    expect(redactSecrets("PATH is /usr/bin here", env)).toBe("PATH is /usr/bin here");
    expect(redactSecrets("token abc1234 shown", { SOME_TOKEN: "abc1234" })).toBe("token abc1234 shown");
  });
  it("is idempotent with a secret present", () => {
    const text = `key ${env.TRONGRID_API_KEY} at https://x.io/p?k=1`;
    const once = redactSecrets(text, env);
    expect(redactSecrets(once, env)).toBe(once);
  });
  it("scans 200,000 characters without a scheme in under 200 ms", () => {
    const text = "a".repeat(200_000);
    const start = performance.now();
    const out = redactSecrets(text, env);
    expect(performance.now() - start).toBeLessThan(200);
    expect(out).toBe(text);
  });
});

describe("redactConfiguredSecrets", () => {
  it("removes only configured secret values and leaves URL paths and queries alone", () => {
    expect(redactConfiguredSecrets(`https://api.trongrid.io/wallet/getaccount?key=${env.TRONGRID_API_KEY}`, env)).toBe("https://api.trongrid.io/wallet/getaccount?key=[redacted]");
    expect(redactConfiguredSecrets("https://apilist.tronscanapi.com/api/account/list", env)).toBe("https://apilist.tronscanapi.com/api/account/list");
  });
});
