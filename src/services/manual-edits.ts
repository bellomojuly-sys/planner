import { and, eq, gte } from 'drizzle-orm';
import type { DB } from '../db/client';
import type { Env } from '../env';
import {
  calendarEvents,
  calendarSources,
  outbox,
  planSuppressions,
  scheduledBlocks,
  tasks,
} from '../db/schema';
import {
  deleteCalendarEvent,
  updateCalendarEvent,
} from '../integrations/google-calendar';
import { PlannerError } from '../lib/errors';
import { getPlannerCalendarId } from './calendar-sources';
import { localDateKey } from '../lib/time';

/**
 * Hand edits from the PWA, and deletions made directly in Google Calendar.
 *
 * The rule that holds everything together, recorded in
 * `dl-how-manual-edits-survive-a-replan`: an edited planner block is pinned
 * permanently, and a deleted one leaves a durable marker the scheduler reads
 * (a paused task, or a suppression key for generated blocks). Without the
 * marker the next replan would recreate what Giulia just removed.
 */

type Block = typeof scheduledBlocks.$inferSelect;
type CalendarEvent = typeof calendarEvents.$inferSelect;
type CalendarSource = typeof calendarSources.$inferSelect;

/** The components one gym session is made of, as the engine names them. */
export const GYM_COMPONENT_TITLES = new Set([
  'viaggio verso palestra',
  'palestra',
  'ritorno dalla palestra',
  'doccia / cambio',
]);

export function normalizeBlockTitle(title: string): string {
  return title.trim().toLocaleLowerCase('it-IT').replace(/\s+/g, ' ');
}

export function gymSuppressionKey(dayKey: string): string {
  return `gym:${dayKey}`;
}

export function bufferSuppressionKey(dayKey: string, title: string): string {
  return `buffer:${dayKey}:${normalizeBlockTitle(title)}`;
}

/** Every part of the gym session `gym` belongs to: same day, no task. */
export function gymSessionParts(
  gym: Pick<Block, 'id' | 'startAt'>,
  candidates: Array<Pick<Block, 'id' | 'taskId' | 'title' | 'kind' | 'startAt'>>,
  timezone: string,
): string[] {
  const day = localDateKey(gym.startAt, timezone);
  return candidates
    .filter(
      (block) =>
        block.id === gym.id ||
        (!block.taskId &&
          (block.kind === 'buffer' || block.kind === 'gym') &&
          GYM_COMPONENT_TITLES.has(normalizeBlockTitle(block.title)) &&
          localDateKey(block.startAt, timezone) === day),
    )
    .map((block) => block.id);
}

export interface Editability {
  editable: boolean;
  /** Shown in the UI when `editable` is false. */
  reason: string | null;
}

/**
 * Only Google calendars where the account can write accept edits. ICS feeds
 * are a read-only snapshot by definition; a shared calendar with reader access
 * would answer 403.
 */
export function eventEditability(
  source: Pick<CalendarSource, 'kind' | 'accessRole'> | undefined,
): Editability {
  if (!source) {
    return { editable: false, reason: 'Calendario non configurato in Planner.' };
  }
  if (source.kind === 'ics') {
    return {
      editable: false,
      reason: 'Feed ICS in sola lettura: modificalo nell’app che lo pubblica.',
    };
  }
  if (source.accessRole !== 'writer' && source.accessRole !== 'owner') {
    return {
      editable: false,
      reason: 'Calendario condiviso in sola lettura con Planner.',
    };
  }
  return { editable: true, reason: null };
}

export function blockEditability(block: Pick<Block, 'kind'>): {
  editable: boolean;
  deletable: boolean;
  reason: string | null;
} {
  if (block.kind === 'break') {
    return { editable: false, deletable: false, reason: 'Pausa calcolata dal piano.' };
  }
  if (block.kind === 'buffer') {
    return {
      editable: false,
      deletable: true,
      reason:
        'Viaggio o preparazione calcolati dall’evento: per cambiarli modifica l’evento o le impostazioni di viaggio.',
    };
  }
  return { editable: true, deletable: true, reason: null };
}

function assertValidRange(start: number, end: number): void {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new PlannerError('bad_request', {
      userMessage: "L'orario di fine deve essere dopo quello di inizio.",
    });
  }
}

// ---------------------------------------------------------------------------
// Calendar events (lessons, shifts, anything not written by Planner)
// ---------------------------------------------------------------------------

