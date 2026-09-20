import type { Settings } from '../db/schema';
import type { SchedulableTask } from './types';

export interface BusyCommitment {
  start: number;
  end: number;
  title?: string;
  isShift?: boolean;
  location?: string | null;
  travelBeforeMinutes?: number;
  travelAfterMinutes?: number;
}

/**
 * Applies persisted Personal Rules only where the task has no explicit value.
 * Voice/API/Notion metadata always wins over a generic place rule.
 */
export function applyTaskPersonalRules(
  task: SchedulableTask,
  settings: Settings,
): SchedulableTask {
  const text = `${task.title} ${task.location ?? ''}`.toLowerCase();

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
    commitment.travelBeforeMinutes !== undefined ||
    commitment.travelAfterMinutes !== undefined
  ) {
    return commitment;
  }

  if (commitment.isShift) {
    return {
      ...commitment,
      travelBeforeMinutes: settings.restaurantTravelMinutes,
      travelAfterMinutes: settings.restaurantReturnMinutes,
    };
  }

  const text = `${commitment.title ?? ''} ${commitment.location ?? ''}`.toLowerCase();
  if (/universit|lezione|esame/.test(text)) {
    const preparation = settings.universityShowerDefault
      ? settings.universityShowerPreparationMinutes
      : settings.universityPreparationMinutes;
    return {
      ...commitment,
      travelBeforeMinutes: preparation + settings.universityTravelMinutes,
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
