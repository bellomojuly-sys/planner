import { and, eq, gte, inArray } from 'drizzle-orm';
import type { DB } from '../db/client';
import {
  tasks,
  taskSources,
  taskDependencies,
  calendarEvents,
  calendarSources,
  calendarSyncState,
  settings as settingsTable,
} from '../db/schema';
import * as notion from '../integrations/notion';
import { fetchIcsEvents } from '../integrations/ics';
import {
  syncEvents,
  isSyncTokenExpired,
  type GoogleEvent,
} from '../integrations/google-calendar';
import { blendLearning, loadEstimateModel } from '../scheduler/estimate';
import { inferPhaseEdges, parsePhase } from '../scheduler/dependencies';
import { DAY_MS } from '../lib/time';
import { PlannerError, toPlannerError } from '../lib/errors';
import type { Env } from '../env';
import type { CalendarRole } from './calendar-sources';

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

function emptyReport(): SyncReport {
  return {
    tasksUpserted: 0,
    tasksCompleted: 0,
    eventsUpserted: 0,
    eventsRemoved: 0,
    tasksSkipped: 0,
    changed: false,
    errors: [],
  };
}

function mergeReport(target: SyncReport, source: SyncReport): void {
  target.tasksUpserted += source.tasksUpserted;
  target.tasksCompleted += source.tasksCompleted;
  target.eventsUpserted += source.eventsUpserted;
  target.eventsRemoved += source.eventsRemoved;
  target.tasksSkipped += source.tasksSkipped;
  target.changed ||= source.changed;
  target.errors.push(...source.errors);
}

// ---------------------------------------------------------------------------
// Notion → local
// ---------------------------------------------------------------------------

export async function syncNotion(
  env: Env,
  db: DB,
  userId: string,
): Promise<SyncReport> {
  const report = emptyReport();

  if (!env.NOTION_TOKEN) {
    report.errors.push('Notion non configurato.');
    return report;
  }

  const sources = await db
    .select()
    .from(taskSources)
    .where(and(eq(taskSources.userId, userId), eq(taskSources.enabled, true)));

  // Loaded once: per-row lookups multiply queries by the size of the
  // database, and D1 caps queries per invocation.
  const learningModel = sources.length > 0 ? await loadEstimateModel(db, userId) : [];

  for (const source of sources) {
    try {
      // Overlap the window by an hour: Notion's last_edited_time has coarse
      // resolution, and a missed edit is worse than a redundant one.
      const since = source.lastSyncedAt ? source.lastSyncedAt - 3_600_000 : null;
      const remote = await notion.fetchTasks(env.NOTION_TOKEN, source, since);
      // A successful pull after an error must publish a fresh plan even when
      // no remote row changed during the outage.
      if (source.lastSyncError) report.changed = true;

      const localRows = await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.userId, userId), eq(tasks.sourceId, source.id)));
      const byExternalId = new Map(
        localRows.filter((t) => t.externalId).map((t) => [t.externalId!, t]),
      );

      for (const item of remote) {
        // Meetings already exist as Google Calendar events, and a deadline is
        // a date marker: scheduling either as work would double-book the day.
        if (!item.schedulable) {
          report.tasksSkipped++;
          continue;
        }

        const existing = byExternalId.get(item.externalId);

        // Local edits win when they are newer — Giulia dragging a block should
        // not be undone by a stale Notion row.
        if (
          existing?.externalUpdatedAt &&
          item.externalUpdatedAt <= existing.externalUpdatedAt
        ) {
          continue;
        }

        const area = notion.normalizeArea(item.area, source.area as never);
        const energy = item.energy ?? existing?.energy ?? 'medium';
        const estimated =
          item.estimatedMinutes ?? existing?.estimatedMinutes ?? 30;

        // Notion's estimate is a starting point; the learned bias is what the
        // scheduler actually books time for.
        const learned = blendLearning(learningModel, {
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
            horizon: item.horizon,
            externalUpdatedAt: item.externalUpdatedAt,
          });
          report.tasksUpserted++;
          report.changed = true;
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
            horizon: item.horizon,
            externalUpdatedAt: item.externalUpdatedAt,
          })
          .where(eq(tasks.id, existing.id));

        if (nowDone) report.tasksCompleted++;
        report.tasksUpserted++;
        report.changed = true;
      }

      // Notion relations reference page ids; translate them to local ids.
      await materializeRelationDependencies(db, userId, source.id, remote);

      // Only a full pull sees every row, so only a full pull can tell that a
      // local copy no longer belongs here: deleted in Notion, or now outside
      // the source filter. Notion itself is never touched.
      if (!since) {
        const removed = await pruneMissingTasks(db, userId, source.id, remote);
        if (removed > 0) report.changed = true;
      }

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

