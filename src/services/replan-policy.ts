import type { ScheduleResult } from '../scheduler/types';
import { localDateKey } from '../lib/time';

export const CONFIRMATION_WINDOW_MS = 60 * 60_000;

export type ConfirmationReason = 'permanent_task_conflict' | 'near_term_change';

interface ExistingBlock {
  taskId: string | null;
  partIndex: number;
  kind: string;
  startAt: number;
  endAt: number;
}

function keyOf(
  block: { taskId: string | null; partIndex: number; kind: string; start: number },
  timezone: string,
): string {
  if (block.taskId) return `task:${block.taskId}:${block.partIndex}`;
  return `${block.kind}:${localDateKey(block.start, timezone)}`;
}

/**
 * Confirmation is about proposed disruption, not the total size of a plan.
 * A permanent task only counts when it conflicts, and a near-term block only
 * counts when this replan would create, move or remove it.
 */
export function confirmationReasons(
  existing: ExistingBlock[],
  result: ScheduleResult,
  now: number,
  timezone: string,
): ConfirmationReason[] {
  const reasons = new Set<ConfirmationReason>();

  if (result.unplaced.some((item) => item.reason === 'pinned_conflict')) {
    reasons.add('permanent_task_conflict');
  }

  const cutoff = now + CONFIRMATION_WINDOW_MS;
  const existingByKey = new Map(
    existing.map((block) => [
      keyOf(
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
  const proposedByKey = new Map(
    result.blocks.map((block) => [
      keyOf(block, timezone),
      block,
    ]),
  );

  for (const [key, block] of existingByKey) {
    if (block.endAt <= now || block.startAt > cutoff) continue;
    const proposed = proposedByKey.get(key);
    if (!proposed || proposed.start !== block.startAt || proposed.end !== block.endAt) {
      reasons.add('near_term_change');
    }
  }

  for (const [key, block] of proposedByKey) {
    if (block.end <= now || block.start > cutoff) continue;
    if (!existingByKey.has(key)) reasons.add('near_term_change');
  }

  return [...reasons];
}

export function confirmationReasonMessage(reason: ConfirmationReason): string {
  return reason === 'permanent_task_conflict'
    ? 'Un task permanente è in conflitto con un impegno fisso.'
    : 'Il replan modifica un blocco che inizia entro 60 minuti.';
}
