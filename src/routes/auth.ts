import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { AppBindings } from '../auth/middleware';
import { requireAuth } from '../auth/middleware';
import { setPin, verifyPin } from '../auth/pin';
import {
  SESSION_COOKIE,
  attachSessionCookie,
  clearSessionCookie,
  createApiToken,
  createSession,
  getSoleUser,
  revokeSession,
  authenticate,
} from '../auth/session';
import { users, settings, apiTokens } from '../db/schema';
import { PlannerError } from '../lib/errors';

export const authRoutes = new Hono<AppBindings>();

/**
 * First-run setup. Only possible while no user exists, so the endpoint cannot
 * be used to create a second account or reset an existing PIN.
 */
authRoutes.post('/setup', async (c) => {
  const db = c.get('db');
  const existing = await db.select().from(users).limit(1);
  if (existing.length > 0) {
    throw new PlannerError('conflict', {
      userMessage: 'La configurazione è già stata completata.',
    });
  }

  const body = z
    .object({
      email: z.string().email(),
      displayName: z.string().min(1).max(80),
      pin: z.string(),
      timezone: z.string().default('Europe/Rome'),
    })
    .parse(await c.req.json());

  const [user] = await db
    .insert(users)
    .values({
      email: body.email,
      displayName: body.displayName,
      timezone: body.timezone,
    })
    .returning();

  await setPin(db, user!.id, body.pin);
  await db.insert(settings).values({ userId: user!.id });

  const captureToken = await createApiToken(
    db,
    user!.id,
    'iPhone Action Button',
    'capture',
  );

  const session = await createSession(db, user!.id, c.req.header('user-agent'));
  attachSessionCookie(c, session.token, session.expiresAt);

  return c.json({
    ok: true,
    userId: user!.id,
    // Shown once — this is what goes into the iOS Shortcut.
    captureToken,
  });
});

authRoutes.get('/status', async (c) => {
  const db = c.get('db');
  const anyUser = await db.select().from(users).limit(1);

  if (anyUser.length === 0) {
    return c.json({ configured: false, authenticated: false });
  }

  const auth = await authenticate(c, db);
  return c.json({
    configured: true,
    authenticated: auth !== null,
    displayName: auth ? anyUser[0]!.displayName : undefined,
  });
});

authRoutes.post('/unlock', async (c) => {
  const db = c.get('db');
  const body = z.object({ pin: z.string() }).parse(await c.req.json());

  const user = await getSoleUser(db);
  const result = await verifyPin(db, user.id, body.pin);

  if (!result.ok) {
    return c.json(
      {
        error: 'unauthorized',
        message: `PIN errato. ${result.attemptsLeft} tentativi rimasti.`,
        attemptsLeft: result.attemptsLeft,
      },
      401,
    );
  }

  const session = await createSession(db, user.id, c.req.header('user-agent'));
  attachSessionCookie(c, session.token, session.expiresAt);

  return c.json({ ok: true, displayName: user.displayName });
});

authRoutes.post('/logout', async (c) => {
  await revokeSession(c.get('db'), getCookie(c, SESSION_COOKIE));
  clearSessionCookie(c);
  return c.json({ ok: true });
});

authRoutes.post('/pin', requireAuth('full'), async (c) => {
  const db = c.get('db');
  const { userId } = c.get('auth');
  const body = z
    .object({ currentPin: z.string(), newPin: z.string() })
    .parse(await c.req.json());

  const check = await verifyPin(db, userId, body.currentPin);
  if (!check.ok) throw new PlannerError('unauthorized', { userMessage: 'PIN attuale errato.' });

  await setPin(db, userId, body.newPin);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Capture tokens for the iOS Shortcut
// ---------------------------------------------------------------------------

authRoutes.get('/tokens', requireAuth('full'), async (c) => {
  const rows = await c
    .get('db')
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      scope: apiTokens.scope,
      lastUsedAt: apiTokens.lastUsedAt,
      revokedAt: apiTokens.revokedAt,
      createdAt: apiTokens.createdAt,
    })
    .from(apiTokens)
    .where(eq(apiTokens.userId, c.get('auth').userId));

  return c.json({ tokens: rows });
});

authRoutes.post('/tokens', requireAuth('full'), async (c) => {
  const body = z
    .object({
      name: z.string().min(1).max(60),
      scope: z.enum(['capture', 'read', 'full']).default('capture'),
    })
    .parse(await c.req.json());

  const token = await createApiToken(
    c.get('db'),
    c.get('auth').userId,
    body.name,
    body.scope,
  );

  return c.json({ ok: true, token });
});

authRoutes.delete('/tokens/:id', requireAuth('full'), async (c) => {
  await c
    .get('db')
    .update(apiTokens)
    .set({ revokedAt: Date.now() })
    .where(eq(apiTokens.id, c.req.param('id')));

  return c.json({ ok: true });
});
