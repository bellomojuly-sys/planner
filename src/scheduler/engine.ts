import {
  MINUTE_MS,
  localWeekday,
  atLocalMinutes,
  addLocalDays,
  localDateKey,
  localMinutes,
} from '../lib/time';
import { buildSlots, SlotPool, ZONE_PREFERENCE } from './slots';
import { topologicalOrder, type DepMap } from './dependencies';
import {
  DEFAULT_LOAD,
  type DailyLoad,
  type PlacedBlock,
  type ScheduleInput,
  type ScheduleResult,
  type SchedulableTask,
  type Slot,
  type UnplacedTask,
  type Zone,
} from './types';
import { buildDecisionBriefing, buildPlanDecisions } from './decisions';
import { commitmentBufferLabels } from './personal-rules';

const DAY_MS = 86_400_000;

/**
 * The planner's core. Given the fixed commitments, the open tasks and their
 * dependencies, it produces a concrete set of time blocks.
 *
 * The approach is a greedy pass over a topological ordering, with two
 * refinements that matter in practice:
 *
 *  1. Two-attempt zone matching. A task first competes only for slots in its
 *     preferred energy zone across the whole horizon. Only if that fails does
 *     it fall back to a less suitable zone. Doing it in this order stops an
 *     early low-effort task from squatting in Tuesday morning and pushing
 *     demanding work into the evening.
 *
 *  2. Dependency anchoring through `taskEnd`. A dependent is never considered
 *     before its predecessor's placed end, so moving Fase 15 pushes 16, 17 and
 *     18 without any cascade-specific code path.
 *
 * Greedy is deliberate over an optimal solver: it is predictable, it runs in
 * milliseconds inside a Worker, and a plan Giulia can anticipate is worth more
 * than one that is five minutes tighter.
 */