/** Local tasks imported from a source whose Notion row was not returned. */
export function staleTaskIds(
  local: Array<{ id: string; externalId: string | null }>,
  remoteExternalIds: Set<string>,
): string[] {
  return local
    .filter((t) => t.externalId !== null && !remoteExternalIds.has(t.externalId))
    .map((t) => t.id);
}

async function pruneMissingTasks(
  db: DB,
  userId: string,
  sourceId: string,
  remote: notion.NotionTask[],
): Promise<number> {
  const local = await db
    .select({ id: tasks.id, externalId: tasks.externalId })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.sourceId, sourceId)));

  const stale = staleTaskIds(local, new Set(remote.map((r) => r.externalId)));
  // D1 caps bound parameters at 100 per statement.
  for (let i = 0; i < stale.length; i += 90) {
    await db.delete(tasks).where(inArray(tasks.id, stale.slice(i, i + 90)));
  }
  return stale.length;
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

  // Filtered in memory: an `IN` over every related id exceeds D1's limit of
  // 100 bound parameters on a large database.
  const wanted = new Set(externalIds);
  const local = (
    await db
      .select({ id: tasks.id, externalId: tasks.externalId })
      .from(tasks)
      .where(eq(tasks.userId, userId))
  ).filter((t) => t.externalId && wanted.has(t.externalId));

  const byExternal = new Map(local.map((t) => [t.externalId!, t.id]));
  const existingEdges = new Set(
    (
      await db
        .select({ taskId: taskDependencies.taskId, dependsOnId: taskDependencies.dependsOnId })
        .from(taskDependencies)
        .where(eq(taskDependencies.userId, userId))
    ).map((e) => `${e.taskId}>${e.dependsOnId}`),
  );

  for (const item of withDeps) {
    const taskId = byExternal.get(item.externalId);
    if (!taskId) continue;

    for (const depExternal of item.dependsOnExternalIds) {
      const dependsOnId = byExternal.get(depExternal);
      // A relation may point at a page in a database we do not sync.
      if (!dependsOnId || dependsOnId === taskId) continue;
      if (existingEdges.has(`${taskId}>${dependsOnId}`)) continue;

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

  const known = new Set(existingEdges.map((e) => `${e.taskId}>${e.dependsOnId}`));
  for (const edge of inferPhaseEdges(open, map)) {
    if (known.has(`${edge.taskId}>${edge.dependsOnId}`)) continue;
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
  role: Exclude<CalendarRole, 'ignore'> = 'planner',
  calendarSummary = '',
): Promise<SyncReport> {
  const report = emptyReport();

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

  mergeReport(
    report,
    await upsertCalendarEvents(
      db,
      userId,
      calendarId,
      result.events,
      role,
      keywords,
      calendarSummary,
    ),
  );

  await upsertSyncState(db, userId, calendarId, result.nextSyncToken, null);
  if (state[0]?.lastError) report.changed = true;
  return report;
}

/**
 * All-day events are treated as soft: an all-day "Ferie" should not blank out
 * the whole day for planning purposes, whereas a timed shift must.
 */
export function classifyEvent(
  event: GoogleEvent,
  keywords: string[],
  role: Exclude<CalendarRole, 'ignore'>,
  calendarSummary = '',
): { kind: 'fixed' | 'soft'; isShift: boolean } {
  const haystack = `${event.title} ${event.location ?? ''}`.toLowerCase();
  const shiftHaystack = `${haystack} ${calendarSummary}`.toLowerCase();
  const isShift = /turno|ristorante|shift|servizio|eitje/.test(shiftHaystack);

  // An explicit Google "free" event and an all-day marker are useful context
  // but must not erase an entire planning day. A context calendar is likewise
  // visible without contributing to the busy mask.
  if (role === 'context' || event.transparent || event.allDay) {
    return { kind: 'soft', isShift };
  }
  return { kind: 'fixed', isShift };
}

/**
 * Writes one batch of events into the local mirror, whatever produced them —
 * a Google sync or an ICS feed. Both need the same classification, the same
 * content hash and the same "our own blocks are not commitments" rule.
 */
export async function upsertCalendarEvents(
  db: DB,
  userId: string,
  calendarId: string,
  events: GoogleEvent[],
  role: Exclude<CalendarRole, 'ignore'>,
  keywords: string[],
  calendarSummary = '',
): Promise<SyncReport> {
  const report = emptyReport();

  for (const event of events) {
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

    const { kind, isShift } = classifyEvent(
      event,
      keywords,
      role,
      calendarSummary,
    );
    const contentHash = [
      event.startAt,
      event.endAt,
      event.title,
      event.location,
      event.allDay,
      event.transparent,
      role,
    ].join(':');

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

  return report;
}

/**
 * A feed carries the whole calendar every time, so the snapshot it returns is
 * the truth: events it no longer lists have been deleted upstream. There is no
 * sync token to keep, only the last error.
 */
export async function syncIcsCalendar(
  env: Env,
  db: DB,
  userId: string,
  source: typeof calendarSources.$inferSelect,
): Promise<SyncReport> {
  const report = emptyReport();
  if (!source.feedUrl) {
    report.errors.push(`${source.summary}: indirizzo del calendario mancante.`);
    return report;
  }

  const prefs = await db.query.settings.findFirst({
    where: eq(settingsTable.userId, userId),
  });
  const horizonDays = prefs?.planningHorizonDays ?? 14;
  const from = Date.now() - DAY_MS;
  const to = Date.now() + (horizonDays + 7) * DAY_MS;

  const state = await db
    .select()
    .from(calendarSyncState)
    .where(
      and(
        eq(calendarSyncState.userId, userId),
        eq(calendarSyncState.calendarId, source.calendarId),
      ),
    )
    .limit(1);

  // Feeds are polled, not pushed, and publishers rate-limit: Canvas starts
  // answering 403 when asked every five minutes. A shift calendar is worth
  // checking often, a deadlines calendar is not.
  const minIntervalMs = source.role === 'busy' ? 5 * 60_000 : 30 * 60_000;
  const lastSyncedAt = state[0]?.lastSyncedAt ?? 0;
  if (!state[0]?.lastError && Date.now() - lastSyncedAt < minIntervalMs) {
    return report;
  }

  let parsed;
  try {
    parsed = await fetchIcsEvents(source.feedUrl, env.APP_TIMEZONE);
  } catch (err) {
    const pe = toPlannerError(err);
    report.errors.push(`${source.summary}: ${pe.userMessage}`);
    await upsertSyncState(db, userId, source.calendarId, null, pe.message);
    return report;
  }

  // Only the planning window matters, and keeping the rest out of D1 is what
  // holds a year-long university feed inside the per-invocation query limit.
  const inWindow = parsed.events.filter((e) => e.endAt >= from && e.startAt <= to);

  const keywords = (prefs?.fixedEventKeywords ?? '')
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);

  const upserted = await upsertCalendarEvents(
    db,
    userId,
    source.calendarId,
    inWindow,
    source.role as Exclude<CalendarRole, 'ignore'>,
    keywords,
    source.summary,
  );
  mergeReport(report, upserted);

  // Anything local that the feed no longer lists inside the window is gone.
  const seen = new Set(inWindow.map((e) => e.externalId));
  const local = await db
    .select({ id: calendarEvents.id, externalId: calendarEvents.externalId })
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.userId, userId),
        eq(calendarEvents.calendarId, source.calendarId),
        gte(calendarEvents.endAt, from),
      ),
    );
  const stale = local.filter((e) => !seen.has(e.externalId)).map((e) => e.id);
  for (let i = 0; i < stale.length; i += 90) {
    await db.delete(calendarEvents).where(inArray(calendarEvents.id, stale.slice(i, i + 90)));
    report.eventsRemoved += Math.min(90, stale.length - i);
    report.changed = true;
  }

  if (state[0]?.lastError) report.changed = true;
  await upsertSyncState(db, userId, source.calendarId, null, null);

  return report;
}