async function loadEditableEvent(
  db: DB,
  userId: string,
  eventId: string,
): Promise<{ event: CalendarEvent; source: CalendarSource }> {
  const event = await db.query.calendarEvents.findFirst({
    where: and(eq(calendarEvents.id, eventId), eq(calendarEvents.userId, userId)),
  });
  if (!event || event.cancelled) throw new PlannerError('not_found');

  const source = await db.query.calendarSources.findFirst({
    where: and(
      eq(calendarSources.userId, userId),
      eq(calendarSources.calendarId, event.calendarId),
    ),
  });
  const access = eventEditability(source);
  if (!access.editable) {
    throw new PlannerError('bad_request', { userMessage: access.reason ?? undefined });
  }
  return { event, source: source! };
}

export async function editCalendarEvent(
  env: Env,
  db: DB,
  userId: string,
  eventId: string,
  patch: { title: string; start: number; end: number },
): Promise<void> {
  assertValidRange(patch.start, patch.end);
  const { event } = await loadEditableEvent(db, userId, eventId);

  // All-day events keep whole-day boundaries; only the title is editable in
  // the UI, so their stored dates are sent back unchanged.
  const startAt = event.allDay ? event.startAt : patch.start;
  const endAt = event.allDay ? event.endAt : patch.end;

  const { etag } = await updateCalendarEvent(
    env,
    event.calendarId,
    event.externalId,
    { title: patch.title, startAt, endAt, allDay: event.allDay },
    env.APP_TIMEZONE,
  );

  // Google stays the source of truth. Clearing the hash makes the next sync
  // rewrite this row from Google, including a reclassification if the new
  // title turns it into (or out of) a fixed commitment.
  await db
    .update(calendarEvents)
    .set({ title: patch.title, startAt, endAt, etag, contentHash: null })
    .where(eq(calendarEvents.id, event.id));
}

export async function removeCalendarEvent(
  env: Env,
  db: DB,
  userId: string,
  eventId: string,
): Promise<void> {
  const { event } = await loadEditableEvent(db, userId, eventId);
  await deleteCalendarEvent(env, event.calendarId, event.externalId);
  await db.delete(calendarEvents).where(eq(calendarEvents.id, event.id));
}

// ---------------------------------------------------------------------------
// Planner blocks
// ---------------------------------------------------------------------------

async function loadBlock(db: DB, userId: string, blockId: string): Promise<Block> {
  const block = await db.query.scheduledBlocks.findFirst({
    where: and(eq(scheduledBlocks.id, blockId), eq(scheduledBlocks.userId, userId)),
  });
  if (!block) throw new PlannerError('not_found');
  return block;
}

/** Legacy rows have no route; they live in the fallback Planner calendar. */
async function routeOf(db: DB, userId: string, block: Block): Promise<string> {
  return block.calendarId ?? (await getPlannerCalendarId(db, userId));
}

async function enqueueUpsert(db: DB, userId: string, block: Block): Promise<void> {
  await db.insert(outbox).values({
    userId,
    kind: 'google_upsert',
    payload: { blockId: block.id, calendarId: await routeOf(db, userId, block) },
  });
}

/**
 * A hand edit is a stronger statement than a drag: it pins permanently.
 * For a task, every part is pinned, because a pinned task is excluded from
 * scheduling and any unpinned sibling would otherwise be dropped. For a gym
 * session, its travel and shower parts move with it.
 */
export async function editPlannerBlock(
  db: DB,
  userId: string,
  blockId: string,
  patch: { title: string; start: number; end: number },
  timezone: string,
): Promise<void> {
  assertValidRange(patch.start, patch.end);
  const block = await loadBlock(db, userId, blockId);
  const access = blockEditability(block);
  if (!access.editable) {
    throw new PlannerError('bad_request', { userMessage: access.reason ?? undefined });
  }

  const delta = patch.start - block.startAt;
  const title = patch.title.trim() || block.title;

  const siblings = block.taskId
    ? await db
        .select()
        .from(scheduledBlocks)
        .where(
          and(
            eq(scheduledBlocks.userId, userId),
            eq(scheduledBlocks.taskId, block.taskId),
          ),
        )
    : block.kind === 'gym'
      ? await sameDayGeneratedBlocks(db, userId, block, timezone)
      : [block];

  const gymParts = block.kind === 'gym' ? new Set(gymSessionParts(block, siblings, timezone)) : null;

  for (const part of siblings) {
    if (gymParts && !gymParts.has(part.id)) continue;
    const isEdited = part.id === block.id;
    const updated = {
      title: isEdited ? title : part.title,
      // Task siblings keep their own times; gym parts travel with the workout.
      startAt: isEdited ? patch.start : gymParts ? part.startAt + delta : part.startAt,
      endAt: isEdited ? patch.end : gymParts ? part.endAt + delta : part.endAt,
      pinned: true,
      syncState: 'pending' as const,
    };
    await db.update(scheduledBlocks).set(updated).where(eq(scheduledBlocks.id, part.id));
    await enqueueUpsert(db, userId, { ...part, ...updated });
  }

  if (block.taskId) {
    await db
      .update(tasks)
      .set({ pinned: true })
      .where(and(eq(tasks.id, block.taskId), eq(tasks.userId, userId)));
  }
}

