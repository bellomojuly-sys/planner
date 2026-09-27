import { and, eq, gt, inArray, ne, or } from 'drizzle-orm';
import type { DB } from '../db/client';
import {
  tasks,
  taskDependencies,
  scheduledBlocks,
  scheduleRuns,
  settings as settingsTable,
  outbox,
  taskSources,
  calendarSources,
  calendarSyncState,
  calendarEvents,
  type Settings,
} from '../db/schema';
import { schedule } from '../scheduler/engine';
import type {
  PlanDecision,
  PlacedBlock,
  SchedulableTask,
  ScheduleResult,
} from '../scheduler/types';
import { buildDecisionBriefing, markMoved } from '../scheduler/decisions';
import {
  applyCalendarPersonalRules,
  withoutSuppressedBuffers,
  applyTaskPersonalRules,
} from '../scheduler/personal-rules';
import type { DepMap } from '../scheduler/dependencies';
import {
  loadBusyIntervals,
  loadPlanningContexts,
  inferPhaseDependencies,
} from './sync';
import { getCalendarRoutingMap, getPlannerCalendarId } from './calendar-sources';
import { loadSuppressionKeys } from './manual-edits';
import { DAY_MS, localDateKey, formatRange } from '../lib/time';
import { toPlannerError } from '../lib/errors';
import type { Env } from '../env';
import {
  confirmationReasons,
  confirmationReasonMessage,
  type ConfirmationReason,
} from './replan-policy';
import { isTaskSourceEnabled } from './task-source-policy';

export type RescheduleTrigger =
  | 'cron'
  | 'capture'
  | 'manual'
  | 'calendar_change'
  | 'task_moved'
  | 'urgent_task'
  | 'dependency_cascade';

export interface PlanDiff {
  created: number;
  moved: number;
  removed: number;
  unplaced: Array<{ title: string; reason: string; outcome: string }>;
  decisions: PlanDecision[];
  briefing: string[];
  warnings: string[];
  /** Italian one-liners describing what changed, for the UI and notifications. */
  changes: string[];
  /** False when the existing published plan was deliberately left untouched. */
  applied: boolean;
  requiresConfirmation: boolean;
  confirmationReasons: ConfirmationReason[];
  blockedByStaleData: boolean;
}

export interface ReplanOptions {
  /** Explicit approval from the full-access UI for this freshly recomputed plan. */
  confirmed?: boolean;
  /** Errors from the sync cycle that immediately preceded this replan. */
  syncErrors?: string[];
}

export interface CalendarBlockMove {
  blockId: string;
  start: number;
  end: number;
}

/**
 * Recomputes the plan from now to the horizon and reconciles it with what is
 * already on the calendar.
 *
 * Reconciliation matters as much as the scheduling: naively deleting and
 * recreating every block would churn Google Calendar, drop notification state,
 * and make the calendar flash on every five-minute cron tick. Instead blocks
 * are matched by identity, and only genuinely-changed times are pushed.
 */
