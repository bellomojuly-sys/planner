import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { AppBindings } from '../auth/middleware';
import { requireAuth } from '../auth/middleware';
import { createPinCredentials, setPin, verifyPin } from '../auth/pin';
import {
  SESSION_COOKIE,
  attachSessionCookie,
  clearSessionCookie,
  createApiToken,
  createSession,
  prepareApiToken,
  prepareSession,
  getSoleUser,
  revokeSession,
  authenticate,
} from '../auth/session';
import { users, settings, apiTokens, sessions } from '../db/schema';
import { PlannerError } from '../lib/errors';

export const authRoutes = new Hono<AppBindings>();

/**
 * First-run setup. Only possible while no user exists, so the endpoint cannot
 * be used to create a second account or reset an existing PIN.
 */
authRoutes.post('/setup', async (c) => {
  const db = c.get('db');
  const body = z
    .object({
      email: z.string().email(),
      displayName: z.string().min(1).max(80),
      pin: z.string(),
      timezone: z.string().default('Europe/Rome'),
    })
    .parse(await c.req.json());

  const existing = await db.select().from(users).limit(2);
  if (existing.length > 1 || existing[0]?.pinHash) {
    throw new PlannerError('conflict', {
      userMessage: 'La configurazione è già stata completata.',
    });
  }
  if (
    existing[0] &&
    existing[0].email.trim().toLowerCase() !== body.email.trim().toLowerCase()
  ) {
    throw new PlannerError('conflict', {
      userMessage: 'La configurazione incompleta appartiene a un’altra email.',
    });
  }

  // Derive every secret before the first write, then commit the complete
  // identity, settings, capture token and browser session as one D1 batch.
  // This also safely resumes a setup interrupted by an older deployment.
  const userId = existing[0]?.id ?? crypto.randomUUID();
  const pinCredentials = await createPinCredentials(body.pin, c.env.MASTER_KEY);
  const capture = await prepareApiToken(
    userId,
    'iPhone Action Button',
    'capture',
  );
  const session = await prepareSession(userId, c.req.header('user-agent'));

  const userWrite = existing[0]
    ? db
        .update(users)
        .set({
          email: body.email,
          displayName: body.displayName,
          timezone: body.timezone,
          ...pinCredentials,
          failedPinAttempts: 0,
          lockedUntil: null,
        })
        .where(eq(users.id, userId))
    : db.insert(users).values({
        id: userId,
        email: body.email,
        displayName: body.displayName,
        timezone: body.timezone,
        ...pinCredentials,
      });

  await db.batch([
    userWrite,
    db.insert(settings).values({ userId }).onConflictDoNothing(),
    db.insert(apiTokens).values(capture.values),
    db.insert(sessions).values(session.values),
  ] as const);

  attachSessionCookie(c, session.token, session.expiresAt);

  return c.json({
    ok: true,
    userId,
    // Shown once — this is what goes into the iOS Shortcut.
    captureToken: capture.token,
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
  const result = await verifyPin(db, user.id, body.pin, c.env.MASTER_KEY);

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

  const check = await verifyPin(db, userId, body.currentPin, c.env.MASTER_KEY);
  if (!check.ok) throw new PlannerError('unauthorized', { userMessage: 'PIN attuale errato.' });

  await setPin(db, userId, body.newPin, c.env.MASTER_KEY);
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