async function sameDayGeneratedBlocks(
  db: DB,
  userId: string,
  block: Block,
  timezone: string,
): Promise<Block[]> {
  const rows = await db
    .select()
    .from(scheduledBlocks)
    .where(
      and(
        eq(scheduledBlocks.userId, userId),
        gte(scheduledBlocks.endAt, block.startAt - 24 * 60 * 60_000),
      ),
    );
  const day = localDateKey(block.startAt, timezone);
  return rows.filter(
    (row) => !row.taskId && localDateKey(row.startAt, timezone) === day,
  );
}

export type DismissOutcome = 'task_paused' | 'gym_suppressed' | 'buffer_suppressed';

/**
 * Removes a planner block and records why it must not come back.
 *
 * - task block → the task is paused (stays open, also in Notion) and all its
 *   blocks are removed; "Rimetti nel piano" in the task list undoes it.
 * - gym block → that day's whole session goes, and the day is suppressed.
 * - travel/preparation → only that component goes, and it is suppressed.
 *
 * `deletedInGoogle` names an event already deleted by Giulia in Google, so we
 * do not try to delete it a second time.
 */
export async function dismissBlock(
  db: DB,
  userId: string,
  blockId: string,
  timezone: string,
  options: { deletedInGoogle?: string } = {},
): Promise<{ outcome: DismissOutcome; removed: number }> {
  const block = await loadBlock(db, userId, blockId);
  const access = blockEditability(block);
  if (!access.deletable) {
    throw new PlannerError('bad_request', { userMessage: access.reason ?? undefined });
  }

  let doomed: Block[];
  let outcome: DismissOutcome;
  const dayKey = localDateKey(block.startAt, timezone);

  if (block.taskId) {
    doomed = await db
      .select()
      .from(scheduledBlocks)
      .where(
        and(eq(scheduledBlocks.userId, userId), eq(scheduledBlocks.taskId, block.taskId)),
      );
    await db
      .update(tasks)
      .set({ schedulingPaused: true, pinned: false })
      .where(and(eq(tasks.id, block.taskId), eq(tasks.userId, userId)));
    outcome = 'task_paused';
  } else if (block.kind === 'gym') {
    const candidates = await sameDayGeneratedBlocks(db, userId, block, timezone);
    const parts = new Set(gymSessionParts(block, candidates, timezone));
    doomed = candidates.filter((candidate) => parts.has(candidate.id));
    await suppress(db, userId, gymSuppressionKey(dayKey), dayKey);
    outcome = 'gym_suppressed';
  } else {
    doomed = [block];
    await suppress(db, userId, bufferSuppressionKey(dayKey, block.title), dayKey);
    outcome = 'buffer_suppressed';
  }

  for (const part of doomed) {
    if (part.googleEventId && part.googleEventId !== options.deletedInGoogle) {
      await db.insert(outbox).values({
        userId,
        kind: 'google_delete',
        payload: {
          eventId: part.googleEventId,
          calendarId: await routeOf(db, userId, part),
        },
      });
    }
    await db.delete(scheduledBlocks).where(eq(scheduledBlocks.id, part.id));
  }

  return { outcome, removed: doomed.length };
}

async function suppress(db: DB, userId: string, key: string, dayKey: string): Promise<void> {
  await db
    .insert(planSuppressions)
    .values({ userId, key, dayKey })
    .onConflictDoNothing();
}

/** Active suppression keys; days already past are irrelevant to planning. */
export async function loadSuppressionKeys(
  db: DB,
  userId: string,
  todayKey: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ key: planSuppressions.key })
    .from(planSuppressions)
    .where(and(eq(planSuppressions.userId, userId), gte(planSuppressions.dayKey, todayKey)));
  return new Set(rows.map((row) => row.key));
}

/** Puts a paused task back into automatic planning. */
export async function resumeTaskScheduling(
  db: DB,
  userId: string,
  taskId: string,
): Promise<void> {
  await db
    .update(tasks)
    .set({ schedulingPaused: false })
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)));
}