export function schedule(input: ScheduleInput): ScheduleResult {
  const { now, horizonEnd, timezone, settings } = input;
  const warnings: string[] = [];
  const unplaced: UnplacedTask[] = [];

  const taskEnd = new Map<string, number>(input.knownTaskEnds ?? []);

  // A permanent task may become impossible when a fixed commitment moves on
  // top of it. The commitment is a fact about unavailable time, while the pin
  // forbids us from choosing a replacement time. Keep the pin on the task but
  // do not publish an overlap: the whole task becomes an actionable conflict.
  const futurePinned = input.pinnedBlocks.filter((b) => b.end > now);
  const conflictTaskIds = new Set(
    futurePinned
      .filter(
        (block) =>
          block.taskId &&
          input.busy.some((busy) => overlaps(block.start, block.end, busy.start, busy.end)),
      )
      .map((block) => block.taskId!),
  );

  for (const taskId of conflictTaskIds) {
    const block = futurePinned.find((candidate) => candidate.taskId === taskId)!;
    unplaced.push({
      taskId,
      title: block.title,
      reason: 'pinned_conflict',
      detail: 'Un impegno fisso occupa l’orario di un’attività permanente.',
    });
    warnings.push(
      `“${block.title}” è permanente ma ora si sovrappone a un impegno fisso. Scegli come ricollocarla.`,
    );
  }

  // After Giulia accepts the conflict outcome, the overlapping calendar block
  // is removed but the task deliberately remains permanent. Keep surfacing it
  // until she explicitly moves or releases it.
  const pinnedTaskIdsWithBlocks = new Set(
    futurePinned.map((block) => block.taskId).filter((id): id is string => Boolean(id)),
  );
  for (const task of input.tasks) {
    if (
      task.pinned &&
      !pinnedTaskIdsWithBlocks.has(task.id) &&
      !conflictTaskIds.has(task.id)
    ) {
      conflictTaskIds.add(task.id);
      unplaced.push({
        taskId: task.id,
        title: task.title,
        reason: 'pinned_conflict',
        detail: 'L’attività è permanente ma non ha più un orario valido.',
      });
      warnings.push(
        `“${task.title}” è permanente ma non ha un orario valido. Scegli come ricollocarla.`,
      );
    }
  }

  const pinned = futurePinned.filter(
    (block) => !block.taskId || !conflictTaskIds.has(block.taskId),
  );
  const busy = [
    ...input.busy,
    ...pinned.map((b) => ({ start: b.start, end: b.end })),
  ];

  for (const block of pinned) {
    if (!block.taskId) continue;
    taskEnd.set(block.taskId, Math.max(taskEnd.get(block.taskId) ?? 0, block.end));
  }

  const pool = new SlotPool(
    buildSlots({
      from: now,
      to: horizonEnd,
      timezone,
      settings,
      busy,
      contexts: input.contexts,
    }),
  );

  const commitmentBuffers = buildCommitmentBuffers(input.busy, timezone);
  const contextBuffers = buildCommitmentBuffers(input.contexts ?? [], timezone);
  const blocks: PlacedBlock[] = [
    ...pinned,
    ...commitmentBuffers,
    ...contextBuffers,
  ];
  const breakMs = settings.breakMinutes * MINUTE_MS;

  // A day with a shift has less room for anything else, whatever its free
  // slots say: the shift already took the energy.
  const shiftDays = new Set(
    input.busy
      .filter((b) => b.isShift)
      .map((b) => localDateKey(b.start, timezone)),
  );
  const budget = new DayBudget(input.load ?? DEFAULT_LOAD, shiftDays);
  const areaOf = new Map(input.tasks.map((t) => [t.id, t.area]));
  for (const block of pinned) {
    if (block.kind !== 'task' || !block.taskId) continue;
    budget.add(
      localDateKey(block.start, timezone),
      areaOf.get(block.taskId) ?? 'general',
      block.taskId,
      block.end - block.start,
    );
  }

  // -------------------------------------------------------------------------
  // Gym first. Evenings are plentiful, and reserving the health commitment
  // before discretionary work is the whole point of having it in settings.
  // -------------------------------------------------------------------------
  const explicitGym = input.tasks.filter((t) => t.isGym);
  const gymBlocks = placeGymSessions({
    pool,
    settings,
    timezone,
    now,
    horizonEnd,
    breakMs,
    busy: input.busy,
    alreadyScheduled: explicitGym.length,
    completedGymAt: input.completedGymAt ?? [],
    suppressedKeys: input.suppressedKeys ?? new Set(),
    // A gym session edited by hand is pinned: it already fills its week slot.
    pinnedGymAt: pinned.filter((b) => b.kind === 'gym').map((b) => b.start),
  });
  blocks.push(
    ...gymBlocks.filter(
      (block) =>
        block.kind === 'gym' ||
        !input.suppressedKeys?.has(
          `buffer:${localDateKey(block.start, timezone)}:${normalizeTitle(block.title)}`,
        ),
    ),
  );

  // -------------------------------------------------------------------------
  // Tasks, in dependency order.
  // -------------------------------------------------------------------------
  const open = input.tasks.filter(
    (t) => !t.pinned && t.status !== 'done' && t.status !== 'cancelled',
  );

  // The same title twice in the same area is almost always a copy — a Notion
  // import run twice, a task duplicated by hand. Planning both books the work
  // twice. The most urgent copy is planned; the others are reported so the
  // duplicate can be removed at the source. Nothing is deleted here.
  const { kept: schedulable, duplicates } = dedupeTasks(open, (t) =>
    urgencyScore(t, now, 0),
  );
  for (const dup of duplicates) {
    unplaced.push({
      taskId: dup.id,
      title: dup.title,
      reason: 'duplicate',
      detail: 'Stesso titolo di un’altra attività della stessa area.',
    });
  }
  if (duplicates.length > 0) {
    const titles = [...new Set(duplicates.map((d) => `“${d.title}”`))];
    warnings.push(
      `Attività duplicate pianificate una volta sola: ${titles.join(', ')}. Elimina le copie in Notion.`,
    );
  }

  const blockingCount = countBlocked(schedulable, input.dependencies);
  const scoreOf = (t: SchedulableTask) =>
    urgencyScore(t, now, blockingCount.get(t.id) ?? 0);

  const { order, cycles } = topologicalOrder(
    schedulable,
    input.dependencies,
    scoreOf,
  );

  for (const cycle of cycles) {
    warnings.push(
      `Dipendenze circolari rilevate fra ${cycle.length} attività: non sono state pianificate.`,
    );
    for (const id of cycle) {
      const t = schedulable.find((x) => x.id === id);
      unplaced.push({
        taskId: id,
        title: t?.title ?? id,
        reason: 'cycle',
        detail: 'Ciclo di dipendenze',
      });
    }
  }

  for (const task of order) {
    // Explicit gym tasks are still scheduled: they count toward the weekly
    // target above, while preserving a user-supplied duration/deadline.

    const earliest = earliestStartFor(task, input.dependencies, taskEnd, now);
    if (earliest === null) {
      unplaced.push({
        taskId: task.id,
        title: task.title,
        reason: 'blocked_by_dependency',
        detail: 'Un prerequisito non è ancora pianificato.',
      });
      continue;
    }

    const placed = placeTask({
      task,
      pool,
      budget,
      settings,
      earliest,
      breakMs,
      horizonEnd,
    });

    if (placed.blocks.length === 0) {
      unplaced.push({
        taskId: task.id,
        title: task.title,
        reason: placed.reason ?? 'no_free_time',
      });
      continue;
    }

    blocks.push(...placed.blocks);
    taskEnd.set(task.id, placed.blocks[placed.blocks.length - 1]!.end);

    if (task.dueAt && placed.blocks[placed.blocks.length - 1]!.end > task.dueAt) {
      warnings.push(`"${task.title}" finisce dopo la scadenza.`);
    }
  }

  if (unplaced.some((u) => u.reason === 'no_free_time')) {
    warnings.push(
      `Non c'è spazio per ${unplaced.filter((u) => u.reason === 'no_free_time').length} attività entro l'orizzonte di pianificazione.`,
    );
  }

  blocks.sort((a, b) => a.start - b.start);
  const decisions = buildPlanDecisions({
    tasks: input.tasks,
    blocks,
    unplaced,
    now,
  });
  const briefing = buildDecisionBriefing({
    decisions,
    fixedCommitments: input.busy.length,
  });
  return {
    blocks,
    unplaced,
    decisions,
    briefing,
    fixedCommitments: input.busy.length,
    taskEnd,
    warnings,
  };
}

