import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { AppBindings } from '../auth/middleware';
import { requireAuth } from '../auth/middleware';
import {
  settings as settingsTable,
  taskSources,
  pushSubscriptions,
  estimateModel,
  captures,
  AREAS,
} from '../db/schema';
import * as notion from '../integrations/notion';
import { checkIntegrations } from '../services/integration-check';
import { sealJson } from '../crypto/encryption';
import { replan } from '../services/planner';
import { syncNotion, syncCalendars } from '../services/sync';
import {
  discoverCalendarSources,
  loadCalendarSources,
  updateCalendarSource,
  addIcsSource,
  redactSource,
} from '../services/calendar-sources';
import { drainOutbox } from '../services/outbox';
import { estimateAccuracy } from '../scheduler/estimate';
import { requireSecret } from '../env';
import { PlannerError } from '../lib/errors';

export const settingsRoutes = new Hono<AppBindings>();

settingsRoutes.use('*', requireAuth('read'));

settingsRoutes.get('/', async (c) => {
  const db = c.get('db');
  const { userId } = c.get('auth');

  let prefs = await db.query.settings.findFirst({
    where: eq(settingsTable.userId, userId),
  });
  if (!prefs) [prefs] = await db.insert(settingsTable).values({ userId }).returning();

  const [sources, calendars, accuracy] = await Promise.all([
    db.select().from(taskSources).where(eq(taskSources.userId, userId)),
    loadCalendarSources(db, userId),
    estimateAccuracy(db, userId),
  ]);

  return c.json({
    settings: prefs,
    sources,
    calendars: calendars.map(redactSource),
    accuracy,
    integrations: {
      notion: Boolean(c.env.NOTION_TOKEN),
      google: Boolean(c.env.GOOGLE_REFRESH_TOKEN),
      voice: Boolean(c.env.DEEPSEEK_API_KEY),
      push: Boolean(c.env.VAPID_PUBLIC_KEY),
    },
  });
});

/**
 * Live connectivity test. Separate from GET /settings because it makes real
 * outbound calls: the settings screen must stay fast, and this only runs when
 * asked.
 */
settingsRoutes.get('/integrations/check', requireAuth('full'), async (c) => {
  return c.json({ checks: await checkIntegrations(c.env) });
});

settingsRoutes.patch('/', requireAuth('full'), async (c) => {
  const body = z
    .object({
      dayStartMinutes: z.number().int().min(0).max(1439).optional(),
      dayEndMinutes: z.number().int().min(0).max(1439).optional(),
      morningEndMinutes: z.number().int().min(0).max(1439).optional(),
      afternoonEndMinutes: z.number().int().min(0).max(1439).optional(),
      minBlockMinutes: z.number().int().min(5).max(240).optional(),
      maxBlockMinutes: z.number().int().min(15).max(480).optional(),
      breakMinutes: z.number().int().min(0).max(120).optional(),
      bufferAroundEventsMinutes: z.number().int().min(0).max(120).optional(),
      gymSessionsPerWeek: z.number().int().min(0).max(7).optional(),
      gymDurationMinutes: z.number().int().min(15).max(240).optional(),
      gymPreferredDays: z.string().max(20).optional(),
      briefingMinutes: z.number().int().min(0).max(1439).optional(),
      reviewMinutes: z.number().int().min(0).max(1439).optional(),
      reviewAfterShiftMinutes: z.number().int().min(0).max(240).optional(),
      fixedEventKeywords: z.string().max(500).optional(),
      planningHorizonDays: z.number().int().min(1).max(60).optional(),
      autoRescheduleEnabled: z.boolean().optional(),
      pushEnabled: z.boolean().optional(),
    })
    .parse(await c.req.json());

  // The zone boundaries must stay ordered, or slot generation produces
  // zero-length or negative zones.
  const merged = { ...body };
  if (
    merged.dayStartMinutes !== undefined &&
    merged.dayEndMinutes !== undefined &&
    merged.dayEndMinutes <= merged.dayStartMinutes
  ) {
    throw new PlannerError('bad_request', {
      userMessage: 'La fine della giornata deve essere dopo l’inizio.',
    });
  }

  await c
    .get('db')
    .update(settingsTable)
    .set(merged)
    .where(eq(settingsTable.userId, c.get('auth').userId));

  const diff = await replan(c.env, c.get('db'), c.get('auth').userId, 'manual');
  await drainOutbox(c.env, c.get('db'));

  return c.json({ ok: true, diff });
});

