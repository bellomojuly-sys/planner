import { and, eq, gte, inArray } from 'drizzle-orm';
import type { DB } from '../db/client';
import {
  tasks,
  taskSources,
  taskDependencies,
  calendarEvents,
  calendarSyncState,
  settings as settingsTable,
} from '../db/schema';
import * as notion from '../integrations/notion';
import {
  syncEvents,
  isSyncTokenExpired,
  type GoogleEvent,
} from '../integrations/google-calendar';
import { applyLearning } from '../scheduler/estimate';
import { inferPhaseEdges, parsePhase } from '../scheduler/dependencies';
import { DAY_MS } from '../lib/time';
import { PlannerError, toPlannerError } from '../lib/errors';
import type { Env } from '../env';

export interface SyncReport {
  tasksUpserted: number;
  tasksCompleted: number;
  eventsUpserted: number;
  eventsRemoved: number;
  /** Rows skipped because they are meetings or deadlines, not work. */
  tasksSkipped: number;
  /** True when something changed that should trigger a reschedule. */
  changed: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Notion → local
// ---------------------------------------------------------------------------

export async function syncNotion(
  env: Env,
  db: DB,
  userId: string,
): Promise<SyncReport> {
  const report: SyncReport = {
    tasksUpserted: 0,
    tasksCompleted: 0,
    eventsUpserted: 0,
    eventsRemoved: 0,
    tasksSkipped: 0,
    changed: false,
    errors: [],
  };

  if (!env.NOTION_TOKEN) {
    report.errors.push('Notion non configurato.');
    return report;
  }

  const sources = await db
    .select()
    .from(taskSources)
    .where(and(eq(taskSources.userId, userId), eq(taskSources.enabled, true)));

  for (const source of sources) {
    try {
      // Overlap the window by an hour: Notion's last_edited_time has coarse
      // resolution, and a missed edit is worse than a redundant one.
      const since = source.lastSyncedAt ? source.lastSyncedAt - 3_600_000 : null;
      const remote = await notion.fetchTasks(env.NOTION_TOKEN, source, since);

      for (const item of remote) {
        // Meetings already exist as Google Calendar events, and a deadline is
        // a date marker: scheduling either as work would double-book the day.
        if (!item.schedulable) {
          report.tasksSkipped++;
          continue;
        }

        const existing = await db.query.tasks.findFirst({
          where: and(
            eq(tasks.userId, userId),
            eq(tasks.sourceId, source.id),
            eq(tasks.externalId, item.externalId),
          ),
        });

        const area = notion.normalizeArea(item.area, source.area as never);
        const energy = item.energy ?? existing?.energy ?? 'medium';
        const estimated =
          item.estimatedMinutes ?? existing?.estimatedMinutes ?? 30;

        // Notion's estimate is a starting point; the learned bias is what the
        // scheduler actually books time for.
        const learned = await applyLearning(db, userId, {
          area,
          energy,
          title: item.title,
          estimatedMinutes: estimated,
        });

        const phase = parsePhase(item.title);

        if (!existing) {
          await db.insert(tasks).values({
            userId,
            sourceId: source.id,
            externalId: item.externalId,
            title: item.title,
            notes: item.notes,
            area,
            energy,
            priority: item.priority ?? 3,
            estimatedMinutes: estimated,
            plannedMinutes: learned.plannedMinutes,
            actualMinutes: item.actualMinutes,
            earliestStartAt: item.earliestStartAt,
            splittable: item.splittable,
            estimateSource: item.estimatedMinutes ? 'notion' : 'learned',
            estimateConfidence: learned.confidence,
            status: item.done ? 'done' : 'todo',
            completedAt: item.done ? item.externalUpdatedAt : null,
            dueAt: item.dueAt,
            phaseLabel: phase ? `${phase.order}` : null,
            phaseOrder: phase?.order ?? null,
            projectKey: phase?.projectKey ?? null,
            externalUpdatedAt: item.externalUpdatedAt,
          });
          report.tasksUpserted++;
          report.changed = true;
          continue;
        }

        // Local edits win when they are newer — Giulia dragging a block should
        // not be undone by a stale Notion row.
        if (
          existing.externalUpdatedAt &&
          item.externalUpdatedAt <= existing.externalUpdatedAt
        ) {
          continue;
        }

        const nowDone = item.done && existing.status !== 'done';

        await db
          .update(tasks)
          .set({
            title: item.title,
            notes: item.notes,
            area,
            energy,
            priority: item.priority ?? existing.priority,
            estimatedMinutes: estimated,
            plannedMinutes: existing.pinned
              ? existing.plannedMinutes
              : learned.plannedMinutes,
            actualMinutes: item.actualMinutes ?? existing.actualMinutes,
            // A manual drag in the app wins over Notion's start constraint.
            earliestStartAt: existing.pinned
              ? existing.earliestStartAt
              : item.earliestStartAt,
            splittable: item.splittable,
            dueAt: item.dueAt,
            status: item.done ? 'done' : existing.status === 'done' ? 'todo' : existing.status,
            completedAt: item.done ? item.externalUpdatedAt : null,
            phaseLabel: phase ? `${phase.order}` : existing.phaseLabel,
            phaseOrder: phase?.order ?? existing.phaseOrder,
            projectKey: phase?.projectKey ?? existing.projectKey,
            externalUpdatedAt: item.externalUpdatedAt,
          })
          .where(eq(tasks.id, existing.id));

        if (nowDone) report.tasksCompleted++;
        report.tasksUpserted++;
        report.changed = true;
      }

      // Notion relations reference page ids; translate them to local ids.
      await materializeRelationDependencies(db, userId, source.id, remote);

      await db
        .update(taskSources)
        .set({ lastSyncedAt: Date.now(), lastSyncError: null })
        .where(eq(taskSources.id, source.id));
    } catch (err) {
      const pe = toPlannerError(err);
      report.errors.push(`${source.name}: ${pe.userMessage}`);
      await db
        .update(taskSources)
        .set({ lastSyncError: pe.message.slice(0, 500) })
        .where(eq(taskSources.id, source.id));
    }
  }

  await inferPhaseDependencies(db, userId);
  return report;
}

async function materializeRelationDependencies(
  db: DB,
  userId: string,
  sourceId: string,
  remote: notion.NotionTask[],
): Promise<void> {
  const withDeps = remote.filter((r) => r.dependsOnExternalIds.length > 0);
  if (withDeps.length === 0) return;

  const externalIds = [
    ...new Set(withDeps.flatMap((r) => [r.externalId, ...r.dependsOnExternalIds])),
  ];

  const local = await db
    .select({ id: tasks.id, externalId: tasks.externalId })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), inArray(tasks.externalId, externalIds)));

  const byExternal = new Map(local.map((t) => [t.externalId!, t.id]));

  for (const item of withDeps) {
    const taskId = byExternal.get(item.externalId);
    if (!taskId) continue;

    for (const depExternal of item.dependsOnExternalIds) {
      const dependsOnId = byExternal.get(depExternal);
      // A relation may point at a page in a database we do not sync.
      if (!dependsOnId || dependsOnId === taskId) continue;

      await db
        .insert(taskDependencies)
        .values({ userId, taskId, dependsOnId, createdBy: 'user' })
        .onConflictDoNothing();
    }
  }
}