function buildCommitmentBuffers(
  commitments: NonNullable<ScheduleInput['contexts']> | ScheduleInput['busy'],
  timezone: string,
): PlacedBlock[] {
  const blocks: PlacedBlock[] = [];
  for (const commitment of commitments) {
    const labels = commitmentBufferLabels(commitment);
    const preparationMs = (commitment.preparationBeforeMinutes ?? 0) * MINUTE_MS;
    const outwardMs = (commitment.travelBeforeMinutes ?? 0) * MINUTE_MS;
    const returnMs = (commitment.travelAfterMinutes ?? 0) * MINUTE_MS;
    const area = commitment.area;
    const zone = zoneForInstant(commitment.start, timezone);
    const components: Array<{
      title: string;
      start: number;
      end: number;
      zone: Zone;
    }> = [];

    if (preparationMs > 0) {
      const start = commitment.start - outwardMs - preparationMs;
      components.push({
        title: labels.preparation,
        start,
        end: start + preparationMs,
        zone: zoneForInstant(start, timezone),
      });
    }
    if (outwardMs > 0) {
      const start = commitment.start - outwardMs;
      components.push({
        title: labels.travelBefore,
        start,
        end: commitment.start,
        zone: zoneForInstant(start, timezone),
      });
    }
    if (returnMs > 0) {
      components.push({
        title: labels.travelAfter,
        start: commitment.end,
        end: commitment.end + returnMs,
        zone: zoneForInstant(commitment.end, timezone),
      });
    }

    components.forEach((component, partIndex) => {
      blocks.push({
        taskId: null,
        ...component,
        kind: 'buffer',
        partIndex,
        partCount: components.length,
        zoneCompromised: component.zone !== zone,
        area,
      });
    });
  }
  return blocks;
}

function normalizeTitle(title: string): string {
  return title.trim().toLocaleLowerCase('it-IT').replace(/\s+/g, ' ');
}

