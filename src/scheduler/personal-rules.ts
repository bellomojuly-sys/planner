import type { Settings } from '../db/schema';
import type { Area } from '../db/schema';
import type { SchedulableTask } from './types';

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
}

const ADULT_LIFE_RE =
  /\bduo\b|assicurazione sanitaria|health insurance|cercare casa|ricerca casa|housing/i;

/** Personal place knowledge confirmed for a real one-off event. */
const DEN_BOSCH_RE = /den\s*bosch|denbosch/i;

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

  if (task.area === 'university' || /universit|lezione|esame/.test(text)) {
    return {
      ...task,
      travelMinutes:
        task.travelMinutes && task.travelMinutes > 0
          ? task.travelMinutes
          : settings.universityTravelMinutes,
      preparationMinutes:
        task.preparationMinutes && task.preparationMinutes > 0
          ? task.preparationMinutes
          : settings.universityShowerDefault
            ? settings.universityShowerPreparationMinutes
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
    };
  }

  if (/universit|lezione|esame/.test(text)) {
    const preparation = settings.universityShowerDefault
      ? settings.universityShowerPreparationMinutes
      : settings.universityPreparationMinutes;
    return {
      ...commitment,
      area: 'university',
      preparationBeforeMinutes: preparation,
      travelBeforeMinutes: settings.universityTravelMinutes,
      travelAfterMinutes: settings.universityTravelMinutes,
    };
  }

  return commitment;
}

export function reservationExplanation(task: SchedulableTask): string {
  const activity = task.plannedMinutes;
  const travel = task.travelMinutes ?? 0;
  const preparation = task.preparationMinutes ?? 0;
  const recovery = task.recoveryMinutes ?? 0;
  const total = activity + travel + preparation + recovery;
  return `${total} min riservati: ${activity} attività + ${travel} viaggio + ${preparation} preparazione + ${recovery} rientro/recupero.`;
}