/**
 * Wires "Fase 15 → Fase 16" chains that Notion does not model explicitly.
 *
 * Exported because it must run on every replan, not only after a Notion sync:
 * a phase created by voice or in the app has to join its chain too.
 */
export async function inferPhaseDependencies(db: DB, userId: string): Promise<void> {
  const open = await db
    .select({ id: tasks.id, title: tasks.title, status: tasks.status })
    .from(tasks)
    .where(eq(tasks.userId, userId));

  const existingEdges = await db
    .select()
    .from(taskDependencies)
    .where(eq(taskDependencies.userId, userId));

  const map = new Map<string, Array<{ dependsOnId: string; lagMinutes: number }>>();
  for (const edge of existingEdges) {
    const list = map.get(edge.taskId) ?? [];
    list.push({ dependsOnId: edge.dependsOnId, lagMinutes: edge.lagMinutes });
    map.set(edge.taskId, list);
  }

  for (const edge of inferPhaseEdges(open, map)) {
    await db
      .insert(taskDependencies)
      .values({ ...edge, userId, createdBy: 'phase_rule' })
      .onConflictDoNothing();
  }
}

// ---------------------------------------------------------------------------
// Google Calendar → local
// ---------------------------------------------------------------------------

export async function syncCalendar(
  env: Env,
  db: DB,
  userId: string,
  calendarId = 'primary',
): Promise<SyncReport> {
  const report: SyncReport = {
    tasksUpserted: 0,
    tasksCompleted: 0,
    eventsUpserted: 0,
    eventsRemoved: 0,
    tasksSkipped: 0,
    changed: false,
    errors: [],
  };

  const prefs = await db.query.settings.findFirst({
    where: eq(settingsTable.userId, userId),
  });
  const keywords = (prefs?.fixedEventKeywords ?? '')
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);

  const state = await db
    .select()
    .from(calendarSyncState)
    .where(
      and(
        eq(calendarSyncState.userId, userId),
        eq(calendarSyncState.calendarId, calendarId),
      ),
    )
    .limit(1);

  const existingToken = state[0]?.syncToken ?? null;
  const horizonDays = prefs?.planningHorizonDays ?? 14;

  let result;
  try {
    result = await syncEvents(env, calendarId, {
      syncToken: existingToken,
      timeMin: Date.now() - DAY_MS,
      timeMax: Date.now() + (horizonDays + 7) * DAY_MS,
    });
  } catch (err) {
    if (isSyncTokenExpired(err)) {
      // Google invalidates sync tokens after a while; a full re-sync is the
      // documented recovery, not an error worth surfacing.
      result = await syncEvents(env, calendarId, {
        syncToken: null,
        timeMin: Date.now() - DAY_MS,
        timeMax: Date.now() + (horizonDays + 7) * DAY_MS,
      });
    } else {
      const pe = toPlannerError(err);
      report.errors.push(pe.userMessage);
      await upsertSyncState(db, userId, calendarId, existingToken, pe.message);
      return report;
    }
  }

  for (const event of result.events) {
    // Our own planner blocks come back on the feed; ignoring them here is what
    // stops the scheduler treating yesterday's plan as immovable.
    if (event.isPlannerBlock) continue;

    if (event.cancelled) {
      const deleted = await db
        .delete(calendarEvents)
        .where(
          and(
            eq(calendarEvents.userId, userId),
            eq(calendarEvents.calendarId, calendarId),
            eq(calendarEvents.externalId, event.externalId),
          ),
        )
        .returning({ id: calendarEvents.id });
      if (deleted.length > 0) {
        report.eventsRemoved++;
        report.changed = true;
      }
      continue;
    }

    const { kind, isShift } = classifyEvent(event, keywords);
    const contentHash = `${event.startAt}:${event.endAt}:${event.title}`;

    const existing = await db.query.calendarEvents.findFirst({
      where: and(
        eq(calendarEvents.userId, userId),
        eq(calendarEvents.calendarId, calendarId),
        eq(calendarEvents.externalId, event.externalId),
      ),
    });

    if (existing?.contentHash === contentHash) continue;

    if (existing) {
      await db
        .update(calendarEvents)
        .set({
          title: event.title,
          location: event.location,
          startAt: event.startAt,
          endAt: event.endAt,
          allDay: event.allDay,
          kind,
          isShift,
          etag: event.etag,
          contentHash,
        })
        .where(eq(calendarEvents.id, existing.id));
    } else {
      await db.insert(calendarEvents).values({
        userId,
        calendarId,
        externalId: event.externalId,
        title: event.title,
        location: event.location,
        startAt: event.startAt,
        endAt: event.endAt,
        allDay: event.allDay,
        kind,
        isShift,
        etag: event.etag,
        contentHash,
      });
    }

    report.eventsUpserted++;
    report.changed = true;
  }

  await upsertSyncState(db, userId, calendarId, result.nextSyncToken, null);
  return report;
}

