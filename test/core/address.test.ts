import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { tronAddressHex } from "../../src/core/address.js";

const sha = (b: Buffer): Buffer => createHash("sha256").update(b).digest();

describe("tronAddressHex", () => {
  it("decodes a base58 address to its 21-byte hex form, 41 first, and the checksum holds", () => {
    const hex = tronAddressHex("TExampLeSupp1ierWa11etAAAAAAE5MwZh")!;
    expect(hex).toBe("4136ba63159ace1bcfdb2f129d5b604959260aeb1e");
    expect(hex).toMatch(/^41[0-9a-f]{40}$/);
  });
  it("returns null for a string that is not a 25-byte 0x41 address", () => {
    expect(tronAddressHex("not-an-address")).toBeNull();
    expect(tronAddressHex("T1")).toBeNull();
    expect(tronAddressHex("")).toBeNull();
  });
});

describe("the synthetic test addresses", () => {
  /** Full base58check: 25 bytes, 0x41 first, the last 4 bytes the double-sha256 of the first 21. */
  const valid = (s: string): boolean => {
    const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let n = 0n;
    for (const c of s) n = n * 58n + BigInt(ALPHA.indexOf(c));
    const b = Buffer.from(n.toString(16).padStart(50, "0"), "hex");
    return b.length === 25 && b[0] === 0x41 && sha(sha(b.subarray(0, 21))).subarray(0, 4).equals(b.subarray(21));
  };
  it("are valid base58check addresses", () => {
    for (const a of ["TExampLeSupp1ierWa11etAAAAAAE5MwZh", "TExampLeTopStakerWa11etBBBBBDJGqNw", "TExampLeTopStakerWa11etCCCCCBvCnqf"]) expect(valid(a)).toBe(true);
  });
});