// ---------------------------------------------------------------------------
// Notion databases — adding University and Heemia later happens here
// ---------------------------------------------------------------------------

settingsRoutes.get('/notion/databases', requireAuth('full'), async (c) => {
  const databases = await notion.listAccessibleDatabases(
    requireSecret(c.env, 'NOTION_TOKEN'),
  );
  return c.json({ databases });
});

settingsRoutes.get('/notion/databases/:id', requireAuth('full'), async (c) => {
  const token = requireSecret(c.env, 'NOTION_TOKEN');
  const info = await notion.describeDatabase(token, c.req.param('id'));
  return c.json({ database: info, suggestedMap: notion.guessPropertyMap(info) });
});

settingsRoutes.post('/sources', requireAuth('full'), async (c) => {
  const db = c.get('db');
  const { userId } = c.get('auth');

  const body = z
    .object({
      externalId: z.string().min(1),
      name: z.string().min(1).max(100),
      area: z.enum(AREAS),
      color: z.string().max(20).default('#7c8cf8'),
      propertyMap: z.record(z.string(), z.unknown()).optional(),
    })
    .parse(await c.req.json());

  const token = requireSecret(c.env, 'NOTION_TOKEN');
  const info = await notion.describeDatabase(token, body.externalId);

  const [created] = await db
    .insert(taskSources)
    .values({
      userId,
      provider: 'notion',
      externalId: body.externalId,
      name: body.name,
      area: body.area,
      color: body.color,
      // A supplied map wins; otherwise infer it from the database schema so
      // adding a source is one click.
      propertyMap: (body.propertyMap as never) ?? notion.guessPropertyMap(info),
    })
    .returning();

  const report = await syncNotion(c.env, db, userId);
  await replan(c.env, db, userId, 'manual', { syncErrors: report.errors });
  await drainOutbox(c.env, db);

  return c.json({ ok: true, source: created, sync: report });
});

settingsRoutes.patch('/sources/:id', requireAuth('full'), async (c) => {
  const body = z
    .object({
      name: z.string().max(100).optional(),
      area: z.enum(AREAS).optional(),
      color: z.string().max(20).optional(),
      enabled: z.boolean().optional(),
      propertyMap: z.record(z.string(), z.unknown()).optional(),
    })
    .parse(await c.req.json());

  await c
    .get('db')
    .update(taskSources)
    .set(body as never)
    .where(
      and(
        eq(taskSources.id, c.req.param('id')),
        eq(taskSources.userId, c.get('auth').userId),
      ),
    );

  return c.json({ ok: true });
});

