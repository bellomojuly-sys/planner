import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, ne } from 'drizzle-orm';
import type { AppBindings } from '../auth/middleware';
import { requireAuth } from '../auth/middleware';
import { tasks, taskDependencies, AREAS, ENERGY } from '../db/schema';
import { applyLearning } from '../scheduler/estimate';
import { replan } from '../services/planner';
import { drainOutbox } from '../services/outbox';
import { PlannerError } from '../lib/errors';

export const taskRoutes = new Hono<AppBindings>();

taskRoutes.use('*', requireAuth('read'));

taskRoutes.get('/', async (c) => {
  const db = c.get('db');
  const { userId } = c.get('auth');

  const query = z
    .object({
      status: z.string().optional(),
      area: z.enum(AREAS).optional(),
      limit: z.coerce.number().min(1).max(500).default(200),
    })
    .parse(Object.fromEntries(new URL(c.req.url).searchParams));

  const rows = await db
    .select()
    .from(tasks)
    .where(
      query.status
        ? and(eq(tasks.userId, userId), eq(tasks.status, query.status as never))
        : and(eq(tasks.userId, userId), ne(tasks.status, 'cancelled')),
    )
    .orderBy(desc(tasks.updatedAt))
    .limit(query.limit);

  const filtered = query.area ? rows.filter((t) => t.area === query.area) : rows;
  return c.json({ tasks: filtered });
});

const TaskInput = z.object({
  title: z.string().min(1).max(300),
  notes: z.string().max(4000).optional(),
  area: z.enum(AREAS).default('general'),
  energy: z.enum(ENERGY).default('medium'),
  priority: z.number().int().min(1).max(4).default(3),
  estimatedMinutes: z.number().int().min(5).max(600).default(30),
  location: z.string().max(200).nullable().optional(),
  travelMinutes: z.number().int().min(0).max(240).default(0),
  preparationMinutes: z.number().int().min(0).max(240).default(0),
  recoveryMinutes: z.number().int().min(0).max(240).default(0),
  flexibility: z.enum(['fixed', 'low', 'medium', 'high']).default('high'),
  dueAt: z.number().int().nullable().optional(),
  splittable: z.boolean().default(true),
  isGym: z.boolean().default(false),
});

taskRoutes.post('/', requireAuth('full'), async (c) => {
  const db = c.get('db');
  const { userId } = c.get('auth');
  const body = TaskInput.parse(await c.req.json());

  const learned = await applyLearning(db, userId, {
    area: body.area,
    energy: body.energy,
    title: body.title,
    estimatedMinutes: body.estimatedMinutes,
  });

  const [created] = await db
    .insert(tasks)
    .values({
      userId,
      ...body,
      notes: body.notes ?? null,
      dueAt: body.dueAt ?? null,
      plannedMinutes: learned.plannedMinutes,
      estimateSource: 'user',
      estimateConfidence: learned.confidence,
      dirty: true,
    })
    .returning();

  await replan(c.env, db, userId, body.priority === 1 ? 'urgent_task' : 'manual');
  await drainOutbox(c.env, db);

  return c.json({ ok: true, task: created, adjustment: learned });
});

taskRoutes.patch('/:id', requireAuth('full'), async (c) => {
  const db = c.get('db');
  const { userId } = c.get('auth');
  const id = c.req.param('id');

  const body = TaskInput.partial()
    .extend({
      status: z
        .enum([
          'inbox',
          'todo',
          'scheduled',
          'in_progress',
          'done',
          'skipped',
          'postponed',
          'cancelled',
        ])
        .optional(),
    })
    .parse(await c.req.json());

  const existing = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, id), eq(tasks.userId, userId)),
  });
  if (!existing) throw new PlannerError('not_found');

  // Any change to the inputs of the estimate invalidates the planned duration.
  const shouldRecompute =
    body.estimatedMinutes !== undefined ||
    body.area !== undefined ||
    body.energy !== undefined;

  const learned = shouldRecompute
    ? await applyLearning(db, userId, {
        area: body.area ?? existing.area,
        energy: body.energy ?? existing.energy,
        title: body.title ?? existing.title,
        estimatedMinutes: body.estimatedMinutes ?? existing.estimatedMinutes,
      })
    : null;

  await db
    .update(tasks)
    .set({
      ...body,
      ...(learned ? { plannedMinutes: learned.plannedMinutes, estimateSource: 'user' as const } : {}),
      dirty: true,
    })
    .where(eq(tasks.id, id));

  const diff = await replan(c.env, db, userId, 'manual');
  await drainOutbox(c.env, db);

  return c.json({ ok: true, diff });
});

taskRoutes.delete('/:id', requireAuth('full'), async (c) => {
  const db = c.get('db');
  const { userId } = c.get('auth');

  await db
    .update(tasks)
    .set({ status: 'cancelled' })
    .where(and(eq(tasks.id, c.req.param('id')), eq(tasks.userId, userId)));

  await replan(c.env, db, userId, 'manual');
  await drainOutbox(c.env, db);

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

taskRoutes.post('/:id/dependencies', requireAuth('full'), async (c) => {
  const db = c.get('db');
  const { userId } = c.get('auth');
  const taskId = c.req.param('id');

  const body = z
    .object({
      dependsOnId: z.string(),
      lagMinutes: z.number().int().min(0).max(10080).default(0),
    })
    .parse(await c.req.json());

  if (body.dependsOnId === taskId) {
    throw new PlannerError('bad_request', {
      userMessage: "Un'attività non può dipendere da sé stessa.",
    });
  }

  // Reject the edge if the reverse path already exists: a cycle would leave
  // both tasks permanently unschedulable.
  if (await createsCycle(db, userId, taskId, body.dependsOnId)) {
    throw new PlannerError('bad_request', {
      userMessage: 'Questa dipendenza creerebbe un ciclo.',
    });
  }

  await db
    .insert(taskDependencies)
    .values({ userId, taskId, dependsOnId: body.dependsOnId, lagMinutes: body.lagMinutes })
    .onConflictDoNothing();

  const diff = await replan(c.env, db, userId, 'dependency_cascade');
  await drainOutbox(c.env, db);

  return c.json({ ok: true, diff });
});

taskRoutes.delete('/:id/dependencies/:dependsOnId', requireAuth('full'), async (c) => {
  const db = c.get('db');
  const { userId } = c.get('auth');

  await db
    .delete(taskDependencies)
    .where(
      and(
        eq(taskDependencies.userId, userId),
        eq(taskDependencies.taskId, c.req.param('id')),
        eq(taskDependencies.dependsOnId, c.req.param('dependsOnId')),
      ),
    );

  const diff = await replan(c.env, db, userId, 'dependency_cascade');
  return c.json({ ok: true, diff });
});

/** Walks forward from `dependsOnId` looking for `taskId`. */
async function createsCycle(
  db: AppBindings['Variables']['db'],
  userId: string,
  taskId: string,
  dependsOnId: string,
): Promise<boolean> {
  const edges = await db
    .select()
    .from(taskDependencies)
    .where(eq(taskDependencies.userId, userId));

  const prerequisites = new Map<string, string[]>();
  for (const e of edges) {
    const list = prerequisites.get(e.taskId) ?? [];
    list.push(e.dependsOnId);
    prerequisites.set(e.taskId, list);
  }

  const seen = new Set<string>();
  const queue = [dependsOnId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === taskId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...(prerequisites.get(current) ?? []));
  }

  return false;
}
