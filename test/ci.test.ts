import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");

/** The fetch-guard step's script, taken from the workflow, so the test runs exactly what CI runs. */
function fetchGuard(): string {
  const m = ci.match(/- name: "fetch guard:[^\n]*\n\s+run: \|\n((?:\s{10}[^\n]*\n)+)/);
  if (!m) throw new Error("no fetch-guard step in ci.yml");
  return m[1]!.replace(/^ {10}/gm, "");
}

describe("ci.yml", () => {
  it("runs with read-only repository permissions", () => {
    expect(ci).toMatch(/^permissions:\n  contents: read\n/m);
  });
  it("pins every action by a full commit SHA with its tag in a comment, and Postgres by a minor tag", () => {
    const uses = [...ci.matchAll(/uses: (\S+)(.*)/g)];
    expect(uses.length).toBeGreaterThan(0);
    for (const [, ref, rest] of uses) {
      expect(ref, ref).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
      expect(rest, ref).toMatch(/^ # v\d+\.\d+\.\d+$/);
    }
    expect(ci).toMatch(/image: postgres:16\.\d+\n/);
  });
  it("the fetch guard passes on this tree and fails on a collector that calls fetch directly", () => {
    const run = (cwd: string) => spawnSync("bash", ["-euo", "pipefail", "-c", fetchGuard()], { cwd, encoding: "utf8" });
    expect(run(root).status).toBe(0);
    for (const bad of ["const r = await fetch(url);", "const r = await globalThis.fetch(url);", "const f = fetch;", "export const x = { fetchImpl: fetch };"]) {
      const dir = mkdtempSync(join(tmpdir(), "fetch-guard-"));
      mkdirSync(join(dir, "src"), { recursive: true });
      cpSync(join(root, "src/collectors"), join(dir, "src/collectors"), { recursive: true });
      writeFileSync(join(dir, "src/collectors/rogue.ts"), `${bad}\n`);
      expect(run(dir).status, bad).not.toBe(0);
    }
  });
});
