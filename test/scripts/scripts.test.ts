import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadDotEnv } from "../../src/scripts/env.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const tsx = `${root}node_modules/.bin/tsx`;

function run(script: string, args: string[], env: Record<string, string> = {}) {
  // A minimal environment: no inherited DATABASE_URL or key, and ENV_FILE points at a file that does not exist so a developer's .env cannot fill them in.
  return spawnSync(tsx, [`src/scripts/${script}.ts`, ...args], { cwd: root, env: { PATH: process.env.PATH ?? "", ENV_FILE: "/nonexistent/.env", ...env }, encoding: "utf8", timeout: 20_000 });
}

describe("loadDotEnv", () => {
  it("skips a file that does not exist", () => {
    expect(() => loadDotEnv("/nonexistent/.env")).not.toThrow();
  });
});

describe("collect-once", () => {
  it("exits 2 with a one-line message for an hour other than the current one, before touching config or the database", () => {
    const r = run("collect-once", ["999999999"]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    expect(r.stderr).toContain("ConfigError: collect-once only collects the current hour (");
  });
  it("exits 2 for an argument that is not an integer", () => {
    expect(run("collect-once", ["abc"]).status).toBe(2);
  });
  it("exits 2 naming the variable when DATABASE_URL is missing", () => {
    const r = run("collect-once", []);
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).toBe("ConfigError: DATABASE_URL is required");
  });
});

describe("smoke", () => {
  it("exits 2 when TRONGRID_API_KEY is missing, without calling any API", () => {
    const r = run("smoke", []);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr.trim()).toBe("ConfigError: TRONGRID_API_KEY is required");
  });
});
