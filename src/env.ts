export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ASSETS: Fetcher;

  APP_TIMEZONE: string;
  APP_LOCALE: string;
  ENVIRONMENT: 'development' | 'production';

  // Secrets. See wrangler.toml for how to set them.
  MASTER_KEY: string;
  DEEPSEEK_API_KEY?: string;
  NOTION_TOKEN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

/**
 * Fails loudly at the edge of a request rather than producing a confusing
 * downstream error like "Invalid key length" three call frames later.
 */
export function requireSecret(env: Env, name: keyof Env): string {
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `Configurazione mancante: ${String(name)}. Impostalo con "wrangler secret put ${String(name)}".`,
    );
  }
  return value;
}
