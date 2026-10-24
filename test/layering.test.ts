import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = fileURLToPath(new URL("../src", import.meta.url));
const files = (dir: string): string[] => readdirSync(join(src, dir)).filter((f) => f.endsWith(".ts")).map((f) => join(dir, f));
const imports = (file: string): string[] => [...readFileSync(join(src, file), "utf8").matchAll(/^\s*(?:import|export)\b[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]!);
const all = ["core", "collectors", "index", "scripts"].flatMap(files);

describe("layering", () => {
  it("src/core imports nothing outside src/core", () => {
    for (const f of files("core")) for (const i of imports(f)) expect(i.startsWith("./") || !i.startsWith("."), `${f} imports ${i}`).toBe(true);
  });
  it("src/collectors imports neither src/index nor src/scripts", () => {
    for (const f of files("collectors")) for (const i of imports(f)) expect(/^\.\.\/(index|scripts)\//.test(i), `${f} imports ${i}`).toBe(false);
  });
  it("src/index never imports src/scripts", () => {
    for (const f of files("index")) for (const i of imports(f)) expect(i.startsWith("../scripts/"), `${f} imports ${i}`).toBe(false);
  });
});

describe("one home for shared constants", () => {
  const count = (re: RegExp): string[] => all.filter((f) => re.test(readFileSync(join(src, f), "utf8")));
  it("the Tron address pattern is defined once", () => {
    expect(count(/\/\^T\[1-9A-HJ-NP-Za-km-z\]\{33\}\$\//)).toEqual(["core/address.ts"]);
  });
  it("the median and the 4-dp rounding are defined once", () => {
    expect(count(/(?:function|const)\s+median\b/)).toEqual(["core/stats.ts"]);
    expect(count(/(?:function|const)\s+to4dp\b/)).toEqual(["core/stats.ts"]);
  });
  it("the VERIFY_RPS default is defined once, beside the pacer, and config.ts uses it", () => {
    expect(count(/VERIFY_RPS_DEFAULT\s*=/)).toEqual(["collectors/pace.ts"]);
    expect(readFileSync(join(src, "index/config.ts"), "utf8")).toMatch(/return VERIFY_RPS_DEFAULT;/);
  });
  it("the 24-hour band window is defined once", () => {
    expect(count(/BAND_WINDOW_HOURS\s*=/)).toEqual(["core/pass.ts"]);
  });
  it("the statement timeout and the pool-close wait are defined once, in db.ts", () => {
    expect(count(/statementTimeoutMs:\s*\d/)).toEqual([]);
    expect(count(/sql\.end\(\{\s*timeout:\s*\d/)).toEqual([]);
  });
});
