/**
 * The Postgres tests truncate and drop tables, so they run only against a database whose name contains "test".
 * A TEST_DATABASE_URL that points anywhere else is refused with a message, never used.
 */
function resolve(): string | undefined {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return undefined;
  let name = "";
  try {
    name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    // an unparseable url is refused below
  }
  if (!name.toLowerCase().includes("test")) {
    process.stderr.write('TEST_DATABASE_URL is set but its database name does not contain "test"; the Postgres tests are skipped so they cannot truncate a real database.' + "\n");
    return undefined;
  }
  return url;
}

export const testDbUrl: string | undefined = resolve();
