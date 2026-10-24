import { VERIFY_RPS_DEFAULT } from "../collectors/pace.js";

export interface Config {
  databaseUrl: string;
  trongridApiKey: string;
  publish: boolean;
  alertWebhookUrl: string | null;
  healthcheckPingUrl: string | null;
  publicDir: string;
  port: number;
  nettsApiKey: string | null;
  /** The wallet list the hour job reads into `verification` after each print (src/index/wallets.ts); null: no wallet reads. */
  verifyWalletsFile: string | null;
  /**
   * VERIFY_RPS as given (trimmed; null when unset): TronGrid requests a second for those reads. Checked by parseVerifyRps
   * when the reads are wired, not here, so a bad value disables only the verification reads and never stops the index.
   */
  verifyRps: string | null;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** An https URL, or a ConfigError that names the variable and never echoes the value (webhook and ping URLs carry secrets). */
function httpsUrl(name: string, value: string): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be a valid https URL`);
  }
  if (u.protocol !== "https:") throw new ConfigError(`${name} must be a valid https URL`);
  return value;
}

/** VERIFY_RPS: TronGrid requests a second for the paced reads, a whole number from 1 to 10; unset or blank means VERIFY_RPS_DEFAULT (2). */
export function parseVerifyRps(raw: string | undefined): number {
  const v = raw?.trim();
  if (!v) return VERIFY_RPS_DEFAULT;
  const n = Number(v);
  if (!/^\d+$/.test(v) || n < 1 || n > 10) throw new ConfigError("VERIFY_RPS must be a whole number from 1 to 10");
  return n;
}

/** An environment variable's trimmed value, or undefined when it is unset or blank. */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

/** An environment variable's trimmed value; a ConfigError naming it when it is unset or blank. */
export function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const v = envValue(env, name);
  if (v === undefined) throw new ConfigError(`${name} is required`);
  return v;
}

/** Port the server listens on when PORT is unset. */
const DEFAULT_PORT = 3000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const get = (k: string): string | undefined => envValue(env, k);
  const need = (k: string): string => requireEnv(env, k);

  const publishRaw = get("PUBLISH");
  if (publishRaw !== undefined && publishRaw !== "on" && publishRaw !== "off") throw new ConfigError("PUBLISH must be on or off");
  const publish = publishRaw === "on";

  const portRaw = get("PORT");
  const port = portRaw === undefined ? DEFAULT_PORT : Number(portRaw);
  if (!/^\d+$/.test(portRaw ?? "0") || !Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError("PORT must be a number from 1 to 65535");

  const alertRaw = get("ALERT_WEBHOOK_URL");
  const pingRaw = get("HEALTHCHECK_PING_URL");
  const alertWebhookUrl = alertRaw === undefined ? null : httpsUrl("ALERT_WEBHOOK_URL", alertRaw);
  const healthcheckPingUrl = pingRaw === undefined ? null : httpsUrl("HEALTHCHECK_PING_URL", pingRaw);
  if (publish && !healthcheckPingUrl) throw new ConfigError("HEALTHCHECK_PING_URL is required when PUBLISH=on");

  return {
    databaseUrl: need("DATABASE_URL"),
    trongridApiKey: need("TRONGRID_API_KEY"),
    publish,
    alertWebhookUrl,
    healthcheckPingUrl,
    publicDir: get("PUBLIC_DIR") ?? "public",
    port,
    nettsApiKey: get("NETTS_API_KEY") ?? null,
    verifyWalletsFile: get("VERIFY_WALLETS_FILE") ?? null,
    verifyRps: get("VERIFY_RPS") ?? null,
  };
}
