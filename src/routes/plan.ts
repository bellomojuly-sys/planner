import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, gte, lte, ne, desc } from 'drizzle-orm';
import type { AppBindings } from '../auth/middleware';
import { requireAuth } from '../auth/middleware';
import {
  scheduledBlocks,
  calendarEvents,
  tasks,
  taskDependencies,
  scheduleRuns,
} from '../db/schema';
import { replan, moveBlock, unpinBlock } from '../services/planner';
import { drainOutbox } from '../services/outbox';
import { recordCompletion } from '../scheduler/estimate';
import { loadAgenda } from '../jobs/daily';
import { DAY_MS, startOfLocalDay, addLocalDays } from '../lib/time';
import { PlannerError } from '../lib/errors';

export const planRoutes = new Hono<AppBindings>();

planRoutes.use('*', requireAuth('read'));

/**
 * The calendar view's data source. Returns fixed events and planner blocks in
 * one payload so the client can render a single timeline without joining.
 */
planRoutes.get('/', async (c) => {
  const db = c.get('db');
  const { userId } = c.get('auth');
  const tz = c.env.APP_TIMEZONE;

  const query = z
    .object({
      from: z.coerce.number().optional(),
      days: z.coerce.number().min(1).max(30).default(7),
    })
    .parse(Object.fromEntries(new URL(c.req.url).searchParams));

  const from = startOfLocalDay(query.from ?? Date.now(), tz);
  const to = addLocalDays(from, tz, query.days);

  const [blocks, events, lastRun] = await Promise.all([
    db
      .select()
      .from(scheduledBlocks)
      .where(
        and(
          eq(scheduledBlocks.userId, userId),
          gte(scheduledBlocks.endAt, from),
          lte(scheduledBlocks.startAt, to),
        ),
      ),
    db
      .select()
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.userId, userId),
          gte(calendarEvents.endAt, from),
          lte(calendarEvents.startAt, to),
        ),
      ),
    db
      .select()
      .from(scheduleRuns)
      .where(eq(scheduleRuns.userId, userId))
      .orderBy(desc(scheduleRuns.startedAt))
      .limit(1),
  ]);

  const taskIds = [...new Set(blocks.map((b) => b.taskId).filter(Boolean))] as string[];
  const taskRows =
    taskIds.length > 0
      ? await db.select().from(tasks).where(eq(tasks.userId, userId))
      : [];
  const tasksById = new Map(taskRows.map((t) => [t.id, t]));

  return c.json({
    range: { from, to, timezone: tz },
    blocks: blocks
      .map((b) => {
        const task = b.taskId ? tasksById.get(b.taskId) : undefined;
        return {
          id: b.id,
          taskId: b.taskId,
          title: b.title,
          start: b.startAt,
          end: b.endAt,
          kind: b.kind,
          pinned: b.pinned,
          partIndex: b.partIndex,
          partCount: b.partCount,
          syncState: b.syncState,
          area: task?.area ?? null,
          energy: task?.energy ?? null,
          priority: task?.priority ?? null,
        };
      })
      .sort((a, b) => a.start - b.start),
    events: events
      .filter((e) => !e.cancelled)
      .map((e) => ({
        id: e.id,
        title: e.title,
        start: e.startAt,
        end: e.endAt,
        allDay: e.allDay,
        kind: e.kind,
        isShift: e.isShift,
        location: e.location,
      }))
      .sort((a, b) => a.start - b.start),
    lastRun: lastRun[0]
      ? {
          trigger: lastRun[0].trigger,
          status: lastRun[0].status,
          at: lastRun[0].startedAt,
          summary: lastRun[0].summary,
        }
      : null,
  });
});

/** Today's plan in briefing form, for the home screen and the widget. */
planRoutes.get('/today', async (c) => {
  const agenda = await loadAgenda(
    c.get('db'),
    c.get('auth').userId,
    c.env.APP_TIMEZONE,
    Date.now(),
  );
  return c.json(agenda);
});

planRoutes.post('/replan', requireAuth('full'), async (c) => {
  const diff = await replan(c.env, c.get('db'), c.get('auth').userId, 'manual');
  // Push the resulting calendar writes now rather than waiting for the cron,
  // so the user sees Google update while the app is still open.
  await drainOutbox(c.env, c.get('db'));
  return c.json({ ok: true, diff });
});

/**
 * Manual drag. Pins the block and cascades dependents — the core of
 * "if Phase 15 moves, 16, 17 and 18 move accordingly".
 */
planRoutes.patch('/blocks/:id', requireAuth('full'), async (c) => {
  const body = z
    .object({ start: z.number().int(), end: z.number().int() })
    .parse(await c.req.json());

  if (body.end <= body.start) {
    throw new PlannerError('bad_request', {
      userMessage: "L'orario di fine deve essere dopo quello di inizio.",
    });
  }

  const diff = await moveBlock(
    c.env,
    c.get('db'),
    c.get('auth').userId,
    c.req.param('id'),
    body.start,
    body.end,
  );
  await drainOutbox(c.env, c.get('db'));

  return c.json({ ok: true, diff });
});

planRoutes.post('/blocks/:id/unpin', requireAuth('full'), async (c) => {
  const diff = await unpinBlock(
    c.env,
    c.get('db'),
    c.get('auth').userId,
    c.req.param('id'),
  );
  await drainOutbox(c.env, c.get('db'));
  return c.json({ ok: true, diff });
});

/**
 * Marking a block done from the calendar. `actualMinutes` defaults to the
 * block's own length, which is the honest reading when Giulia does not say
 * otherwise — and it is what feeds the estimate model.
 */
planRoutes.post('/blocks/:id/complete', requireAuth('full'), async (c) => {
  const db = c.get('db');
  const { userId } = c.get('auth');

  const body = z
    .object({ actualMinutes: z.number().int().min(1).max(1440).optional() })
    .parse(await c.req.json().catch(() => ({})));

  const block = await db.query.scheduledBlocks.findFirst({
    where: and(eq(scheduledBlocks.id, c.req.param('id')), eq(scheduledBlocks.userId, userId)),
  });
  if (!block) throw new PlannerError('not_found');

  if (!block.taskId) {
    // A gym block has no task behind it; completing it just removes it.
    await db.delete(scheduledBlocks).where(eq(scheduledBlocks.id, block.id));
    return c.json({ ok: true });
  }

  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, block.taskId) });
  if (!task) throw new PlannerError('not_found');

  const actual =
    body.actualMinutes ?? Math.round((block.endAt - block.startAt) / 60_000);

  await db
    .update(tasks)
    .set({ status: 'done', completedAt: Date.now(), dirty: true })
    .where(eq(tasks.id, task.id));

  await recordCompletion(db, userId, task, actual);

  const diff = await replan(c.env, db, userId, 'dependency_cascade');
  await drainOutbox(c.env, db);

  return c.json({ ok: true, actualMinutes: actual, diff });
});

/** Dependency graph, for the "why is this here?" panel. */
planRoutes.get('/dependencies', async (c) => {
  const db = c.get('db');
  const { userId } = c.get('auth');

  const [edges, openTasks] = await Promise.all([
    db.select().from(taskDependencies).where(eq(taskDependencies.userId, userId)),
    db
      .select({ id: tasks.id, title: tasks.title, status: tasks.status })
      .from(tasks)
      .where(and(eq(tasks.userId, userId), ne(tasks.status, 'cancelled'))),
  ]);

  return c.json({ edges, tasks: openTasks });
});

export { DAY_MS };
