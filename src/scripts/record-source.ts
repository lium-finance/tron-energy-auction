/** The top-100 list's source line as the decision record writes it: URLs cut so that no key in a path or query leaks. */

/** The only origins whose URL path is kept in the record: keyless public APIs whose paths name the request. */
export const PATH_KEPT_ORIGINS: readonly string[] = ["https://apilist.tronscanapi.com", "https://api.trongrid.io"];

// A URL with a scheme, or a schemeless token: an optional `userinfo@`, a host (dotted, its last label letters; or IPv4),
// an optional port, then a path or a query (`host/path`, `host?query`). It starts a token: nothing word-like, a dot, a
// slash or a colon before it, so a file path such as docs/x.md?y is not read as one.
const URL_IN_TEXT =
  /[a-zA-Z][a-zA-Z0-9+.-]{0,31}:\/\/[^\s"'<>]+|(?<![\w.\/:@-])(?:[^\s"'<>\/?@]+@)?(?:(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?[\/?][^\s"'<>]*/g;
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]{0,31}:\/\//;
/** A schemeless token's leading userinfo, dropped before it is parsed. */
const USERINFO = /^[^\s"'<>\/?@]+@/;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

/**
 * One URL for the record: an allowlisted origin (PATH_KEPT_ORIGINS) keeps its path; any other is cut to scheme and host,
 * since a path can carry a key (GetBlock puts it there). Never userinfo, query or fragment; a bare "/" path is not written.
 * A schemeless token is read as https and written back without a scheme. `${protocol}//${host}` rather than origin, which
 * is "null" for a non-special scheme.
 */
function urlForRecord(bare: string): string {
  const schemeless = !HAS_SCHEME.test(bare);
  const u = new URL(schemeless ? `https://${bare.replace(USERINFO, "")}` : bare);
  const keepPath = PATH_KEPT_ORIGINS.includes(`${u.protocol}//${u.host}`) && u.pathname !== "/";
  const kept = `${u.host}${keepPath ? u.pathname : ""}`;
  return schemeless ? kept : `${u.protocol}//${kept}`;
}

/**
 * The top-100 list's source for the record: one line, each URL (or schemeless host/path) through urlForRecord. redactFiles
 * then removes configured secrets from that line but keeps its paths.
 */
export function listSourceForRecord(source: string): string {
  return source.replace(/\s*[\r\n]+\s*/g, " ").replace(URL_IN_TEXT, (match) => {
    const trail = match.match(TRAILING_PUNCTUATION)?.[0] ?? "";
    const bare = trail ? match.slice(0, -trail.length) : match;
    try {
      return `${urlForRecord(bare)}${trail}`;
    } catch {
      return `[url]${trail}`;
    }
  });
}