function zoneForInstant(ts: number, timezone: string): Zone {
  const minutes = localMinutes(ts, timezone);
  if (minutes < 13 * 60) return 'morning';
  if (minutes < 18 * 60) return 'afternoon';
  return 'evening';
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

// ---------------------------------------------------------------------------

export function urgencyScore(
  task: SchedulableTask,
  now: number,
  blocking: number,
): number {
  // priority 1 (drop everything) → 40, priority 4 (whenever) → 10.
  let score = (5 - Math.min(4, Math.max(1, task.priority))) * 10;

  if (task.dueAt) {
    const daysLeft = (task.dueAt - now) / DAY_MS;
    // Steep near the deadline, flat far from it; overdue work outranks all.
    score += daysLeft < 0 ? 100 : Math.max(0, 60 - daysLeft * 8);
  }

  // A task that unblocks four others is worth starting before one that
  // unblocks none, even at equal priority — this is the critical path.
  score += Math.min(30, blocking * 6);

  // Horizon is Giulia's own answer to "when does this belong". NOW outranks a
  // priority step; LATER yields its place to anything current. A task with no
  // horizon (its source has none) is neither pushed nor held back.
  if (task.horizon === 0) score += 25;
  else if (task.horizon === 2) score -= 25;

  const text = `${task.title} ${task.projectKey ?? ''}`.toLowerCase();
  // Confirmed default ordering for flexible work. Concrete deadlines still
  // dominate these modest project-level nudges.
  if (task.area === 'heemia' || /\bheemia\b/.test(text)) score += 20;
  if (/linkedin|opportunit[aà] di lavoro|ricerca lavoro/.test(text)) score -= 40;

  return score;
}

function countBlocked(
  tasks: SchedulableTask[],
  deps: DepMap,
): Map<string, number> {
  const direct = new Map<string, number>();
  const ids = new Set(tasks.map((t) => t.id));

  for (const t of tasks) {
    for (const edge of deps.get(t.id) ?? []) {
      if (!ids.has(edge.dependsOnId)) continue;
      direct.set(edge.dependsOnId, (direct.get(edge.dependsOnId) ?? 0) + 1);
    }
  }
  return direct;
}

/**
 * Returns the instant a task may first begin, or null when a prerequisite has
 * no known end (itself unplaced).
 */
function earliestStartFor(
  task: SchedulableTask,
  deps: DepMap,
  taskEnd: Map<string, number>,
  now: number,
): number | null {
  let earliest = Math.max(now, task.earliestStartAt ?? 0);

  for (const edge of deps.get(task.id) ?? []) {
    const end = taskEnd.get(edge.dependsOnId);
    // Unknown prerequisite means "not in this scheduling set" — either done
    // long ago (recorded in knownTaskEnds) or genuinely unplaced.
    if (end === undefined) {
      if (!taskEnd.has(edge.dependsOnId)) return null;
      continue;
    }
    earliest = Math.max(earliest, end + edge.lagMinutes * MINUTE_MS);
  }

  return earliest;
}

function placeTask(params: {
  task: SchedulableTask;
  pool: SlotPool;
  budget: DayBudget;
  settings: ScheduleInput['settings'];
  earliest: number;
  breakMs: number;
  horizonEnd: number;
}): { blocks: PlacedBlock[]; reason?: UnplacedTask['reason'] } {
  const { task, pool, budget, settings, earliest, breakMs } = params;

  const totalMs = Math.max(
    settings.minBlockMinutes,
    task.plannedMinutes,
  ) * MINUTE_MS;
  const maxMs = settings.maxBlockMinutes * MINUTE_MS;

  const partCount =
    task.splittable && totalMs > maxMs ? Math.ceil(totalMs / maxMs) : 1;
  const partMs = Math.ceil(totalMs / partCount);

  const preference = ZONE_PREFERENCE[task.energy] ?? ZONE_PREFERENCE.medium!;
  const preferredOnly: Zone[] = [preference[0]!];

  /**
   * A deadline only constrains placement if it is still reachable. An overdue
   * task has a due date in the past, and treating that as a hard upper bound
   * would make it permanently unschedulable — exactly the task that most needs
   * a slot. Drop the constraint instead and let the caller warn about the
   * overrun.
   */
  const deadline = task.dueAt !== null && task.dueAt > earliest ? task.dueAt : null;

  if (task.preferredWeekdays?.length) {
    for (const zones of [preferredOnly, preference]) {
      const preferredAttempt = tryPlaceParts({
        task,
        pool,
        budget,
        zones,
        partCount,
        partMs,
        breakMs,
        earliest,
        deadline,
        compromised: zones !== preferredOnly,
        weekdays: task.preferredWeekdays,
      });
      if (preferredAttempt) return { blocks: preferredAttempt };
    }
    if (task.strictPreferredWeekdays) {
      return { blocks: [], reason: 'no_free_time' };
    }
  }

  // Attempt 1: preferred zone only, anywhere in the horizon.
  // Attempt 2: the full fallback chain.
  for (const zones of [preferredOnly, preference]) {
    const attempt = tryPlaceParts({
      task,
      pool,
      budget,
      zones,
      partCount,
      partMs,
      breakMs,
      earliest,
      deadline,
      compromised: zones !== preferredOnly,
    });
    if (attempt) return { blocks: attempt };
  }

  return { blocks: [], reason: 'no_free_time' };
}

function tryPlaceParts(params: {
  task: SchedulableTask;
  pool: SlotPool;
  budget: DayBudget;
  zones: Zone[];
  partCount: number;
  partMs: number;
  breakMs: number;
  earliest: number;
  deadline: number | null;
  compromised: boolean;
  weekdays?: number[];
}): PlacedBlock[] | null {
  const { task, pool, zones, partCount, partMs, breakMs } = params;

  // Probe against a scratch pool so a partial failure leaves no half-placed
  // task and no consumed slots behind.
  const scratch = new SlotPool([...pool.list()]);
  const scratchBudget = params.budget.clone();
  const taskBlocks: PlacedBlock[] = [];
  let cursor = params.earliest;

  for (let part = 0; part < partCount; part++) {
    const beforeMs =
      part === 0
        ? ((task.travelMinutes ?? 0) + (task.preparationMinutes ?? 0)) * MINUTE_MS
        : 0;
    const afterMs =
      part === partCount - 1 ? (task.recoveryMinutes ?? 0) * MINUTE_MS : 0;
    const reservedMs = beforeMs + partMs + afterMs;
    const found = scratch.find({
      durationMs: reservedMs,
      breakMs,
      notBefore: cursor,
      notAfter: params.deadline,
      zones,
      accept: (slot: Slot) =>
        (!slot.allowedAreas || slot.allowedAreas.includes(task.area)) &&
        (!params.weekdays || params.weekdays.includes(weekdayOfDayKey(slot.dayKey))) &&
        scratchBudget.fits(slot.dayKey, task.area, task.id, partMs),
    });
    if (!found) return null;

    scratch.consume(found.slot, found.start, reservedMs, breakMs);
    scratchBudget.add(found.slot.dayKey, task.area, task.id, partMs);
    const taskStart = found.start + beforeMs;
    const end = taskStart + partMs;

    taskBlocks.push({
      taskId: task.id,
      title:
        partCount > 1 ? `${task.title} (${part + 1}/${partCount})` : task.title,
      start: taskStart,
      end,
      kind: 'task',
      zone: found.slot.zone,
      partIndex: part,
      partCount,
      zoneCompromised: params.compromised,
      area: task.area,
    });

    cursor = end;
  }

  // Commit: replay the same consumption against the real pool and budget.
  for (const block of taskBlocks) {
    const beforeMs =
      block.partIndex === 0
        ? ((task.travelMinutes ?? 0) + (task.preparationMinutes ?? 0)) * MINUTE_MS
        : 0;
    const afterMs =
      block.partIndex === block.partCount - 1
        ? (task.recoveryMinutes ?? 0) * MINUTE_MS
        : 0;
    const reservationStart = block.start - beforeMs;
    const reservationDuration = beforeMs + (block.end - block.start) + afterMs;
    const slot = pool
      .list()
      .find(
        (s) =>
          s.start <= reservationStart &&
          s.end >= reservationStart + reservationDuration,
      );
    if (slot) {
      pool.consume(slot, reservationStart, reservationDuration, breakMs);
      params.budget.add(slot.dayKey, task.area, task.id, block.end - block.start);
    }
  }

  const out: PlacedBlock[] = [];
  const beforeMinutes =
    (task.travelMinutes ?? 0) + (task.preparationMinutes ?? 0);
  const first = taskBlocks[0];
  if (first && beforeMinutes > 0) {
    out.push({
      taskId: task.id,
      title: `Preparazione e viaggio — ${task.title}`,
      start: first.start - beforeMinutes * MINUTE_MS,
      end: first.start,
      kind: 'buffer',
      zone: first.zone,
      partIndex: -1,
      partCount,
      zoneCompromised: first.zoneCompromised,
      area: task.area,
    });
  }

  out.push(...taskBlocks);

  const recoveryMinutes = task.recoveryMinutes ?? 0;
  const last = taskBlocks[taskBlocks.length - 1];
  if (last && recoveryMinutes > 0) {
    out.push({
      taskId: task.id,
      title: `Rientro e recupero — ${task.title}`,
      start: last.end,
      end: last.end + recoveryMinutes * MINUTE_MS,
      kind: 'buffer',
      zone: last.zone,
      partIndex: partCount,
      partCount,
      zoneCompromised: last.zoneCompromised,
      area: task.area,
    });
  }

  return out;
}

function weekdayOfDayKey(dayKey: string): number {
  // Noon UTC avoids a timezone boundary while preserving the calendar date.
  return new Date(`${dayKey}T12:00:00Z`).getUTCDay();
}

/**
 * Reserves complete door-to-door gym sessions: outward travel, workout,
 * shower/change and return. Preferred days win, avoided days are excluded,
 * and a configurable recovery interval separates sessions.
 */
function placeGymSessions(params: {
  pool: SlotPool;
  settings: ScheduleInput['settings'];
  timezone: string;
  now: number;
  horizonEnd: number;
  breakMs: number;
  busy: ScheduleInput['busy'];
  alreadyScheduled: number;
  completedGymAt: number[];
  suppressedKeys: Set<string>;
  pinnedGymAt: number[];
}): PlacedBlock[] {
  const {
    pool,
    settings,
    timezone,
    now,
    horizonEnd,
    breakMs,
    busy,
    alreadyScheduled,
    completedGymAt,
    suppressedKeys,
    pinnedGymAt,
  } = params;
  if (settings.gymSessionsPerWeek <= 0) return [];

  const workoutMs = settings.gymDurationMinutes * MINUTE_MS;
  const outwardMs = settings.gymTravelMinutes * MINUTE_MS;
  const preparationMs = settings.gymPreparationMinutes * MINUTE_MS;
  const returnMs = settings.gymReturnMinutes * MINUTE_MS;
  const durationMs = outwardMs + workoutMs + preparationMs + returnMs;
  // Stored as ISO weekdays (1 = Monday); JS getDay() uses 0 = Sunday.
  const preferred = new Set(
    settings.gymPreferredDays
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n >= 1 && n <= 7)
      .map((iso) => (iso === 7 ? 0 : iso)),
  );
  const avoided = new Set(
    settings.gymAvoidDays
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n >= 1 && n <= 7)
      .map((iso) => (iso === 7 ? 0 : iso)),
  );

  const out: PlacedBlock[] = [];
  const perWeek = new Map<number, number>();

  const days: number[] = [];
  for (let day = now, guard = 0; guard < 400 && day < horizonEnd; guard++) {
    days.push(day);
    day = addLocalDays(day, timezone, 1);
  }

  const weekCount = Math.ceil(days.length / 7);
  let lastWorkoutEnd = Math.max(
    Number.NEGATIVE_INFINITY,
    ...completedGymAt,
    ...pinnedGymAt.filter((start) => start <= now),
  );
  // Days that already hold their session (pinned) or were skipped on purpose.
  const settledDays = new Set([
    ...pinnedGymAt.map((start) => localDateKey(start, timezone)),
    ...[...suppressedKeys]
      .filter((key) => key.startsWith('gym:'))
      .map((key) => key.slice(4)),
  ]);
  for (let weekIndex = 0; weekIndex < weekCount; weekIndex++) {
    const target = Math.min(
      settings.gymSessionsPerWeek,
      settings.gymMaxSessionsPerWeek,
    );
    const recentlyCompleted =
      weekIndex === 0
        ? completedGymAt.filter(
            (completedAt) => completedAt <= now && completedAt > now - 7 * DAY_MS,
          ).length
        : 0;
    perWeek.set(
      weekIndex,
      weekIndex === 0
        ? Math.min(alreadyScheduled + recentlyCompleted, target)
        : 0,
    );
    const weekDays = days.slice(weekIndex * 7, weekIndex * 7 + 7);
    const settledThisWeek = weekDays.filter((day) =>
      settledDays.has(localDateKey(day, timezone)),
    ).length;
    if (settledThisWeek > 0) {
      perWeek.set(weekIndex, Math.min(target, (perWeek.get(weekIndex) ?? 0) + settledThisWeek));
    }

    // Monday Zumba is part of the real workout sequence, not a reason to drop
    // the preferred Monday gym. Fit travel + gym before it, then return home
    // and shower after it. The calendar event itself remains the source of
    // truth for Zumba and is therefore not duplicated as a Planner block.
    const weekKeys = new Set(weekDays.map((day) => localDateKey(day, timezone)));
    const zumba = busy.find(
      (event) =>
        /zumba/i.test(event.title ?? '') &&
        weekKeys.has(localDateKey(event.start, timezone)),
    );
    if (
      (perWeek.get(weekIndex) ?? 0) < target &&
      zumba &&
      !settledDays.has(localDateKey(zumba.start, timezone))
    ) {
      const bufferMs = settings.bufferAroundEventsMinutes * MINUTE_MS;
      const preEnd = zumba.start - bufferMs;
      const preStart = preEnd - outwardMs - workoutMs;
      const postStart = zumba.end + bufferMs;
      const postEnd = postStart + returnMs + preparationMs;
      const preSlot = pool
        .list()
        .find(
          (slot) =>
            !slot.allowedAreas && slot.start <= preStart && slot.end >= preEnd,
        );
      const postSlot = pool
        .list()
        .find(
          (slot) =>
            !slot.allowedAreas && slot.start <= postStart && slot.end >= postEnd,
        );
      const workoutStart = preStart + outwardMs;
      if (
        preSlot &&
        postSlot &&
        workoutStart >= now &&
        workoutStart >= lastWorkoutEnd + settings.gymMinRecoveryHours * 60 * MINUTE_MS
      ) {
        pool.consume(preSlot, preStart, preEnd - preStart, 0);
        pool.consume(postSlot, postStart, postEnd - postStart, breakMs);
        const sequence = [
          {
            title: 'Viaggio verso palestra',
            start: preStart,
            end: preStart + outwardMs,
            kind: 'buffer' as const,
            zone: preSlot.zone,
          },
          {
            title: 'Palestra',
            start: preStart + outwardMs,
            end: preEnd,
            kind: 'gym' as const,
            zone: preSlot.zone,
          },
          {
            title: 'Ritorno dalla palestra',
            start: postStart,
            end: postStart + returnMs,
            kind: 'buffer' as const,
            zone: postSlot.zone,
          },
          {
            title: 'Doccia / cambio',
            start: postStart + returnMs,
            end: postEnd,
            kind: 'buffer' as const,
            zone: postSlot.zone,
          },
        ];
        sequence.forEach((component, partIndex) => {
          out.push({
            taskId: null,
            ...component,
            partIndex,
            partCount: sequence.length,
            zoneCompromised: component.zone !== 'evening',
          });
        });
        lastWorkoutEnd = preEnd;
        perWeek.set(weekIndex, (perWeek.get(weekIndex) ?? 0) + 1);
      }
    }

    const candidates = [
      ...weekDays.filter((day) => preferred.has(localWeekday(day, timezone))),
      ...weekDays.filter((day) => !preferred.has(localWeekday(day, timezone))),
    ].filter(
      (day) =>
        !avoided.has(localWeekday(day, timezone)) &&
        !settledDays.has(localDateKey(day, timezone)),
    );

    for (const day of candidates) {
      const done = perWeek.get(weekIndex) ?? 0;
      if (done >= target) break;

      const dayStart = atLocalMinutes(day, timezone, 0);
      const found = pool.find({
        durationMs,
        breakMs,
        notBefore: Math.max(
          now,
          dayStart,
          lastWorkoutEnd + settings.gymMinRecoveryHours * 60 * MINUTE_MS,
        ),
        notAfter: dayStart + DAY_MS,
        zones: ['evening', 'afternoon'],
        accept: (slot) => !slot.allowedAreas,
      });
      if (!found) continue;

      pool.consume(found.slot, found.start, durationMs, breakMs);
      const components: Array<{
        title: string;
        ms: number;
        kind: PlacedBlock['kind'];
      }> = [
        { title: 'Viaggio verso palestra', ms: outwardMs, kind: 'buffer' },
        { title: 'Palestra', ms: workoutMs, kind: 'gym' },
        { title: 'Ritorno dalla palestra', ms: returnMs, kind: 'buffer' },
        { title: 'Doccia / cambio', ms: preparationMs, kind: 'buffer' },
      ];
      let cursor = found.start;
      components.forEach((component, partIndex) => {
        if (component.ms <= 0) return;
        out.push({
          taskId: null,
          title: component.title,
          start: cursor,
          end: cursor + component.ms,
          kind: component.kind,
          zone: found.slot.zone,
          partIndex,
          partCount: components.filter((item) => item.ms > 0).length,
          zoneCompromised: found.slot.zone !== 'evening',
        });
        cursor += component.ms;
      });
      lastWorkoutEnd = found.start + outwardMs + workoutMs;
      perWeek.set(weekIndex, done + 1);
    }
  }

  return out;
}