export async function replan(
  env: Env,
  db: DB,
  userId: string,
  trigger: RescheduleTrigger,
  options: ReplanOptions = {},
): Promise<PlanDiff> {
  const startedAt = Date.now();
  // A proposal is valid only against the exact inputs used to compute it.
  // Any later attempt supersedes older pending proposals before doing work.
  await db
    .update(scheduleRuns)
    .set({ status: 'superseded', finishedAt: Date.now() })
    .where(
      and(
        eq(scheduleRuns.userId, userId),
        eq(scheduleRuns.status, 'pending_confirmation'),
      ),
    );
  const [run] = await db
    .insert(scheduleRuns)
    .values({ userId, trigger, status: 'running' })
    .returning({ id: scheduleRuns.id });

  try {
    await purgeDisabledSourceBlocks(db, userId);
    const dataIssues = await loadPlanningDataIssues(db, userId, options.syncErrors);
    const dataWarnings = dataIssues.warnings;
    if (dataIssues.blocking.length > 0) {
      const diff: PlanDiff = {
        created: 0,
        moved: 0,
        removed: 0,
        unplaced: [],
        decisions: [],
        briefing: [
          'Piano invariato: una fonte necessaria non è sincronizzata.',
        ],
        warnings: [
          'Il piano non è stato aggiornato perché Notion o Google Calendar non sono sincronizzati.',
          ...dataIssues.blocking,
        ],
        changes: [],
        applied: false,
        requiresConfirmation: false,
        confirmationReasons: [],
        blockedByStaleData: true,
      };

      await db
        .update(scheduleRuns)
        .set({
          status: 'blocked_stale_data',
          summary: diff,
          finishedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        })
        .where(eq(scheduleRuns.id, run!.id));

      return diff;
    }

    // Phase chains are derived from titles, so they must be refreshed before
    // the dependency graph is read — a "Fase 16" added by voice a moment ago
    // has to be linked to "Fase 15" on this same pass.
    await inferPhaseDependencies(db, userId);

    const prefs = await loadSettings(db, userId);
    const now = Date.now();
    const horizonEnd = now + prefs.planningHorizonDays * DAY_MS;

    const [
      openTasks,
      deps,
      busyRows,
      contextRows,
      existingBlocks,
      calendarRouting,
      completedGymAt,
      suppressedKeys,
    ] = await Promise.all([
      loadSchedulableTasks(db, userId, prefs.settings),
      loadDependencies(db, userId),
      loadBusyIntervals(db, userId, now, horizonEnd),
      loadPlanningContexts(db, userId, now, horizonEnd),
      loadFutureBlocks(db, userId, now),
      getCalendarRoutingMap(db, userId),
      loadCompletedGymAt(db, userId, Date.now()),
      loadSuppressionKeys(db, userId, localDateKey(now, prefs.timezone)),
    ]);

    const withRules = applyCalendarPersonalRules(
      busyRows,
      contextRows,
      prefs.settings,
      prefs.timezone,
    );
    const busy = withoutSuppressedBuffers(withRules.busy, suppressedKeys, prefs.timezone);
    const contexts = withoutSuppressedBuffers(
      withRules.contexts,
      suppressedKeys,
      prefs.timezone,
    );

    const pinnedBlocks: PlacedBlock[] = existingBlocks
      .filter((b) => b.pinned)
      .map(toPlacedBlock);

    // Completed prerequisites must not strand their dependents: seed their end
    // instants so `earliestStartFor` resolves instead of returning null.
    const knownTaskEnds = await loadCompletedTaskEnds(db, userId);

    const result = schedule({
      now,
      horizonEnd,
      timezone: prefs.timezone,
      settings: prefs.settings,
      tasks: openTasks,
      dependencies: deps,
      busy,
      contexts,
      pinnedBlocks,
      knownTaskEnds,
      completedGymAt,
      suppressedKeys,
    });

    const evaluated = withMoveDecisions(result, existingBlocks, prefs.timezone);
    const preview = previewPlanDiff(existingBlocks, evaluated, prefs.timezone);
    const reasons = confirmationReasons(existingBlocks, evaluated, now, prefs.timezone);

    if (reasons.length > 0 && !options.confirmed) {
      const diff: PlanDiff = {
        ...preview,
        warnings: [
          ...dataWarnings,
          ...preview.warnings,
          ...reasons.map(confirmationReasonMessage),
        ],
        applied: false,
        requiresConfirmation: true,
        confirmationReasons: reasons,
        blockedByStaleData: false,
      };

      await db
        .update(scheduleRuns)
        .set({
          status: 'pending_confirmation',
          blocksPlaced: diff.created,
          blocksMoved: diff.moved,
          tasksUnplaced: diff.unplaced.length,
          summary: diff,
          finishedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        })
        .where(eq(scheduleRuns.id, run!.id));

      return diff;
    }

    const diff = await reconcileBlocks(
      db,
      userId,
      prefs.timezone,
      existingBlocks,
      evaluated,
      calendarRouting,
    );

    if (dataWarnings.length > 0) {
      diff.warnings = [...dataWarnings, ...diff.warnings];
    }

    await db
      .update(scheduleRuns)
      .set({
        status: diff.unplaced.length > 0 ? 'partial' : 'ok',
        blocksPlaced: diff.created,
        blocksMoved: diff.moved,
        tasksUnplaced: diff.unplaced.length,
        summary: diff,
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      })
      .where(eq(scheduleRuns.id, run!.id));

    return diff;
  } catch (err) {
    const pe = toPlannerError(err);
    await db
      .update(scheduleRuns)
      .set({
        status: 'failed',
        error: pe.message.slice(0, 500),
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      })
      .where(eq(scheduleRuns.id, run!.id));
    throw pe;
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function loadSettings(
  db: DB,
  userId: string,
): Promise<{ settings: Settings; timezone: string; planningHorizonDays: number }> {
  let prefs = await db.query.settings.findFirst({
    where: eq(settingsTable.userId, userId),
  });

  if (!prefs) {
    [prefs] = await db.insert(settingsTable).values({ userId }).returning();
  }

  const user = await db.query.users.findFirst({
    where: (u, { eq: e }) => e(u.id, userId),
  });

  return {
    settings: prefs!,
    timezone: user?.timezone ?? 'Europe/Rome',
    planningHorizonDays: prefs!.planningHorizonDays,
  };
}

/**
 * Disabling a task source takes its work out of the plan: the scheduled blocks
 * of its tasks are deleted locally and in Google, and the tasks drop back to the
 * backlog. Pinned blocks are included — a pin cannot keep a task from a source
 * Giulia has switched off. The task rows are kept (never deleted) so re-enabling
 * the source can replan them. Runs before every replan and is idempotent: with
 * no blocks from a disabled source it makes no change.
 */
async function purgeDisabledSourceBlocks(db: DB, userId: string): Promise<void> {
  const disabledTasks = await db
    .select({ id: tasks.id })
    .from(tasks)
    .innerJoin(taskSources, eq(tasks.sourceId, taskSources.id))
    .where(and(eq(tasks.userId, userId), eq(taskSources.enabled, false)));
  if (disabledTasks.length === 0) return;

  const taskIds = disabledTasks.map((task) => task.id);
  const blocks = await db
    .select()
    .from(scheduledBlocks)
    .where(
      and(eq(scheduledBlocks.userId, userId), inArray(scheduledBlocks.taskId, taskIds)),
    );

  if (blocks.length > 0) {
    const fallbackCalendar = await getPlannerCalendarId(db, userId);
    for (const block of blocks) {
      if (block.googleEventId) {
        await db.insert(outbox).values({
          userId,
          kind: 'google_delete',
          payload: {
            eventId: block.googleEventId,
            calendarId: block.calendarId ?? fallbackCalendar,
          },
        });
      }
    }
    await db
      .delete(scheduledBlocks)
      .where(inArray(scheduledBlocks.id, blocks.map((block) => block.id)));
  }

  // Leave the backlog consistent so a later re-enable replans cleanly.
  await db
    .update(tasks)
    .set({ status: 'todo' })
    .where(
      and(
        eq(tasks.userId, userId),
        inArray(tasks.id, taskIds),
        eq(tasks.status, 'scheduled'),
      ),
    );
}

/**
 * Splits data problems into the ones that must hold the last plan (`blocking`)
 * and the ones worth surfacing while still replanning (`warnings`). A failed
 * feed fetch never deletes the events already stored (see `syncIcsCalendar`),
 * so a source whose data is cached can still be planned around: a single dead
 * ICS feed must not freeze the whole planner indefinitely. Only a required
 * source with no usable data at all is a reason to keep the previous plan.
 */
async function loadPlanningDataIssues(
  db: DB,
  userId: string,
  currentErrors: string[] = [],
): Promise<{ blocking: string[]; warnings: string[] }> {
  const [notionSources, configuredCalendars, calendarStates, eventCalendars] =
    await Promise.all([
      db
        .select()
        .from(taskSources)
        .where(and(eq(taskSources.userId, userId), eq(taskSources.enabled, true))),
      db
        .select()
        .from(calendarSources)
        .where(and(eq(calendarSources.userId, userId), eq(calendarSources.enabled, true))),
      db
        .select()
        .from(calendarSyncState)
        .where(eq(calendarSyncState.userId, userId)),
      db
        .selectDistinct({ calendarId: calendarEvents.calendarId })
        .from(calendarEvents)
        .where(eq(calendarEvents.userId, userId)),
    ]);

  const haveCachedEvents = new Set(eventCalendars.map((row) => row.calendarId));
  const blocking = new Set<string>();
  const warnings = new Set(currentErrors.filter(Boolean));

  for (const source of notionSources) {
    if (!source.lastSyncError) continue;
    const message = `${source.name}: ${source.lastSyncError}`;
    // A source that has synced before still holds its imported tasks.
    if (source.lastSyncedAt) warnings.add(message);
    else blocking.add(message);
  }

  // Only calendars that carry commitments are required input. A context
  // calendar holds deadlines and markers: losing it for an hour is worth a
  // warning, not a reason to stop replanning around real shifts.
  const activeCalendarIds = new Set(
    configuredCalendars.length === 0
      ? calendarStates.map((state) => state.calendarId)
      : configuredCalendars
          .filter((source) => source.role === 'busy' || source.role === 'planner')
          .map((source) => source.calendarId),
  );
  const calendarLabel = new Map(
    configuredCalendars.map((source) => [source.calendarId, source.summary]),
  );
  for (const state of calendarStates) {
    if (!activeCalendarIds.has(state.calendarId) || !state.lastError) continue;
    const label = calendarLabel.get(state.calendarId) ?? state.calendarId;
    // A busy calendar whose feed is failing but whose events are already cached
    // is planned around the saved copy — a broken feed only warns, it does not
    // block. Without any cached events there is nothing to plan around, so the
    // last plan is held.
    if (haveCachedEvents.has(state.calendarId)) {
      warnings.add(`${label}: uso l’ultimo orario salvato (sincronizzazione non riuscita).`);
    } else {
      blocking.add(`${label}: ${state.lastError}`);
    }
  }

  return { blocking: [...blocking], warnings: [...warnings] };
}

async function loadSchedulableTasks(
  db: DB,
  userId: string,
  settings: Settings,
): Promise<SchedulableTask[]> {
  const [rows, enabledSources] = await Promise.all([
    db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          ne(tasks.status, 'done'),
          ne(tasks.status, 'cancelled'),
          // Deleted from the plan by hand: open, but not for the scheduler.
          eq(tasks.schedulingPaused, false),
        ),
      ),
    db
      .select({ id: taskSources.id })
      .from(taskSources)
      .where(and(eq(taskSources.userId, userId), eq(taskSources.enabled, true))),
  ]);

  const enabledSourceIds = new Set(enabledSources.map((source) => source.id));

  return rows
    .filter((task) => isTaskSourceEnabled(task.sourceId, enabledSourceIds))
    .map((t) => applyTaskPersonalRules(
      {
        id: t.id,
        title: t.title,
        area: t.area,
        energy: t.energy,
        location: t.location,
        travelMinutes: t.travelMinutes,
        preparationMinutes: t.preparationMinutes,
        recoveryMinutes: t.recoveryMinutes,
        flexibility: t.flexibility,
        priority: t.priority,
        plannedMinutes: t.plannedMinutes,
        dueAt: t.dueAt,
        earliestStartAt: t.earliestStartAt,
        splittable: t.splittable,
        pinned: t.pinned,
        isGym: t.isGym,
        status: t.status,
        projectKey: t.projectKey,
        phaseOrder: t.phaseOrder,
        horizon: t.horizon,
      },
      settings,
    ));
}

