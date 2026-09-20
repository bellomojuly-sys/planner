import type { Settings } from '../db/schema';
import type { Area } from '../db/schema';
import type { SchedulableTask } from './types';
import { localDateKey } from '../lib/time';

export interface BusyCommitment {
  start: number;
  end: number;
  title?: string;
  isShift?: boolean;
  location?: string | null;
  area?: Area;
  preparationBeforeMinutes?: number;
  travelBeforeMinutes?: number;
  travelAfterMinutes?: number;
  preparationLabel?: string;
  travelBeforeLabel?: string;
  travelAfterLabel?: string;
}

export interface PlanningContext extends BusyCommitment {
  allowedAreas: Area[];
}

const ADULT_LIFE_RE =
  /\bduo\b|assicurazione sanitaria|health insurance|cercare casa|ricerca casa|housing/i;

/** Personal place knowledge confirmed for a real one-off event. */
const DEN_BOSCH_RE = /den\s*bosch|denbosch/i;
const UNIVERSITY_PLACE_RE =
  /universit|lezione|esame|fontys|zelf\s*work|self\s*work|applied\s*genai|campus|scuola/i;

/**
 * Applies persisted Personal Rules only where the task has no explicit value.
 * Voice/API/Notion metadata always wins over a generic place rule.
 */
export function applyTaskPersonalRules(
  task: SchedulableTask,
  settings: Settings,
): SchedulableTask {
  const text = `${task.title} ${task.location ?? ''}`.toLowerCase();

  // Adult-life administration consists of independent atomic tasks. Without
  // a deadline it belongs on Sunday; a real due date may still force a safer
  // fallback before the consequence occurs.
  if (ADULT_LIFE_RE.test(text)) {
    return {
      ...task,
      preferredWeekdays: [0],
      strictPreferredWeekdays: task.dueAt === null,
    };
  }

  const physicalUniversityTask =
    UNIVERSITY_PLACE_RE.test(task.location ?? '') ||
    /lezione|esame\s+in\s+presenza/.test(text);
  if (physicalUniversityTask) {
    return {
      ...task,
      travelMinutes:
        task.travelMinutes && task.travelMinutes > 0
          ? task.travelMinutes
          : Math.max(20, settings.universityTravelMinutes),
      preparationMinutes:
        task.preparationMinutes && task.preparationMinutes > 0
          ? task.preparationMinutes
          : settings.universityPreparationMinutes,
    };
  }

  if (task.isGym || /palestra|gym|allenamento/.test(text)) {
    return {
      ...task,
      travelMinutes:
        task.travelMinutes && task.travelMinutes > 0
          ? task.travelMinutes
          : settings.gymTravelMinutes,
      preparationMinutes:
        task.preparationMinutes && task.preparationMinutes > 0
          ? task.preparationMinutes
          : settings.gymPreparationMinutes,
      recoveryMinutes:
        task.recoveryMinutes && task.recoveryMinutes > 0
          ? task.recoveryMinutes
          : settings.gymReturnMinutes,
    };
  }

  if (/ristorante|restaurant/.test(text)) {
    return {
      ...task,
      travelMinutes:
        task.travelMinutes && task.travelMinutes > 0
          ? task.travelMinutes
          : settings.restaurantTravelMinutes,
      recoveryMinutes:
        task.recoveryMinutes && task.recoveryMinutes > 0
          ? task.recoveryMinutes
          : settings.restaurantReturnMinutes,
    };
  }

  return task;
}

/** Adds asymmetric travel/preparation around fixed commitments. */
export function applyBusyPersonalRules(
  commitment: BusyCommitment,
  settings: Settings,
): BusyCommitment {
  if (
    commitment.preparationBeforeMinutes !== undefined ||
    commitment.travelBeforeMinutes !== undefined ||
    commitment.travelAfterMinutes !== undefined
  ) {
    return commitment;
  }

  if (commitment.isShift) {
    return {
      ...commitment,
      area: 'general',
      travelBeforeMinutes: settings.restaurantTravelMinutes,
      travelAfterMinutes: settings.restaurantReturnMinutes,
    };
  }

  const text = `${commitment.title ?? ''} ${commitment.location ?? ''}`.toLowerCase();

  // First confirmed visit: leave home, 40 minutes body-shower/preparation,
  // 90 minutes each way. This is kept as place knowledge, not a fake generic
  // university commute and not a recurring habit inferred from one visit.
  if (DEN_BOSCH_RE.test(text)) {
    return {
      ...commitment,
      area: 'university',
      preparationBeforeMinutes: 40,
      travelBeforeMinutes: 90,
      travelAfterMinutes: 90,
      preparationLabel: `Preparazione — ${commitment.title ?? 'Den Bosch'}`,
      travelBeforeLabel: 'Viaggio casa → Den Bosch',
      travelAfterLabel: 'Viaggio Den Bosch → casa',
    };
  }

  if (UNIVERSITY_PLACE_RE.test(text)) {
    const travel = Math.max(20, settings.universityTravelMinutes);
    return {
      ...commitment,
      area: 'university',
      preparationBeforeMinutes: settings.universityPreparationMinutes,
      travelBeforeMinutes: travel,
      travelAfterMinutes: travel,
      preparationLabel: 'Preparazione università',
      travelBeforeLabel: 'Viaggio casa → università',
      travelAfterLabel: 'Viaggio università → casa',
    };
  }

  return commitment;
}

/**
 * Resolves journeys that depend on the next real destination. A university
 * context remains usable for project work, but its boundary buffers still
 * represent getting ready and physically travelling there and back.
 */
export function applyCalendarPersonalRules(
  commitments: BusyCommitment[],
  contexts: PlanningContext[],
  settings: Settings,
  timezone: string,
): { busy: BusyCommitment[]; contexts: PlanningContext[] } {
  const busy = commitments.map((item) => applyBusyPersonalRules(item, settings));
  const normalizedContexts = contexts.map((context) => ({
    ...context,
    ...applyBusyPersonalRules(context, settings),
  }));

  const universityWindows: BusyCommitment[] = [
    ...busy.filter((item) => item.area === 'university'),
    ...normalizedContexts.filter((item) => item.area === 'university'),
  ];

  for (const university of universityWindows) {
    const nextShift = busy
      .filter(
        (item) =>
          item.isShift &&
          item.start >= university.end &&
          item.start - university.end <= 2 * 60 * 60_000 &&
          localDateKey(item.start, timezone) ===
            localDateKey(university.end, timezone),
      )
      .sort((a, b) => a.start - b.start)[0];

    if (!nextShift) continue;
    university.travelAfterMinutes = settings.universityToWorkTravelMinutes;
    university.travelAfterLabel = 'Viaggio università → lavoro';
    nextShift.travelBeforeMinutes = 0;
    nextShift.travelBeforeLabel = undefined;
  }

  return { busy, contexts: normalizedContexts };
}

export function reservationExplanation(task: SchedulableTask): string {
  const activity = task.plannedMinutes;
  const travel = task.travelMinutes ?? 0;
  const preparation = task.preparationMinutes ?? 0;
  const recovery = task.recoveryMinutes ?? 0;
  const total = activity + travel + preparation + recovery;
  return `${total} min riservati: ${activity} attività + ${travel} viaggio + ${preparation} preparazione + ${recovery} rientro/recupero.`;
}
