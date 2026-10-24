/** The median of `values`: the middle value, or the mean of the two middle values for an even count; null when empty. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Rounded to 4 decimal places, the stored precision (numeric(12,4)): rounding here makes an in-memory value equal the row read back. */
export const to4dp = (x: number): number => Math.round(x * 1e4) / 1e4;
