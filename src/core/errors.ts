/** A thrown value's message: an Error's `message`, anything else as a string. Callers redact it before logging. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A thrown value as one line: an Error's name and message, anything else as a string. Callers redact it before logging. */
export function errorText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