/**
 * Minutes of task work already booked per day, per area and per task.
 *
 * Three rules, from `dl-how-planner-spreads-the-week`: a day holds at most its
 * ceiling (less on shift days); one area takes at most a share of it, so MG
 * cannot swallow every day; and a task gets at most one part per day, so a
 * fifteen-hour project is spread over the weeks instead of stacked in one.
 *
 * A single part larger than a ceiling may still take a day that is otherwise
 * empty for that rule — otherwise a long unsplittable task could never be
 * placed at all.
 */
export class DayBudget {
  private total = new Map<string, number>();
  private byArea = new Map<string, number>();
  private taskDays = new Set<string>();

  constructor(
    private readonly load: DailyLoad,
    private readonly shiftDays: Set<string>,
  ) {}

  private cap(day: string): number {
    return (
      (this.shiftDays.has(day) ? this.load.shiftDayMinutes : this.load.freeDayMinutes) *
      MINUTE_MS
    );
  }

  fits(day: string, area: string, taskId: string, ms: number): boolean {
    if (this.taskDays.has(`${taskId}|${day}`)) return false;

    const cap = this.cap(day);
    const used = this.total.get(day) ?? 0;
    if (used > 0 && used + ms > cap) return false;

    const areaCap = cap * this.load.areaShare;
    const areaUsed = this.byArea.get(`${day}|${area}`) ?? 0;
    if (areaUsed > 0 && areaUsed + ms > areaCap) return false;

    return true;
  }

