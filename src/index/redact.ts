/**
 * Adapted from LIUM Finance's keeper. Two layers: every URL is reduced to scheme and host
 * (keys ride in paths and query strings), and every value of a secret-named environment variable is removed
 * literally (DATABASE_URL carries a password, *_KEY carries a key). Never throws.
 */
const SECRET_ENV_NAME = /(^|_)(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|MNEMONIC|SEED|CREDENTIAL)S?($|_)|^PGPASSWORD$|API_?KEY|^(DATABASE|POSTGRES)_.*URL$|_RPC_URL$|WEBHOOK|PING_URL$/i;
const URL_IN_TEXT = /[a-zA-Z][a-zA-Z0-9+.-]{0,31}:\/\/[^\s"'<>]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;
const MIN_SECRET_LENGTH = 8;
const REDACTED = "[redacted]";

function configuredSecrets(env: NodeJS.ProcessEnv): string[] {
  const out = new Set<string>();
  const add = (v: string | undefined): void => {
    if (v !== undefined && v.length >= MIN_SECRET_LENGTH) out.add(v);
  };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value.length < MIN_SECRET_LENGTH) continue;
    if (!SECRET_ENV_NAME.test(name)) continue;
    add(value);
    if (value.startsWith("0x")) add(value.slice(2));
    try {
      const u = new URL(value);
      add(u.password);
      for (const segment of u.pathname.split("/")) add(segment);
      for (const [, v] of u.searchParams) add(v);
    } catch {
      // not a URL: a key or a password
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

const escapeForRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Only the second layer: every value of a secret-named environment variable removed literally; URLs are left as they are. Never throws. */
export function redactConfiguredSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  try {
    for (const secret of configuredSecrets(env)) {
      out = out.replace(new RegExp(escapeForRegex(secret), "g"), REDACTED);
    }
  } catch {
    return "[redacted: the text could not be scanned for secrets]";
  }
  return out;
}

export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  try {
    out = out.replace(URL_IN_TEXT, (match) => {
      if (match.includes(REDACTED)) return match;
      const trail = match.match(TRAILING_PUNCTUATION)?.[0] ?? "";
      const bare = trail ? match.slice(0, -trail.length) : match;
      try {
        const u = new URL(bare);
        const bearsSomething = u.username !== "" || u.password !== "" || u.pathname !== "/" || u.search !== "" || u.hash !== "";
        return `${u.protocol}//${u.host}${bearsSomething ? `/${REDACTED}` : "/"}${trail}`;
      } catch {
        return `[redacted url]${trail}`;
      }
    });
  } catch {
    return "[redacted: the text could not be scanned for secrets]";
  }
  return redactConfiguredSecrets(out, env);
}
