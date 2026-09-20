import { pruneOrphanEvents } from '../services/prune-orphans';
import { estimateMissing } from '../services/estimate-missing';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { users, jobRuns, settings as settingsTable } from '../db/schema';
import { syncNotion, syncCalendars } from '../services/sync';
import { drainOutbox } from '../services/outbox';
import { applyPlannerCalendarMoves, replan } from '../services/planner';
import { runMorningBriefing, runEveningReview, resolveReviewTime } from './daily';
import { atLocalMinutes, localDateKey, MINUTE_MS } from '../lib/time';
import { toPlannerError } from '../lib/errors';
import type { Env } from '../env';

/**
 * The single cron entry point, fired every five minutes.
 *
 * Cloudflare cron expressions are UTC-only and fixed, which does not survive
 * DST and cannot express "30 minutes after a shift that ends at a different
 * time each day". So instead of scheduling each job separately, this tick
 * computes what is *actually* due in Europe/Rome local time and runs it —
 * guarded by a unique `jobKey` so a job fires exactly once per day even though
 * the tick happens 288 times.
 */

/** How late a job may fire and still be worth running. */
const DUE_WINDOW_MS = 20 * MINUTE_MS;

export async function handleScheduled(env: Env): Promise<void> {
  const db = getDb(env);
  const now = Date.now();

  const allUsers = await db.select().from(users);

  for (const user of allUsers) {
    const timezone = user.timezone || env.APP_TIMEZONE;

    try {
      // 1. Outbound first: clearing a backlog before syncing means a failed
      //    Google write from the last tick is retried before we generate more.
      await drainOutbox(env, db);

      // 2. Pull remote changes.
      const [notionReport, calendarReport] = await Promise.all([
        syncNotion(env, db, user.id),
        syncCalendars(env, db, user.id),
      ]);

      // Tasks Notion left without a duration or an energy level get one from
      // the model, once. A failure here must not stop the plan.
      try {
        const estimated = await estimateMissing(env, db, user.id);
        if (estimated > 0) notionReport.changed = true;
      } catch (err) {
        console.warn('[cron] estimate failed:', toPlannerError(err).message);
      }

      const errors = [...notionReport.errors, ...calendarReport.errors];
      if (errors.length > 0) {
        console.warn(`[cron] sync issues for ${user.id}: ${errors.join(' | ')}`);
      }

      // 3. A failed required sync leaves the last valid plan untouched. When
      //    both pulls succeed, only replan if something actually moved.
      if (errors.length > 0) {
        await replan(env, db, user.id, 'cron', { syncErrors: errors });
      } else if (calendarReport.plannerMoves.length > 0) {
        await applyPlannerCalendarMoves(
          env,
          db,
          user.id,
          calendarReport.plannerMoves,
        );
      } else if (notionReport.changed || calendarReport.changed) {
        const trigger = calendarReport.changed ? 'calendar_change' : 'cron';
        await replan(env, db, user.id, trigger);
      }

      // 4. Time-of-day jobs.
      await maybeRunBriefing(env, db, user.id, timezone, now);
      await maybeRunReview(env, db, user.id, timezone, now);

      // 5. Push whatever the replan queued.
      await drainOutbox(env, db);

      // 6. Clear Planner events in Google that no block accounts for.
      try {
        const pruned = await pruneOrphanEvents(env, db, user.id);
        if (pruned > 0) console.log(`[cron] removed ${pruned} orphan calendar events`);
      } catch (err) {
        console.warn('[cron] orphan sweep failed:', toPlannerError(err).message);
      }
    } catch (err) {
      // One user's failure must not stop the others once this is multi-tenant.
      console.error(`[cron] failed for user ${user.id}:`, toPlannerError(err).message);
    }
  }
}

/**
 * Runs `fn` at most once for the given key. The unique index on
 * (userId, jobKey) is the lock — an insert that conflicts means another tick
 * already claimed it.
 */
async function runOnce(
  db: ReturnType<typeof getDb>,
  userId: string,
  jobKey: string,
  fn: () => Promise<string>,
): Promise<void> {
  const claimed = await db
    .insert(jobRuns)
    .values({ userId, jobKey, status: 'ok' })
    .onConflictDoNothing()
    .returning({ id: jobRuns.id });

  if (claimed.length === 0) return;

  try {
    const detail = await fn();
    await db
      .update(jobRuns)
      .set({ detail: detail.slice(0, 1000) })
      .where(eq(jobRuns.id, claimed[0]!.id));
  } catch (err) {
    // Record the failure but leave the claim in place: a briefing that failed
    // at 07:00 is stale by 07:20, and retrying it all morning is worse than
    // skipping it.
    await db
      .update(jobRuns)
      .set({ status: 'failed', detail: toPlannerError(err).message.slice(0, 500) })
      .where(eq(jobRuns.id, claimed[0]!.id));
    throw err;
  }
}

async function maybeRunBriefing(
  env: Env,
  db: ReturnType<typeof getDb>,
  userId: string,
  timezone: string,
  now: number,
): Promise<void> {
  const prefs = await db.query.settings.findFirst({
    where: eq(settingsTable.userId, userId),
  });
  const target = atLocalMinutes(now, timezone, prefs?.briefingMinutes ?? 7 * 60);

  if (now < target || now > target + DUE_WINDOW_MS) return;

  await runOnce(db, userId, `briefing:${localDateKey(now, timezone)}`, () =>
    runMorningBriefing(env, db, userId, timezone),
  );
}

async function maybeRunReview(
  env: Env,
  db: ReturnType<typeof getDb>,
  userId: string,
  timezone: string,
  now: number,
): Promise<void> {
  const target = await resolveReviewTime(db, userId, timezone, now);

  if (now < target || now > target + DUE_WINDOW_MS) return;

  await runOnce(db, userId, `review:${localDateKey(now, timezone)}`, () =>
    runEveningReview(env, db, userId, timezone),
  );
}
