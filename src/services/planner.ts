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
  type Settings,
} from '../db/schema';
import { schedule } from '../scheduler/engine';
import type {
  PlacedBlock,
  SchedulableTask,
  ScheduleResult,
} from '../scheduler/types';
import type { DepMap } from '../scheduler/dependencies';
import { loadBusyIntervals, inferPhaseDependencies } from './sync';
import { getCalendarRoutingMap, getPlannerCalendarId } from './calendar-sources';
import { DAY_MS, localDateKey, formatRange } from '../lib/time';
import { toPlannerError } from '../lib/errors';
import type { Env } from '../env';
import {
  confirmationReasons,
  confirmationReasonMessage,
  type ConfirmationReason,
} from './replan-policy';

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
  unplaced: Array<{ title: string; reason: string }>;
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
    const dataIssues = await loadPlanningDataIssues(db, userId, options.syncErrors);
    if (dataIssues.length > 0) {
      const diff: PlanDiff = {
        created: 0,
        moved: 0,
        removed: 0,
        unplaced: [],
        warnings: [
          'Il piano non è stato aggiornato perché Notion o Google Calendar non sono sincronizzati.',
          ...dataIssues,
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
      busy,
      existingBlocks,
      calendarRouting,
      completedGymAt,
    ] = await Promise.all([
      loadSchedulableTasks(db, userId),
      loadDependencies(db, userId),
      loadBusyIntervals(db, userId, now, horizonEnd),
      loadFutureBlocks(db, userId, now),
      getCalendarRoutingMap(db, userId),
      loadCompletedGymAt(db, userId, Date.now()),
    ]);

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
      pinnedBlocks,
      knownTaskEnds,
      completedGymAt,
    });

    const preview = previewPlanDiff(existingBlocks, result, prefs.timezone);
    const reasons = confirmationReasons(existingBlocks, result, now, prefs.timezone);

    if (reasons.length > 0 && !options.confirmed) {
      const diff: PlanDiff = {
        ...preview,
        warnings: [
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
      result,
      calendarRouting,
    );

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

async function loadPlanningDataIssues(
  db: DB,
  userId: string,
  currentErrors: string[] = [],
): Promise<string[]> {
  const [notionSources, configuredCalendars, calendarStates] = await Promise.all([
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
  ]);

  const issues = new Set(currentErrors.filter(Boolean));
  for (const source of notionSources) {
    if (source.lastSyncError) issues.add(`${source.name}: ${source.lastSyncError}`);
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
  for (const state of calendarStates) {
    if (activeCalendarIds.has(state.calendarId) && state.lastError) {
      issues.add(`${state.calendarId}: ${state.lastError}`);
    }
  }

  return [...issues];
}

async function loadSchedulableTasks(
  db: DB,
  userId: string,
): Promise<SchedulableTask[]> {
  const rows = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        ne(tasks.status, 'done'),
        ne(tasks.status, 'cancelled'),
      ),
    );

  return rows.map((t) => ({
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
  }));
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
 * and part; gym sessions have no task, so they are keyed by the day they
 * belong to — moving gym within a day reuses the same calendar event.
 */
function blockKey(
  block: { taskId: string | null; partIndex: number; kind: string; start: number },
  timezone: string,
): string {
  if (block.taskId) return `task:${block.taskId}:${block.partIndex}`;
  return `${block.kind}:${localDateKey(block.start, timezone)}:${block.partIndex}`;
}

function previewPlanDiff(
  existing: Array<typeof scheduledBlocks.$inferSelect>,
  result: ScheduleResult,
  timezone: string,
): Omit<
  PlanDiff,
  'applied' | 'requiresConfirmation' | 'confirmationReasons' | 'blockedByStaleData'
> {
  const diff = {
    created: 0,
    moved: 0,
    removed: 0,
    unplaced: result.unplaced.map((item) => ({
      title: item.title,
      reason: item.reason,
    })),
    warnings: [...result.warnings],
    changes: [] as string[],
  };
  const existingByKey = new Map(
    existing.map((block) => [
      blockKey(
        {
          taskId: block.taskId,
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
  const diff: PlanDiff = {
    created: 0,
    moved: 0,
    removed: 0,
    unplaced: result.unplaced.map((u) => ({ title: u.title, reason: u.reason })),
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
        { taskId: b.taskId, partIndex: b.partIndex, kind: b.kind, start: b.startAt },
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

    // Pinned blocks are re-emitted unchanged; nothing to do.
    if (prior.pinned) continue;

    const routeChanged =
      (prior.calendarId ?? calendarRouting.fallback) !== targetCalendarId;
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

function calendarForBlock(
  block: PlacedBlock,
  routing: Awaited<ReturnType<typeof getCalendarRoutingMap>>,
): string {
  if (
    block.kind === 'gym' ||
    // Buffer blocks are currently emitted only by the gym bundle; keep the
    // shower/change component on the Gym calendar even though its title does
    // not repeat the word "palestra".
    block.kind === 'buffer'
  ) {
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
