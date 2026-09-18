import { eq } from 'drizzle-orm';
import type { DB } from '../db/client';
import { scheduledBlocks } from '../db/schema';
import { deletePlannerEvent, listPlannerEvents } from '../integrations/google-calendar';
import { getPlannerCalendarId } from './calendar-sources';
import type { Env } from '../env';

/**
 * Removes Planner's own events that no block accounts for.
 *
 * Two drains once ran the same write job at the same time and each created an
 * event; only one was remembered. Every replan of 2026-09-17/18 left copies
 * of old plans in Giulia's calendar — the same task four times at 07:00. The
 * write path is idempotent now, and this sweep clears what was left behind.
 *
 * Only events tagged with `plannerBlockId` are ever considered, so an event
 * Giulia created by hand in the same calendar is never touched.
 */

const MAX_DELETES_PER_RUN = 150;
const DAY_MS = 86_400_000;

/** Which tagged events are not the event a live block points to. */
export function findOrphans(
  events: Array<{ eventId: string; plannerBlockId: string }>,
  blocks: Array<{ id: string; googleEventId: string | null }>,
): string[] {
  const byId = new Map(blocks.map((b) => [b.id, b.googleEventId]));
  return events
    .filter((event) => {
      if (!byId.has(event.plannerBlockId)) return true;
      const known = byId.get(event.plannerBlockId);
      // Not pushed yet: the event may be the one being written right now.
      if (known === null) return false;
      return known !== event.eventId;
    })
    .map((event) => event.eventId);
}

export async function pruneOrphanEvents(
  env: Env,
  db: DB,
  userId: string,
  horizonDays = 21,
): Promise<number> {
  const calendarId = await getPlannerCalendarId(db, userId);
  const now = Date.now();

  const [events, blocks] = await Promise.all([
    listPlannerEvents(env, calendarId, now - 2 * DAY_MS, now + horizonDays * DAY_MS),
    db
      .select({ id: scheduledBlocks.id, googleEventId: scheduledBlocks.googleEventId })
      .from(scheduledBlocks)
      .where(eq(scheduledBlocks.userId, userId)),
  ]);

  const orphans = findOrphans(events, blocks).slice(0, MAX_DELETES_PER_RUN);
  for (const eventId of orphans) {
    await deletePlannerEvent(env, calendarId, eventId);
  }
  return orphans.length;
}
