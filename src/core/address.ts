/** A base58 Tron address: T, then 33 characters of the base58 alphabet (34 in all). The shape only; no checksum. */
export const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * The hex form of a base58 Tron address: 42 lowercase hex characters, `41` then the 20-byte account id (the form
 * TronGrid uses with `visible: false`). Null when the string does not decode to 25 bytes starting 0x41. The checksum
 * is not checked: this is for finding an address in text, not for validating one.
 */
export function tronAddressHex(address: string): string | null {
  if (address.length === 0) return null;
  let n = 0n;
  for (const c of address) {
    const i = BASE58.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const hex = n.toString(16).padStart(50, "0");
  if (hex.length !== 50 || !hex.startsWith("41")) return null;
  return hex.slice(0, 42);
}