settingsRoutes.delete('/sources/:id', requireAuth('full'), async (c) => {
  await c
    .get('db')
    .delete(taskSources)
    .where(
      and(
        eq(taskSources.id, c.req.param('id')),
        eq(taskSources.userId, c.get('auth').userId),
      ),
    );
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------

settingsRoutes.get('/google/calendars', requireAuth('full'), async (c) => {
  const calendars = await loadCalendarSources(
    c.get('db'),
    c.get('auth').userId,
  );
  return c.json({ calendars: calendars.map(redactSource) });
});

settingsRoutes.post('/calendars/ics', requireAuth('full'), async (c) => {
  const body = z
    .object({
      url: z.string().min(8),
      name: z.string().min(1).max(60),
      role: z.enum(['busy', 'context', 'ignore']).default('busy'),
    })
    .parse(await c.req.json());

  const db = c.get('db');
  const { userId } = c.get('auth');
  const calendar = await addIcsSource(db, userId, body);

  const sync = await syncCalendars(c.env, db, userId);
  const diff = await replan(c.env, db, userId, 'calendar_change', {
    syncErrors: sync.errors,
  });
  await drainOutbox(c.env, db);

  return c.json({ ok: true, calendar: redactSource(calendar), sync, diff });
});

settingsRoutes.post('/google/calendars/discover', requireAuth('full'), async (c) => {
  const calendars = await discoverCalendarSources(
    c.env,
    c.get('db'),
    c.get('auth').userId,
  );
  return c.json({ ok: true, calendars });
});

settingsRoutes.patch('/google/calendars/:id', requireAuth('full'), async (c) => {
  const body = z
    .object({
      role: z.enum(['busy', 'context', 'ignore', 'planner']).optional(),
      enabled: z.boolean().optional(),
      color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
    })
    .refine((value) => Object.keys(value).length > 0)
    .parse(await c.req.json());

  const db = c.get('db');
  const { userId } = c.get('auth');
  const calendar = await updateCalendarSource(
    db,
    userId,
    c.req.param('id'),
    body,
  );

  let sync = null;
  let diff = null;
  if (body.role !== undefined || body.enabled !== undefined) {
    sync = await syncCalendars(c.env, db, userId);
    diff = await replan(c.env, db, userId, 'calendar_change', {
      syncErrors: sync.errors,
    });
  }

  await drainOutbox(c.env, db);
  return c.json({
    ok: true,
    calendar: calendar ? redactSource(calendar) : null,
    sync,
    diff,
  });
});

settingsRoutes.post('/sync', requireAuth('full'), async (c) => {
  const db = c.get('db');
  const { userId } = c.get('auth');

  const [notionReport, calendarReport] = await Promise.all([
    syncNotion(c.env, db, userId),
    syncCalendars(c.env, db, userId),
  ]);

  const errors = [...notionReport.errors, ...calendarReport.errors];
  const diff =
    errors.length > 0 || notionReport.changed || calendarReport.changed
      ? await replan(c.env, db, userId, 'manual', { syncErrors: errors })
      : null;

  await drainOutbox(c.env, db);

  return c.json({ ok: true, notion: notionReport, calendar: calendarReport, diff });
});

// ---------------------------------------------------------------------------
// Push notifications
// ---------------------------------------------------------------------------

settingsRoutes.get('/push/key', async (c) => {
  if (!c.env.VAPID_PUBLIC_KEY) {
    throw new PlannerError('config_missing', {
      userMessage: 'Le notifiche non sono configurate.',
    });
  }
  return c.json({ publicKey: c.env.VAPID_PUBLIC_KEY });
});

settingsRoutes.post('/push/subscribe', requireAuth('full'), async (c) => {
  const db = c.get('db');
  const { userId } = c.get('auth');

  const body = z
    .object({
      endpoint: z.string().url(),
      keys: z.object({ p256dh: z.string(), auth: z.string() }),
    })
    .parse(await c.req.json());

  // The subscription keys are as sensitive as a credential — anyone holding
  // them can push to the device — so they are encrypted at rest like the rest.
  const sealed = await sealJson(body.keys, c.env.MASTER_KEY);

  await db
    .insert(pushSubscriptions)
    .values({
      userId,
      endpoint: body.endpoint,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
    })
    .onConflictDoUpdate({
      target: [pushSubscriptions.userId, pushSubscriptions.endpoint],
      set: { ciphertext: sealed.ciphertext, iv: sealed.iv, failureCount: 0 },
    });

  return c.json({ ok: true });
});

settingsRoutes.post('/push/unsubscribe', requireAuth('full'), async (c) => {
  const body = z.object({ endpoint: z.string().url() }).parse(await c.req.json());

  await c
    .get('db')
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.userId, c.get('auth').userId),
        eq(pushSubscriptions.endpoint, body.endpoint),
      ),
    );

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------

/** What the estimator has learned, so the numbers are never a black box. */
settingsRoutes.get('/learning', async (c) => {
  const db = c.get('db');
  const { userId } = c.get('auth');

  const buckets = await db
    .select()
    .from(estimateModel)
    .where(eq(estimateModel.userId, userId));

  return c.json({
    accuracy: await estimateAccuracy(db, userId),
    buckets: buckets.sort((a, b) => b.sampleCount - a.sampleCount),
  });
});

/** Recent voice captures, for auditing what the model understood. */
settingsRoutes.get('/captures', async (c) => {
  const rows = await c
    .get('db')
    .select({
      id: captures.id,
      status: captures.status,
      source: captures.source,
      appliedSummary: captures.appliedSummary,
      error: captures.error,
      createdAt: captures.createdAt,
    })
    .from(captures)
    .where(eq(captures.userId, c.get('auth').userId))
    .limit(50);

  // Deliberately omits the ciphertext: the raw speech is not needed to audit
  // what happened, and not decrypting it keeps the blast radius small.
  return c.json({ captures: rows.sort((a, b) => b.createdAt - a.createdAt) });
});
