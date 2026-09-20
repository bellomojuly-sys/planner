import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client';
import { outbox, scheduledBlocks, tasks, type Task } from '../db/schema';
import type { Env } from '../env';
import { minutesBetween } from '../lib/time';
import { toPlannerError } from '../lib/errors';
import { recordCompletion } from '../scheduler/estimate';
import { getPlannerCalendarId } from './calendar-sources';
import { drainOutbox } from './outbox';
import { replan } from './planner';

/**
 * Uses elapsed scheduled work as the best available duration when Giulia did
 * not enter one explicitly. Future parts do not count as work already done.
 */
export async function inferActualMinutes(
  db: DB,
  userId: string,
  taskId: string,
): Promise<number | null> {
  const blocks = await db
    .select()
    .from(scheduledBlocks)
    .where(
      and(
        eq(scheduledBlocks.userId, userId),
        eq(scheduledBlocks.taskId, taskId),
      ),
    );

  const now = Date.now();
  const elapsed = blocks
    .filter((block) => block.startAt < now)
    .reduce(
      (sum, block) =>
        sum + minutesBetween(block.startAt, Math.min(block.endAt, now)),
      0,
    );

  return elapsed > 0 ? elapsed : null;
}

/**
 * Commits completion locally and durably queues every external write. This is
 * the latency-sensitive part: after it returns, the UI can answer immediately
 * without waiting for Google Calendar, Notion or a complete replan.
 */
export async function completeTaskLocally(
  db: DB,
  userId: string,
  task: Task,
  actualMinutes: number | null,
): Promise<void> {
  await db
    .update(tasks)
    .set({ status: 'done', completedAt: Date.now(), dirty: true })
    .where(and(eq(tasks.id, task.id), eq(tasks.userId, userId)));

  if (actualMinutes) {
    await recordCompletion(db, userId, task, actualMinutes);
  }

  // Remove every scheduled part immediately. Google deletions are durable
  // outbox jobs, so an upstream outage cannot resurrect the local task.
  const blocks = await db
    .select()
    .from(scheduledBlocks)
    .where(
      and(
        eq(scheduledBlocks.userId, userId),
        eq(scheduledBlocks.taskId, task.id),
      ),
    );
  const publishedBlocks = blocks.filter((block) => block.googleEventId);
  if (publishedBlocks.length > 0) {
    const plannerCalendarId = await getPlannerCalendarId(db, userId);
    for (const block of publishedBlocks) {
      await db.insert(outbox).values({
        userId,
        kind: 'google_delete',
        payload: {
          eventId: block.googleEventId!,
          calendarId: block.calendarId ?? plannerCalendarId,
        },
      });
    }
  }

  await db
    .delete(scheduledBlocks)
    .where(
      and(
        eq(scheduledBlocks.userId, userId),
        eq(scheduledBlocks.taskId, task.id),
      ),
    );

  if (task.externalId && task.sourceId) {
    await db.insert(outbox).values({
      userId,
      kind: 'notion_complete',
      payload: { taskId: task.id },
    });
  }
}

/**
 * Cloudflare keeps this promise alive with executionCtx.waitUntil(). Failures
 * are logged while the durable outbox remains available for the next cron.
 */
export async function finishCompletionInBackground(
  env: Env,
  db: DB,
  userId: string,
): Promise<void> {
  try {
    await replan(env, db, userId, 'dependency_cascade');
  } catch (error) {
    const failure = toPlannerError(error);
    console.error(
      JSON.stringify({
        message: 'completion replan failed',
        code: failure.code,
      }),
    );
  }

  try {
    await drainOutbox(env, db);
  } catch (error) {
    const failure = toPlannerError(error);
    console.error(
      JSON.stringify({
        message: 'completion outbox drain failed',
        code: failure.code,
      }),
    );
  }
}