/**
 * All-day events are treated as soft: an all-day "Ferie" should not blank out
 * the whole day for planning purposes, whereas a timed shift must.
 */
function classifyEvent(
  event: GoogleEvent,
  keywords: string[],
): { kind: 'fixed' | 'soft'; isShift: boolean } {
  const haystack = `${event.title} ${event.location ?? ''}`.toLowerCase();
  const matched = keywords.some((k) => haystack.includes(k));
  const isShift = /turno|ristorante|shift|servizio/.test(haystack);

  if (event.allDay) return { kind: 'soft', isShift: false };
  return { kind: matched ? 'fixed' : 'fixed', isShift };
}

async function upsertSyncState(
  db: DB,
  userId: string,
  calendarId: string,
  syncToken: string | null,
  error: string | null,
): Promise<void> {
  const existing = await db
    .select()
    .from(calendarSyncState)
    .where(
      and(
        eq(calendarSyncState.userId, userId),
        eq(calendarSyncState.calendarId, calendarId),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(calendarSyncState)
      .set({ syncToken, lastSyncedAt: Date.now(), lastError: error?.slice(0, 500) })
      .where(
        and(
          eq(calendarSyncState.userId, userId),
          eq(calendarSyncState.calendarId, calendarId),
        ),
      );
  } else {
    await db.insert(calendarSyncState).values({
      userId,
      calendarId,
      syncToken,
      lastSyncedAt: Date.now(),
      lastError: error?.slice(0, 500),
    });
  }
}

/** Fixed commitments inside the planning window, for the busy mask. */
export async function loadBusyIntervals(
  db: DB,
  userId: string,
  from: number,
  to: number,
): Promise<Array<{ start: number; end: number }>> {
  const rows = await db
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.userId, userId),
        eq(calendarEvents.kind, 'fixed'),
        gte(calendarEvents.endAt, from),
      ),
    );

  return rows
    .filter((e) => !e.cancelled && !e.allDay && e.startAt < to)
    .map((e) => ({ start: e.startAt, end: e.endAt }));
}

export { PlannerError };
