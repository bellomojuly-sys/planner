import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { DB } from '../db/client';
import { sessions, apiTokens, users } from '../db/schema';
import { PlannerError } from '../lib/errors';
import { randomToken, sha256Hex } from '../crypto/encryption';
import type { Env } from '../env';

/**
 * These helpers are called from routes whose context carries extra Variables
 * (`db`, `auth`). Hono's Context is invariant in its Variables, so a concrete
 * `{Bindings: Env}` annotation would reject every real call site; widening
 * Variables here is what makes the helpers reusable across route groups.
 */
type EnvContext = Context<{ Bindings: Env; Variables: any }>;

export const SESSION_COOKIE = 'planner_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Sliding renewal: touch the row at most once a day to save writes. */
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

export interface AuthContext {
  userId: string;
  scope: 'capture' | 'read' | 'full';
  via: 'session' | 'token';
}

export async function prepareSession(
  userId: string,
  userAgent?: string,
): Promise<{
  token: string;
  expiresAt: number;
  values: typeof sessions.$inferInsert;
}> {
  const token = randomToken(32);
  const expiresAt = Date.now() + SESSION_TTL_MS;
  return {
    token,
    expiresAt,
    values: {
      userId,
      tokenHash: await sha256Hex(token),
      expiresAt,
      lastSeenAt: Date.now(),
      userAgent: userAgent?.slice(0, 200),
    },
  };
}

export async function createSession(
  db: DB,
  userId: string,
  userAgent?: string,
): Promise<{ token: string; expiresAt: number }> {
  const prepared = await prepareSession(userId, userAgent);
  await db.insert(sessions).values(prepared.values);

  // Opportunistic cleanup; keeps the table from growing without a cron entry.
  await db.delete(sessions).where(lt(sessions.expiresAt, Date.now()));

  return { token: prepared.token, expiresAt: prepared.expiresAt };
}

export function attachSessionCookie(
  c: EnvContext,
  token: string,
  expiresAt: number,
): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: c.env.ENVIRONMENT !== 'development',
    sameSite: 'Lax',
    path: '/',
    expires: new Date(expiresAt),
  });
}

export function clearSessionCookie(c: EnvContext): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

async function resolveSession(
  db: DB,
  token: string,
): Promise<AuthContext | null> {
  const tokenHash = await sha256Hex(token);
  const row = await db.query.sessions.findFirst({
    where: and(
      eq(sessions.tokenHash, tokenHash),
      gt(sessions.expiresAt, Date.now()),
    ),
  });
  if (!row) return null;

  if (!row.lastSeenAt || Date.now() - row.lastSeenAt > RENEW_AFTER_MS) {
    await db
      .update(sessions)
      .set({ lastSeenAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS })
      .where(eq(sessions.id, row.id));
  }

  return { userId: row.userId, scope: 'full', via: 'session' };
}

/**
 * Bearer tokens are how the iPhone Shortcut authenticates. The `capture` scope
 * can only reach POST /api/capture — losing the phone does not expose the
 * planner.
 */
async function resolveApiToken(
  db: DB,
  token: string,
): Promise<AuthContext | null> {
  const tokenHash = await sha256Hex(token);
  const row = await db.query.apiTokens.findFirst({
    where: and(eq(apiTokens.tokenHash, tokenHash), isNull(apiTokens.revokedAt)),
  });
  if (!row) return null;

  await db
    .update(apiTokens)
    .set({ lastUsedAt: Date.now() })
    .where(eq(apiTokens.id, row.id));

  return { userId: row.userId, scope: row.scope, via: 'token' };
}

export async function authenticate(
  c: EnvContext,
  db: DB,
): Promise<AuthContext | null> {
  const header = c.req.header('authorization');
  if (header?.startsWith('Bearer ')) {
    return resolveApiToken(db, header.slice(7).trim());
  }
  const cookie = getCookie(c, SESSION_COOKIE);
  if (cookie) return resolveSession(db, cookie);
  return null;
}

export async function revokeSession(
  db: DB,
  token: string | undefined,
): Promise<void> {
  if (!token) return;
  await db.delete(sessions).where(eq(sessions.tokenHash, await sha256Hex(token)));
}

export async function createApiToken(
  db: DB,
  userId: string,
  name: string,
  scope: 'capture' | 'read' | 'full' = 'capture',
): Promise<string> {
  const prepared = await prepareApiToken(userId, name, scope);
  await db.insert(apiTokens).values(prepared.values);
  // Returned exactly once — only the hash is retained.
  return prepared.token;
}

export async function prepareApiToken(
  userId: string,
  name: string,
  scope: 'capture' | 'read' | 'full' = 'capture',
): Promise<{ token: string; values: typeof apiTokens.$inferInsert }> {
  const token = randomToken(32);
  return {
    token,
    values: {
      userId,
      name,
      scope,
      tokenHash: await sha256Hex(token),
    },
  };
}

/**
 * There is one user today. This resolves them without hardcoding an id, and is
 * the single function to change when sign-up becomes real.
 */
export async function getSoleUser(db: DB) {
  const rows = await db.select().from(users).limit(2);
  if (rows.length === 0) {
    throw new PlannerError('config_missing', {
      userMessage:
        'Nessun utente configurato. Esegui la procedura di setup iniziale.',
    });
  }
  if (rows.length > 1) {
    throw new PlannerError('internal', {
      message: 'multiple users present; single-user helper is no longer valid',
    });
  }
  return rows[0]!;
}

export { or };