async function loadDependencies(db: DB, userId: string): Promise<DepMap> {
  const rows = await db
    .select()
    .from(taskDependencies)
    .where(eq(taskDependencies.userId, userId));

  const map: DepMap = new Map();
  for (const row of rows) {
    const list = map.get(row.taskId) ?? [];
    list.push({ dependsOnId: row.dependsOnId, lagMinutes: row.lagMinutes });
    map.set(row.taskId, list);
  }
  return map;
}

async function loadCompletedTaskEnds(
  db: DB,
  userId: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({ id: tasks.id, completedAt: tasks.completedAt })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.status, 'done')));

  return new Map(rows.map((r) => [r.id, r.completedAt ?? 0]));
}

async function loadCompletedGymAt(
  db: DB,
  userId: string,
  now: number,
): Promise<number[]> {
  const rows = await db
    .select({ completedAt: tasks.completedAt })
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        eq(tasks.status, 'done'),
        eq(tasks.isGym, true),
        gt(tasks.completedAt, now - 7 * DAY_MS),
      ),
    );
  return rows
    .map((row) => row.completedAt)
    .filter((value): value is number => value !== null);
}

async function loadFutureBlocks(db: DB, userId: string, now: number) {
  return db
    .select()
    .from(scheduledBlocks)
    .where(and(eq(scheduledBlocks.userId, userId), gt(scheduledBlocks.endAt, now)));
}