  add(day: string, area: string, taskId: string, ms: number): void {
    this.total.set(day, (this.total.get(day) ?? 0) + ms);
    this.byArea.set(`${day}|${area}`, (this.byArea.get(`${day}|${area}`) ?? 0) + ms);
    this.taskDays.add(`${taskId}|${day}`);
  }

  clone(): DayBudget {
    const copy = new DayBudget(this.load, this.shiftDays);
    copy.total = new Map(this.total);
    copy.byArea = new Map(this.byArea);
    copy.taskDays = new Set(this.taskDays);
    return copy;
  }
}

/** Same normalised title in the same area: keep the most urgent copy. */
export function dedupeTasks<T extends { id: string; title: string; area: string }>(
  tasks: T[],
  score: (t: T) => number,
): { kept: T[]; duplicates: T[] } {
  const groups = new Map<string, T[]>();
  for (const task of tasks) {
    const key = `${task.area}|${task.title.toLowerCase().replace(/\s+/g, ' ').trim()}`;
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }

  const kept: T[] = [];
  const duplicates: T[] = [];
  for (const group of groups.values()) {
    const [best, ...rest] = [...group].sort((a, b) => score(b) - score(a));
    kept.push(best!);
    duplicates.push(...rest);
  }
  // Preserve the caller's order for everything that stays.
  const keptIds = new Set(kept.map((t) => t.id));
  return { kept: tasks.filter((t) => keptIds.has(t.id)), duplicates };
}
