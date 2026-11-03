import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VENUES } from "../src/collectors/index.js";
import { DB_END_TIMEOUT_S } from "../src/index/db.js";
import { SHUTDOWN_WAIT_MS } from "../src/index/schedule.js";
import { SERVER_CLOSE_FORCE_MS, startServer } from "../src/index/serve.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const json = (path: string): Record<string, any> => JSON.parse(readFileSync(join(root, path), "utf8"));

const railway = json("railway.json");
const deploy = railway.deploy as Record<string, unknown>;

/**
 * The longest a SIGTERM shutdown can take (schedule.ts shutdown): the server close, which serve.ts forces after
 * SERVER_CLOSE_FORCE_MS, then up to SHUTDOWN_WAIT_MS for a running hour, then sql.end({ timeout: DB_END_TIMEOUT_S }) in main.ts.
 */
const SHUTDOWN_BOUND_S = SERVER_CLOSE_FORCE_MS / 1000 + SHUTDOWN_WAIT_MS / 1000 + DB_END_TIMEOUT_S;

describe("railway.json", () => {
  it("names the schema and builds with Railpack: npm ci, then the build script", () => {
    expect(railway.$schema).toBe("https://railway.com/railway.schema.json");
    expect(railway.build).toEqual({ builder: "RAILPACK", buildCommand: "npm ci && npm run build" });
    expect(json("package.json").scripts.build).toBe("tsc -p tsconfig.build.json");
  });

  it("starts the file the build writes for src/index/main.ts, the same command as npm start", () => {
    // tsconfig.build.json sets rootDir to src (TypeScript 7 requires it explicitly), so src/index/main.ts compiles to <outDir>/index/main.js.
    const build = json("tsconfig.build.json");
    expect(build).toEqual({ extends: "./tsconfig.json", compilerOptions: { rootDir: "src" }, include: ["src"] });
    const outDir = json("tsconfig.json").compilerOptions.outDir;
    expect(outDir).toBe("dist");
    expect(existsSync(join(root, "src/index/main.ts"))).toBe(true);
    expect(deploy.startCommand).toBe(`node ${outDir}/index/main.js`);
    expect(json("package.json").scripts.start).toBe(deploy.startCommand);
  });

  it("checks the path the server answers ok on, from the first deploy (the server runs with PUBLISH=off too)", async () => {
    expect(deploy.healthcheckPath).toBe("/healthz");
    expect(deploy.healthcheckTimeout).toBe(60);
    // An empty public dir is what PUBLISH=off serves: every file route 404s, the healthcheck still answers.
    const s = await startServer(mkdtempSync(join(tmpdir(), "railway-")), 0);
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}${deploy.healthcheckPath as string}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
      expect((await fetch(`http://127.0.0.1:${s.port}/latest.json`)).status).toBe(404);
    } finally {
      await s.close();
    }
  });

  it("drains longer than the longest shutdown, so a running hour is never SIGKILLed mid-write", () => {
    expect(SHUTDOWN_BOUND_S).toBe(30);
    expect(deploy.drainingSeconds).toBeGreaterThanOrEqual(35);
    expect(deploy.drainingSeconds).toBeGreaterThan(SHUTDOWN_BOUND_S);
  });

  it("runs one instance: one replica, no deploy overlap, never asleep, restarted on failure", () => {
    expect(deploy.numReplicas).toBe(1);
    expect(deploy.overlapSeconds).toBe(0);
    expect(deploy.sleepApplication).toBe(false);
    expect(deploy.restartPolicyType).toBe("ON_FAILURE");
    expect(deploy.restartPolicyMaxRetries).toBe(10);
  });

  it("uses only keys the config-as-code schema defines (checked 2026-10-23)", () => {
    expect(Object.keys(railway).sort()).toEqual(["$schema", "build", "deploy"]);
    expect(Object.keys(deploy).sort()).toEqual(
      ["drainingSeconds", "healthcheckPath", "healthcheckTimeout", "numReplicas", "overlapSeconds", "restartPolicyMaxRetries", "restartPolicyType", "sleepApplication", "startCommand"].sort(),
    );
  });
});

describe("Node 24 on Railway", () => {
  it("package.json pins engines.node to 24, which Railpack reads for the Node version", () => {
    expect(json("package.json").engines).toEqual({ node: ">=24 <25" });
  });
});

describe(".env.example", () => {
  it("lists every variable loadConfig reads, including each venue's publish gate", () => {
    const names = readFileSync(join(root, ".env.example"), "utf8")
      .split("\n")
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => l.slice(0, l.indexOf("=")));
    const read = [...readFileSync(join(root, "src/index/config.ts"), "utf8").matchAll(/(?:get|need)\("([A-Z_]+)"\)/g)].map((m) => m[1]);
    expect(new Set(read)).toEqual(new Set(["DATABASE_URL", "TRONGRID_API_KEY", "PUBLISH", "PORT", "ALERT_WEBHOOK_URL", "HEALTHCHECK_PING_URL", "PUBLIC_DIR", "NETTS_API_KEY", "VERIFY_WALLETS_FILE", "VERIFY_RPS"]));
    const gates = VENUES.flatMap((v) => (v.publishGate ? [v.publishGate] : []));
    expect(gates).toEqual(["PUBLISH_ITRX", "PUBLISH_TRONENERGY_MARKET", "PUBLISH_TRONZAP", "PUBLISH_TOKENGOODIES"]);
    expect(names.sort()).toEqual([...read, ...gates].sort());
  });
});
