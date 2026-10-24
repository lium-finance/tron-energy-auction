import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
/** git check-ignore with --no-index, so the answer is the rule's even for a path that is tracked or absent. */
const ignored = (path: string): boolean => {
  const r = spawnSync("git", ["check-ignore", "-q", "--no-index", path], { cwd: root });
  if (r.status !== 0 && r.status !== 1) throw new Error(`git check-ignore failed for ${path}: ${String(r.stderr)}`);
  return r.status === 0;
};

describe(".gitignore keeps private verification files out of commits", () => {
  it("ignores every wallets*.json except the example", () => {
    expect(ignored("docs/verification/wallets.json")).toBe(true);
    expect(ignored("docs/verification/wallets-2026-10-28.json")).toBe(true);
    expect(ignored("docs/verification/wallets.supplier.json")).toBe(true);
    expect(ignored("docs/verification/wallets.example.json")).toBe(false);
  });
  it("ignores the raw Nile probe journal and keeps the hand-written record", () => {
    expect(ignored("docs/verification/nile-lock.jsonl")).toBe(true);
    expect(ignored("docs/verification/nile-lock.md")).toBe(false);
  });
});