/** Sync every configured calendar and return one report to the caller. */
export async function syncCalendars(
  env: Env,
  db: DB,
  userId: string,
): Promise<SyncReport> {
  const report = emptyReport();
  const configured = await db
    .select()
    .from(calendarSources)
    .where(eq(calendarSources.userId, userId));

  // Existing installations keep working before the first discovery pass.
  if (configured.length === 0) {
    return syncCalendar(env, db, userId, 'primary', 'planner');
  }

  for (const source of configured) {
    if (!source.enabled || source.role === 'ignore') continue;

    if (source.kind === 'ics') {
      mergeReport(report, await syncIcsCalendar(env, db, userId, source));
      continue;
    }

    const one = await syncCalendar(
      env,
      db,
      userId,
      source.calendarId,
      source.role,
      source.summary,
    );
    mergeReport(report, one);
  }

  return report;
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

  const values = {
    userId,
    calendarId,
    syncToken,
    lastSyncedAt: Date.now(),
    lastError: error?.slice(0, 500),
  };

  if (existing.length === 0) {
    await db.insert(calendarSyncState).values(values).onConflictDoUpdate({
      target: [calendarSyncState.userId, calendarSyncState.calendarId],
      set: values,
    });
    return;
  }

  await db
    .update(calendarSyncState)
    .set(values)
    .where(
      and(
        eq(calendarSyncState.userId, userId),
        eq(calendarSyncState.calendarId, calendarId),
      ),
    );
}

/** Fixed commitments inside the planning window, for the busy mask. */
export async function loadBusyIntervals(
  db: DB,
  userId: string,
  from: number,
  to: number,
): Promise<Array<{ start: number; end: number; isShift: boolean }>> {
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
    .map((e) => ({ start: e.startAt, end: e.endAt, isShift: e.isShift }));
}

export { PlannerError };