function toPlacedBlock(b: typeof scheduledBlocks.$inferSelect): PlacedBlock {
  return {
    taskId: b.taskId,
    title: b.title,
    start: b.startAt,
    end: b.endAt,
    kind: b.kind === 'gym' ? 'gym' : b.kind === 'buffer' ? 'buffer' : 'task',
    zone: 'morning',
    partIndex: b.partIndex,
    partCount: b.partCount,
    zoneCompromised: false,
  };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Stable identity for a block across replans. Task blocks are keyed by task
 * and part. Generated reality blocks have no task, so their title keeps
 * preparation, travel, gym and return components distinct on the same day.
 */
function blockKey(
  block: {
    taskId: string | null;
    title: string;
    partIndex: number;
    kind: string;
    start: number;
  },
  timezone: string,
): string {
  if (block.taskId && block.kind === 'task') {
    return `task:${block.taskId}:${block.partIndex}`;
  }
  if (block.taskId) {
    return `task:${block.taskId}:${block.kind}:${block.partIndex}`;
  }
  const title = block.title.trim().toLocaleLowerCase('it-IT').replace(/\s+/g, ' ');
  return `${block.kind}:${localDateKey(block.start, timezone)}:${title}:${block.partIndex}`;
}

function withMoveDecisions(
  result: ScheduleResult,
  existing: Array<typeof scheduledBlocks.$inferSelect>,
  timezone: string,
): ScheduleResult {
  const existingByKey = new Map(
    existing.map((block) => [
      blockKey(
        {
          taskId: block.taskId,
          title: block.title,
          partIndex: block.partIndex,
          kind: block.kind,
          start: block.startAt,
        },
        timezone,
      ),
      block,
    ]),
  );
  const movedTaskIds = new Set<string>();
  for (const block of result.blocks) {
    if (!block.taskId || block.kind !== 'task') continue;
    const prior = existingByKey.get(blockKey(block, timezone));
    if (
      prior &&
      !prior.pinned &&
      (prior.startAt !== block.start ||
        prior.endAt !== block.end ||
        prior.title !== block.title)
    ) {
      movedTaskIds.add(block.taskId);
    }
  }

  const decisions = markMoved(result.decisions, movedTaskIds);
  return {
    ...result,
    decisions,
    briefing: buildDecisionBriefing({
      decisions,
      fixedCommitments: result.fixedCommitments,
    }),
  };
}

function previewPlanDiff(
  existing: Array<typeof scheduledBlocks.$inferSelect>,
  result: ScheduleResult,
  timezone: string,
): Omit<
  PlanDiff,
  'applied' | 'requiresConfirmation' | 'confirmationReasons' | 'blockedByStaleData'
> {
  const decisionById = new Map(
    result.decisions.map((decision) => [decision.taskId, decision]),
  );
  const diff = {
    created: 0,
    moved: 0,
    removed: 0,
    unplaced: result.unplaced.map((item) => ({
      title: item.title,
      reason: item.reason,
      outcome: decisionById.get(item.taskId)?.outcome ?? 'postpone',
    })),
    decisions: result.decisions,
    briefing: result.briefing,
    warnings: [...result.warnings],
    changes: [] as string[],
  };
  const existingByKey = new Map(
    existing.map((block) => [
      blockKey(
        {
          taskId: block.taskId,
          title: block.title,
          partIndex: block.partIndex,
          kind: block.kind,
          start: block.startAt,
        },
        timezone,
      ),
      block,
    ]),
  );
  const seen = new Set<string>();

  for (const block of result.blocks) {
    const key = blockKey(block, timezone);
    seen.add(key);
    const prior = existingByKey.get(key);
    if (!prior) {
      diff.created++;
      diff.changes.push(
        `Aggiunto: ${block.title} — ${formatRange(block.start, block.end, timezone)}`,
      );
      continue;
    }
    if (prior.pinned) continue;
    if (
      prior.startAt !== block.start ||
      prior.endAt !== block.end ||
      prior.title !== block.title
    ) {
      diff.moved++;
      diff.changes.push(
        `Spostato: ${block.title} → ${formatRange(block.start, block.end, timezone)}`,
      );
    }
  }

  const conflictingTaskIds = new Set(
    result.unplaced
      .filter((item) => item.reason === 'pinned_conflict')
      .map((item) => item.taskId),
  );
  for (const [key, block] of existingByKey) {
    if (seen.has(key) || (block.pinned && !block.taskId) ||
        (block.pinned && block.taskId && !conflictingTaskIds.has(block.taskId))) {
      continue;
    }
    diff.removed++;
    diff.changes.push(`Rimosso: ${block.title}`);
  }

  return diff;
}

async function reconcileBlocks(
  db: DB,
  userId: string,
  timezone: string,
  existing: Array<typeof scheduledBlocks.$inferSelect>,
  result: ScheduleResult,
  calendarRouting: Awaited<ReturnType<typeof getCalendarRoutingMap>>,
): Promise<PlanDiff> {
  const decisionById = new Map(
    result.decisions.map((decision) => [decision.taskId, decision]),
  );
  const diff: PlanDiff = {
    created: 0,
    moved: 0,
    removed: 0,
    unplaced: result.unplaced.map((u) => ({
      title: u.title,
      reason: u.reason,
      outcome: decisionById.get(u.taskId)?.outcome ?? 'postpone',
    })),
    decisions: result.decisions,
    briefing: result.briefing,
    warnings: result.warnings,
    changes: [],
    applied: true,
    requiresConfirmation: false,
    confirmationReasons: [],
    blockedByStaleData: false,
  };

  const existingByKey = new Map(
    existing.map((b) => [
      blockKey(
        {
          taskId: b.taskId,
          title: b.title,
          partIndex: b.partIndex,
          kind: b.kind,
          start: b.startAt,
        },
        timezone,
      ),
      b,
    ]),
  );

  const seen = new Set<string>();

  for (const block of result.blocks) {
    const targetCalendarId = calendarForBlock(block, calendarRouting);
    const key = blockKey(
      {
        taskId: block.taskId,
        title: block.title,
        partIndex: block.partIndex,
        kind: block.kind,
        start: block.start,
      },
      timezone,
    );
    seen.add(key);

    const prior = existingByKey.get(key);

    if (!prior) {
      const [inserted] = await db
        .insert(scheduledBlocks)
        .values({
          userId,
          taskId: block.taskId,
          title: block.title,
          startAt: block.start,
          endAt: block.end,
          kind: block.kind,
          partIndex: block.partIndex,
          partCount: block.partCount,
          syncState: 'pending',
          calendarId: targetCalendarId,
        })
        .returning({ id: scheduledBlocks.id });

      await enqueueCalendarUpsert(db, userId, inserted!.id, targetCalendarId);
      diff.created++;
      diff.changes.push(
        `Aggiunto: ${block.title} — ${formatRange(block.start, block.end, timezone)}`,
      );
      continue;
    }

    const routeChanged =
      (prior.calendarId ?? calendarRouting.fallback) !== targetCalendarId;
    const routeMetadataMissing = shouldBackfillCalendarId(
      prior.calendarId,
      targetCalendarId,
      calendarRouting.fallback,
    );

    // Older rows predate calendar_id. Their Google event already lives in the
    // fallback Planner calendar, so repair the local routing metadata without
    // deleting or recreating the event. This also applies to pinned blocks.
    if (routeMetadataMissing) {
      await db
        .update(scheduledBlocks)
        .set({ calendarId: targetCalendarId })
        .where(eq(scheduledBlocks.id, prior.id));
    }

    // Pinned blocks are re-emitted unchanged; nothing else to do.
    if (prior.pinned) continue;

    const unchanged =
      prior.startAt === block.start &&
      prior.endAt === block.end &&
      prior.title === block.title &&
      !routeChanged;

    if (unchanged) continue;

    if (routeChanged && prior.googleEventId) {
      await db.insert(outbox).values({
        userId,
        kind: 'google_delete',
        payload: {
          eventId: prior.googleEventId,
          calendarId: prior.calendarId ?? calendarRouting.fallback,
        },
      });
    }

    await db
      .update(scheduledBlocks)
      .set({
        title: block.title,
        startAt: block.start,
        endAt: block.end,
        partCount: block.partCount,
        syncState: 'pending',
        calendarId: targetCalendarId,
        ...(routeChanged ? { googleEventId: null } : {}),
      })
      .where(eq(scheduledBlocks.id, prior.id));

    await enqueueCalendarUpsert(db, userId, prior.id, targetCalendarId);
    diff.moved++;
    diff.changes.push(
      `Spostato: ${block.title} → ${formatRange(block.start, block.end, timezone)}`,
    );
  }

  // Anything we no longer plan gets removed locally and in Google.
  const conflictingTaskIds = new Set(
    result.unplaced
      .filter((item) => item.reason === 'pinned_conflict')
      .map((item) => item.taskId),
  );
  for (const [key, block] of existingByKey) {
    if (
      seen.has(key) ||
      (block.pinned && (!block.taskId || !conflictingTaskIds.has(block.taskId)))
    ) {
      continue;
    }

    if (block.googleEventId) {
      await db.insert(outbox).values({
        userId,
        kind: 'google_delete',
        payload: {
          eventId: block.googleEventId,
          calendarId: block.calendarId ?? calendarRouting.fallback,
        },
      });
    }
    await db.delete(scheduledBlocks).where(eq(scheduledBlocks.id, block.id));
    diff.removed++;
    diff.changes.push(`Rimosso: ${block.title}`);
  }

  // Reflect placement back onto the tasks so the UI can show status without
  // joining through blocks.
  const scheduledTaskIds = [
    ...new Set(result.blocks.map((b) => b.taskId).filter((id): id is string => !!id)),
  ];
  if (scheduledTaskIds.length > 0) {
    await db
      .update(tasks)
      .set({ status: 'scheduled' })
      .where(
        and(
          eq(tasks.userId, userId),
          inArray(tasks.id, scheduledTaskIds),
          or(eq(tasks.status, 'todo'), eq(tasks.status, 'inbox')),
        ),
      );
  }

  const unplacedIds = result.unplaced.map((u) => u.taskId);
  if (unplacedIds.length > 0) {
    await db
      .update(tasks)
      .set({ status: 'todo' })
      .where(
        and(
          eq(tasks.userId, userId),
          inArray(tasks.id, unplacedIds),
          eq(tasks.status, 'scheduled'),
        ),
      );
  }

  return diff;
}

/** A null route on a legacy block means the then-current fallback calendar. */
export function shouldBackfillCalendarId(
  priorCalendarId: string | null,
  targetCalendarId: string,
  fallbackCalendarId: string,
): boolean {
  return priorCalendarId === null && targetCalendarId === fallbackCalendarId;
}

function calendarForBlock(
  block: PlacedBlock,
  routing: Awaited<ReturnType<typeof getCalendarRoutingMap>>,
): string {
  if (block.kind === 'buffer' && block.area) {
    return routing.byArea[block.area] || routing.fallback;
  }
  if (block.kind === 'gym' || block.kind === 'buffer') {
    return routing.byArea.gym ?? routing.byArea.health ?? routing.fallback;
  }
  return (block.area && routing.byArea[block.area]) || routing.fallback;
}

async function enqueueCalendarUpsert(
  db: DB,
  userId: string,
  blockId: string,
  calendarId: string,
): Promise<void> {
  await db.insert(outbox).values({
    userId,
    kind: 'google_upsert',
    payload: { blockId, calendarId },
  });
}

/**
 * Moving one block by hand temporarily pins it through the immediate cascade.
 * It is released afterwards, so only “non spostare questo task” is permanent.
 */
export async function moveBlock(
  env: Env,
  db: DB,
  userId: string,
  blockId: string,
  newStart: number,
  newEnd: number,
): Promise<PlanDiff> {
  const block = await db.query.scheduledBlocks.findFirst({
    where: and(eq(scheduledBlocks.id, blockId), eq(scheduledBlocks.userId, userId)),
  });
  if (!block) {
    throw toPlannerError(new Error('block not found'));
  }

  const delta = newStart - block.startAt;
  const plannerCalendarId = await getPlannerCalendarId(db, userId);

  // A gym session stands alone; a task block may be one sitting of several.
  if (!block.taskId) {
    await db
      .update(scheduledBlocks)
      .set({ startAt: newStart, endAt: newEnd, pinned: true, syncState: 'pending' })
      .where(eq(scheduledBlocks.id, blockId));

    await enqueueCalendarUpsert(
      db,
      userId,
      blockId,
      block.calendarId ?? plannerCalendarId,
    );
    const diff = await replan(env, db, userId, 'task_moved', { confirmed: true });
    await db
      .update(scheduledBlocks)
      .set({ pinned: false })
      .where(eq(scheduledBlocks.id, blockId));
    return diff;
  }

  const task = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, block.taskId), eq(tasks.userId, userId)),
  });
  const wasPermanent = task?.pinned ?? false;

  /**
   * Dragging one part of a split task moves the whole task, keeping the gaps
   * between its sittings.
   *
   * Pinning the task is what freezes it against the next replan — but a pinned
   * task is excluded from scheduling entirely, so any part left behind would
   * simply be dropped. Moving every part together keeps the full duration on
   * the calendar and matches the intent anyway: "do this on Sunday instead".
   */
  const siblings = await db
    .select()
    .from(scheduledBlocks)
    .where(
      and(eq(scheduledBlocks.userId, userId), eq(scheduledBlocks.taskId, block.taskId)),
    );

  for (const part of siblings) {
    const isDragged = part.id === blockId;
    await db
      .update(scheduledBlocks)
      .set({
        // The dragged part takes the exact times from the gesture; the others
        // shift by the same delta so the spacing survives.
        startAt: isDragged ? newStart : part.startAt + delta,
        endAt: isDragged ? newEnd : part.endAt + delta,
        pinned: true,
        syncState: 'pending',
      })
      .where(eq(scheduledBlocks.id, part.id));

    await enqueueCalendarUpsert(
      db,
      userId,
      part.id,
      part.calendarId ?? plannerCalendarId,
    );
  }

  const earliest = Math.min(
    newStart,
    ...siblings.filter((p) => p.id !== blockId).map((p) => p.startAt + delta),
  );

  // The task can no longer start before this, which is what makes dependents
  // shift on the next pass.
  await db
    .update(tasks)
    .set({ pinned: true, earliestStartAt: earliest })
    .where(eq(tasks.id, block.taskId));

  const diff = await replan(env, db, userId, 'task_moved', { confirmed: true });

  if (!wasPermanent) {
    await db
      .update(scheduledBlocks)
      .set({ pinned: false })
      .where(
        and(eq(scheduledBlocks.userId, userId), eq(scheduledBlocks.taskId, block.taskId)),
      );
    await db
      .update(tasks)
      .set({ pinned: false })
      .where(and(eq(tasks.id, block.taskId), eq(tasks.userId, userId)));
  }

  return diff;
}

