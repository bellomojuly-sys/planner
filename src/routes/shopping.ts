import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import type { AppBindings } from '../auth/middleware';
import { requireAuth } from '../auth/middleware';
import { shoppingItems } from '../db/schema';
import { PlannerError } from '../lib/errors';

export const shoppingRoutes = new Hono<AppBindings>();

shoppingRoutes.use('*', requireAuth('read'));

const ItemInput = z.object({
  name: z.string().min(1).max(200),
  quantity: z.number().min(0.1).max(1000).default(1),
  unit: z.string().max(20).default('pz'),
  category: z.string().max(50).default('altro'),
  store: z.string().max(100).nullable().optional(),
  url: z.string().url().max(2000).nullable().optional(),
  estimatedPrice: z.number().min(0).max(100000).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  urgent: z.boolean().default(false),
});

shoppingRoutes.get('/', async (c) => {
  const db = c.get('db');
  const { userId } = c.get('auth');

  const query = z
    .object({ status: z.enum(['open', 'bought', 'cancelled', 'all']).default('open') })
    .parse(Object.fromEntries(new URL(c.req.url).searchParams));

  const rows = await db
    .select()
    .from(shoppingItems)
    .where(
      query.status === 'all'
        ? eq(shoppingItems.userId, userId)
        : and(eq(shoppingItems.userId, userId), eq(shoppingItems.status, query.status)),
    )
    .orderBy(desc(shoppingItems.urgent), desc(shoppingItems.createdAt))
    .limit(300);

  // Grouped by category so the list matches the order aisles are walked.
  const byCategory = new Map<string, typeof rows>();
  for (const item of rows) {
    const list = byCategory.get(item.category) ?? [];
    list.push(item);
    byCategory.set(item.category, list);
  }

  return c.json({
    items: rows,
    groups: [...byCategory.entries()]
      .map(([category, items]) => ({ category, items }))
      .sort((a, b) => a.category.localeCompare(b.category, 'it')),
  });
});

shoppingRoutes.post('/', requireAuth('full'), async (c) => {
  const db = c.get('db');
  const { userId } = c.get('auth');
  const body = ItemInput.parse(await c.req.json());

  const [created] = await db
    .insert(shoppingItems)
    .values({
      userId,
      ...body,
      store: body.store ?? null,
      url: body.url ?? null,
      estimatedPrice: body.estimatedPrice ?? null,
      notes: body.notes ?? null,
    })
    .returning();

  return c.json({ ok: true, item: created });
});

shoppingRoutes.patch('/:id', requireAuth('full'), async (c) => {
  const db = c.get('db');
  const { userId } = c.get('auth');

  const body = ItemInput.partial()
    .extend({ status: z.enum(['open', 'bought', 'cancelled']).optional() })
    .parse(await c.req.json());

  const existing = await db.query.shoppingItems.findFirst({
    where: and(eq(shoppingItems.id, c.req.param('id')), eq(shoppingItems.userId, userId)),
  });
  if (!existing) throw new PlannerError('not_found');

  await db
    .update(shoppingItems)
    .set({
      ...body,
      completedAt:
        body.status === 'bought'
          ? Date.now()
          : body.status
            ? null
            : existing.completedAt,
    })
    .where(eq(shoppingItems.id, existing.id));

  return c.json({ ok: true });
});

shoppingRoutes.delete('/:id', requireAuth('full'), async (c) => {
  await c
    .get('db')
    .delete(shoppingItems)
    .where(
      and(
        eq(shoppingItems.id, c.req.param('id')),
        eq(shoppingItems.userId, c.get('auth').userId),
      ),
    );
  return c.json({ ok: true });
});

/** Clears the bought items once the shopping trip is over. */
shoppingRoutes.post('/clear-bought', requireAuth('full'), async (c) => {
  const deleted = await c
    .get('db')
    .delete(shoppingItems)
    .where(
      and(
        eq(shoppingItems.userId, c.get('auth').userId),
        eq(shoppingItems.status, 'bought'),
      ),
    )
    .returning({ id: shoppingItems.id });

  return c.json({ ok: true, removed: deleted.length });
});
