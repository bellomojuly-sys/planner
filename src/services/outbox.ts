import { and, asc, eq, lte } from 'drizzle-orm';
import type { DB } from '../db/client';
import {
  outbox,
  scheduledBlocks,
  tasks,
  taskSources,
  pushSubscriptions,
} from '../db/schema';
import { upsertPlannerEvent, deletePlannerEvent } from '../integrations/google-calendar';
import * as notion from '../integrations/notion';
import { sendPush, type PushPayload } from '../push/webpush';
import { openJson } from '../crypto/encryption';
import { toPlannerError } from '../lib/errors';
import { requireSecret, type Env } from '../env';

/**
 * Durable outbound work. Every write to Notion, Google or a push service goes
 * through here rather than happening inline.
 *
 * The reason is failure isolation: a Notion outage during a voice capture must
 * not lose the capture, and a Google 503 during a reschedule must not roll
 * back a correct plan. The local database is the source of truth; the outbox
 * catches the rest up, with exponential backoff, whenever the upstream returns.
 */

const MAX_ATTEMPTS = 6;
const BASE_BACKOFF_MS = 30_000;

export interface OutboxReport {
  processed: number;
  failed: number;
  dead: number;
}

export async function drainOutbox(
  env: Env,
  db: DB,
  limit = 25,
): Promise<OutboxReport> {
  const report: OutboxReport = { processed: 0, failed: 0, dead: 0 };

  const ready = await db
    .select()
    .from(outbox)
    .where(and(eq(outbox.status, 'pending'), lte(outbox.nextAttemptAt, Date.now())))
    .orderBy(asc(outbox.nextAttemptAt))
    .limit(limit);

  for (const job of ready) {
    try {
      await runJob(env, db, job);
      await db
        .update(outbox)
        .set({ status: 'done', lastError: null })
        .where(eq(outbox.id, job.id));
      report.processed++;
    } catch (err) {
      const pe = toPlannerError(err);
      const attempts = job.attempts + 1;

      // Non-retryable failures die immediately: retrying a 400 forever just
      // fills the queue and hides the real problem.
      const dead = attempts >= MAX_ATTEMPTS || !pe.retryable;

      await db
        .update(outbox)
        .set({
          attempts,
          status: dead ? 'dead' : 'pending',
          lastError: pe.message.slice(0, 500),
          nextAttemptAt:
            Date.now() +
            Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), 30 * 60_000),
        })
        .where(eq(outbox.id, job.id));

      if (dead) report.dead++;
      else report.failed++;
    }
  }

  return report;
}

async function runJob(
  env: Env,
  db: DB,
  job: typeof outbox.$inferSelect,
): Promise<void> {
  switch (job.kind) {
    case 'google_upsert':
      return googleUpsert(env, db, job);
    case 'google_delete':
      return googleDelete(env, job);
    case 'notion_upsert':
      return notionUpsert(env, db, job);
    case 'notion_complete':
      return notionComplete(env, db, job);
    case 'push':
      return pushJob(env, db, job);
  }
}

async function googleUpsert(
  env: Env,
  db: DB,
  job: typeof outbox.$inferSelect,
): Promise<void> {
  const { blockId, calendarId } = job.payload as {
    blockId: string;
    calendarId: string;
  };

  const block = await db.query.scheduledBlocks.findFirst({
    where: eq(scheduledBlocks.id, blockId),
  });
  // The block may have been removed by a later replan; nothing to push.
  if (!block) return;

  const eventId = await upsertPlannerEvent(
    env,
    calendarId,
    {
      blockId: block.id,
      title: block.kind === 'gym' ? `🏋️ ${block.title}` : block.title,
      startAt: block.startAt,
      endAt: block.endAt,
      colorId: block.kind === 'gym' ? '10' : '7',
    },
    block.googleEventId,
    env.APP_TIMEZONE,
  );

  await db
    .update(scheduledBlocks)
    .set({ googleEventId: eventId, syncState: 'synced', syncError: null })
    .where(eq(scheduledBlocks.id, blockId));
}

async function googleDelete(
  env: Env,
  job: typeof outbox.$inferSelect,
): Promise<void> {
  const { eventId, calendarId } = job.payload as {
    eventId: string;
    calendarId: string;
  };
  await deletePlannerEvent(env, calendarId, eventId);
}

async function notionUpsert(
  env: Env,
  db: DB,
  job: typeof outbox.$inferSelect,
): Promise<void> {
  const { taskId, sourceId } = job.payload as { taskId: string; sourceId: string };

  const [task, source] = await Promise.all([
    db.query.tasks.findFirst({ where: eq(tasks.id, taskId) }),
    db.query.taskSources.findFirst({ where: eq(taskSources.id, sourceId) }),
  ]);

  if (!task || !source?.externalId) return;
  // Already mirrored — a retry must not create a second Notion page.
  if (task.externalId) return;

  const externalId = await notion.createTask(
    requireSecret(env, 'NOTION_TOKEN'),
    source.externalId,
    source.propertyMap,
    {
      title: task.title,
      notes: task.notes,
      dueAt: task.dueAt,
      estimatedMinutes: task.estimatedMinutes,
      area: task.area,
    },
  );

  await db
    .update(tasks)
    .set({ externalId, sourceId: source.id, dirty: false, lastPushedAt: Date.now() })
    .where(eq(tasks.id, taskId));
}

async function notionComplete(
  env: Env,
  db: DB,
  job: typeof outbox.$inferSelect,
): Promise<void> {
  const { taskId } = job.payload as { taskId: string };

  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
  if (!task?.externalId || !task.sourceId) return;

  const source = await db.query.taskSources.findFirst({
    where: eq(taskSources.id, task.sourceId),
  });
  if (!source) return;

  await notion.markTaskDone(
    requireSecret(env, 'NOTION_TOKEN'),
    task.externalId,
    source.propertyMap,
  );

  await db
    .update(tasks)
    .set({ dirty: false, lastPushedAt: Date.now() })
    .where(eq(tasks.id, taskId));
}

async function pushJob(
  env: Env,
  db: DB,
  job: typeof outbox.$inferSelect,
): Promise<void> {
  const payload = job.payload as PushPayload;
  await sendToUser(env, db, job.userId, payload);
}

/** Fans a notification out to every device, pruning dead subscriptions. */
export async function sendToUser(
  env: Env,
  db: DB,
  userId: string,
  payload: PushPayload,
): Promise<void> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
    console.warn('[push] VAPID not configured; notification skipped');
    return;
  }

  const subs = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));

  const vapid = {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT,
  };

  for (const sub of subs) {
    const keys = await openJson<{ p256dh: string; auth: string }>(
      { ciphertext: sub.ciphertext, iv: sub.iv },
      env.MASTER_KEY,
    );

    const result = await sendPush(
      { endpoint: sub.endpoint, ...keys },
      payload,
      vapid,
    );

    if (result.expired) {
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
    } else if (!result.ok) {
      await db
        .update(pushSubscriptions)
        .set({ failureCount: sub.failureCount + 1 })
        .where(eq(pushSubscriptions.id, sub.id));
    }
  }
}