/**
 * Applies Google Calendar drags as one atomic planning gesture. The moved
 * blocks are pinned only for this cascade, exactly like a drag in Planner;
 * only an explicit "non spostare" remains permanent.
 */
export async function applyPlannerCalendarMoves(
  env: Env,
  db: DB,
  userId: string,
  rawMoves: CalendarBlockMove[],
): Promise<PlanDiff | null> {
  const moves = [...new Map(rawMoves.map((move) => [move.blockId, move])).values()];
  if (moves.length === 0) return null;

  const plannerCalendarId = await getPlannerCalendarId(db, userId);
  const movedById = new Map(moves.map((move) => [move.blockId, move]));
  const handledTasks = new Set<string>();
  const temporaryTaskIds = new Set<string>();
  const temporaryStandaloneIds = new Set<string>();

  for (const move of moves) {
    const block = await db.query.scheduledBlocks.findFirst({
      where: and(
        eq(scheduledBlocks.id, move.blockId),
        eq(scheduledBlocks.userId, userId),
      ),
    });
    if (!block) continue;

    if (!block.taskId) {
      await db
        .update(scheduledBlocks)
        .set({
          startAt: move.start,
          endAt: move.end,
          pinned: true,
          syncState: 'pending',
        })
        .where(eq(scheduledBlocks.id, block.id));
      temporaryStandaloneIds.add(block.id);
      await enqueueCalendarUpsert(
        db,
        userId,
        block.id,
        block.calendarId ?? plannerCalendarId,
      );
      continue;
    }

    if (handledTasks.has(block.taskId)) continue;
    handledTasks.add(block.taskId);

    const task = await db.query.tasks.findFirst({
      where: and(eq(tasks.id, block.taskId), eq(tasks.userId, userId)),
    });
    if (!task) continue;

    const siblings = await db
      .select()
      .from(scheduledBlocks)
      .where(
        and(
          eq(scheduledBlocks.userId, userId),
          eq(scheduledBlocks.taskId, block.taskId),
        ),
      );
    const delta = move.start - block.startAt;
    let earliest = Number.POSITIVE_INFINITY;

    for (const part of siblings) {
      const explicit = movedById.get(part.id);
      const startAt = explicit?.start ?? part.startAt + delta;
      const endAt = explicit?.end ?? part.endAt + delta;
      earliest = Math.min(earliest, startAt);
      await db
        .update(scheduledBlocks)
        .set({ startAt, endAt, pinned: true, syncState: 'pending' })
        .where(eq(scheduledBlocks.id, part.id));
      await enqueueCalendarUpsert(
        db,
        userId,
        part.id,
        part.calendarId ?? plannerCalendarId,
      );
    }

    await db
      .update(tasks)
      .set({ pinned: true, earliestStartAt: earliest })
      .where(and(eq(tasks.id, block.taskId), eq(tasks.userId, userId)));
    if (!task.pinned) temporaryTaskIds.add(block.taskId);
  }

  if (handledTasks.size === 0 && temporaryStandaloneIds.size === 0) return null;

  try {
    return await replan(env, db, userId, 'task_moved', { confirmed: true });
  } finally {
    for (const taskId of temporaryTaskIds) {
      await db
        .update(scheduledBlocks)
        .set({ pinned: false })
        .where(
          and(eq(scheduledBlocks.userId, userId), eq(scheduledBlocks.taskId, taskId)),
        );
      await db
        .update(tasks)
        .set({ pinned: false })
        .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)));
    }
    for (const blockId of temporaryStandaloneIds) {
      await db
        .update(scheduledBlocks)
        .set({ pinned: false })
        .where(and(eq(scheduledBlocks.id, blockId), eq(scheduledBlocks.userId, userId)));
    }
  }
}

/** Releases a manual placement so the scheduler may optimise it again. */
export async function unpinBlock(
  env: Env,
  db: DB,
  userId: string,
  blockId: string,
): Promise<PlanDiff> {
  const block = await db.query.scheduledBlocks.findFirst({
    where: and(eq(scheduledBlocks.id, blockId), eq(scheduledBlocks.userId, userId)),
  });
  if (!block) throw toPlannerError(new Error('block not found'));

  if (!block.taskId) {
    await db
      .update(scheduledBlocks)
      .set({ pinned: false })
      .where(eq(scheduledBlocks.id, blockId));
    return replan(env, db, userId, 'manual');
  }

  // Unpinning mirrors moving: the whole task is released, so the scheduler can
  // re-split and re-place it freely.
  await db
    .update(scheduledBlocks)
    .set({ pinned: false })
    .where(eq(scheduledBlocks.taskId, block.taskId));

  await db
    .update(tasks)
    .set({ pinned: false, earliestStartAt: null })
    .where(eq(tasks.id, block.taskId));

  return replan(env, db, userId, 'manual');
}
