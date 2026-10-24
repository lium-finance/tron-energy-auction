import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/index/config.js";
import { errorLine, exitCodeFor } from "../../src/scripts/exit.js";

describe("exitCodeFor", () => {
  it("is 2 for a ConfigError and 1 for anything else", () => {
    expect(exitCodeFor(new ConfigError("x"))).toBe(2);
    expect(exitCodeFor(new Error("x"))).toBe(1);
    expect(exitCodeFor("x")).toBe(1);
    expect(exitCodeFor(undefined)).toBe(1);
  });
});

describe("errorLine", () => {
  it("is one line with the name and the message", () => {
    expect(errorLine(new ConfigError("DATABASE_URL is required"), {})).toBe("ConfigError: DATABASE_URL is required");
    expect(errorLine(new Error("a\nb\n  c"), {})).toBe("Error: a b c");
  });
  it("removes configured secrets and the path of any URL", () => {
    const env = { DATABASE_URL: "postgres://u:hunter2hunter2@db.example.com:5432/idx", TRONGRID_API_KEY: "abcd1234efgh" };
    const line = errorLine(new Error("connect postgres://u:hunter2hunter2@db.example.com:5432/idx failed; key abcd1234efgh; GET https://api.example.com/v1/k/secretpath?token=zzz"), env);
    expect(line).not.toMatch(/hunter2|abcd1234efgh|secretpath|zzz/);
    expect(line).toContain("db.example.com");
  });
  it("handles a thrown value that is not an Error", () => {
    expect(errorLine("plain", {})).toBe("plain");
    expect(errorLine({ toString() { throw new Error("no"); } }, {})).toBe("unprintable error");
  });
});
