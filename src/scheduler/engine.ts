import { MINUTE_MS, localWeekday, atLocalMinutes, addLocalDays } from '../lib/time';
import { buildSlots, SlotPool, ZONE_PREFERENCE } from './slots';
import { topologicalOrder, type DepMap } from './dependencies';
import type {
  PlacedBlock,
  ScheduleInput,
  ScheduleResult,
  SchedulableTask,
  UnplacedTask,
  Zone,
} from './types';

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
    buildSlots({ from: now, to: horizonEnd, timezone, settings, busy }),
  );

  const blocks: PlacedBlock[] = [...pinned];
  const breakMs = settings.breakMinutes * MINUTE_MS;

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
    alreadyScheduled: explicitGym.length,
  });
  blocks.push(...gymBlocks);

  // -------------------------------------------------------------------------
  // Tasks, in dependency order.
  // -------------------------------------------------------------------------
  const schedulable = input.tasks.filter(
    (t) => !t.pinned && t.status !== 'done' && t.status !== 'cancelled',
  );

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
    if (task.isGym) continue; // handled above

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
  return { blocks, unplaced, taskEnd, warnings };
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

// ---------------------------------------------------------------------------

function urgencyScore(
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
  settings: ScheduleInput['settings'];
  earliest: number;
  breakMs: number;
  horizonEnd: number;
}): { blocks: PlacedBlock[]; reason?: UnplacedTask['reason'] } {
  const { task, pool, settings, earliest, breakMs } = params;

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

  // Attempt 1: preferred zone only, anywhere in the horizon.
  // Attempt 2: the full fallback chain.
  for (const zones of [preferredOnly, preference]) {
    const attempt = tryPlaceParts({
      task,
      pool,
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
  zones: Zone[];
  partCount: number;
  partMs: number;
  breakMs: number;
  earliest: number;
  deadline: number | null;
  compromised: boolean;
}): PlacedBlock[] | null {
  const { task, pool, zones, partCount, partMs, breakMs } = params;

  // Probe against a scratch pool so a partial failure leaves no half-placed
  // task and no consumed slots behind.
  const scratch = new SlotPool([...pool.list()]);
  const out: PlacedBlock[] = [];
  let cursor = params.earliest;

  for (let part = 0; part < partCount; part++) {
    const found = scratch.find({
      durationMs: partMs,
      breakMs,
      notBefore: cursor,
      notAfter: params.deadline,
      zones,
    });
    if (!found) return null;

    scratch.consume(found.slot, found.start, partMs, breakMs);
    const end = found.start + partMs;

    out.push({
      taskId: task.id,
      title:
        partCount > 1 ? `${task.title} (${part + 1}/${partCount})` : task.title,
      start: found.start,
      end,
      kind: 'task',
      zone: found.slot.zone,
      partIndex: part,
      partCount,
      zoneCompromised: params.compromised,
    });

    cursor = end;
  }

  // Commit: replay the same consumption against the real pool.
  for (const block of out) {
    const slot = pool
      .list()
      .find((s) => s.start <= block.start && s.end >= block.end);
    if (slot) pool.consume(slot, block.start, block.end - block.start, breakMs);
  }

  return out;
}

/**
 * Reserves the weekly gym sessions in evening slots on the preferred weekdays,
 * falling back to any evening when a preferred day is already full.
 */
function placeGymSessions(params: {
  pool: SlotPool;
  settings: ScheduleInput['settings'];
  timezone: string;
  now: number;
  horizonEnd: number;
  breakMs: number;
  alreadyScheduled: number;
}): PlacedBlock[] {
  const { pool, settings, timezone, now, horizonEnd, breakMs } = params;
  if (settings.gymSessionsPerWeek <= 0) return [];

  const durationMs = settings.gymDurationMinutes * MINUTE_MS;
  // Stored as ISO weekdays (1 = Monday); JS getDay() uses 0 = Sunday.
  const preferred = new Set(
    settings.gymPreferredDays
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n >= 1 && n <= 7)
      .map((iso) => (iso === 7 ? 0 : iso)),
  );

  const out: PlacedBlock[] = [];
  const perWeek = new Map<number, number>();

  let day = now;
  for (let guard = 0; guard < 400 && day < horizonEnd; guard++) {
    const weekIndex = Math.floor((day - now) / (7 * DAY_MS));
    const done = perWeek.get(weekIndex) ?? 0;

    if (done < settings.gymSessionsPerWeek && preferred.has(localWeekday(day, timezone))) {
      const dayStart = atLocalMinutes(day, timezone, 0);
      const found = pool.find({
        durationMs,
        breakMs,
        notBefore: Math.max(now, dayStart),
        notAfter: dayStart + DAY_MS,
        zones: ['evening', 'afternoon'],
      });

      if (found) {
        pool.consume(found.slot, found.start, durationMs, breakMs);
        out.push({
          taskId: null,
          title: 'Palestra',
          start: found.start,
          end: found.start + durationMs,
          kind: 'gym',
          zone: found.slot.zone,
          partIndex: 0,
          partCount: 1,
          zoneCompromised: found.slot.zone !== 'evening',
        });
        perWeek.set(weekIndex, done + 1);
      }
    }

    day = addLocalDays(day, timezone, 1);
  }

  return out;
}
