/** CSV as RFC 4180 writes it: CRLF line breaks; a field with a comma, quote, CR or LF is quoted and its quotes doubled. */

export type CsvValue = string | number | boolean | Date | null | undefined;

export function csvField(v: CsvValue): string {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A header row of `columns`, then one row per record in column order (a missing key is empty). The header is there with zero rows. */
export function toCsv(columns: readonly string[], rows: readonly Readonly<Record<string, CsvValue>>[]): string {
  return [columns, ...rows.map((r) => columns.map((c) => r[c]))].map((cells) => `${cells.map(csvField).join(",")}\r\n`).join("");
}
