import type {
  DecisionOutcome,
  ExecutionClass,
  PlanDecision,
  PlacedBlock,
  PlanningClass,
  SchedulableTask,
  UnplacedTask,
} from './types';
import { reservationExplanation } from './personal-rules';

const DAY_MS = 86_400_000;

export function planningClassFor(
  task: SchedulableTask,
  now: number,
): PlanningClass {
  if (task.pinned || task.flexibility === 'fixed' || task.isGym) return 'constraint';
  if (
    task.priority <= 2 ||
    task.horizon === 0 ||
    (task.dueAt !== null && task.dueAt <= now + 7 * DAY_MS)
  ) {
    return 'objective';
  }
  return 'preference';
}

/**
 * Conservative recommendation only. V0.1 never executes the work: an
 * allowlist identifies preparation that AI can plausibly perform, and every
 * external/physical action remains YOU_DO.
 */
export function executionClassFor(task: SchedulableTask): ExecutionClass {
  const text = `${task.title} ${task.location ?? ''}`.toLowerCase();
  if (
    /accompagn|andare|palestra|allenamento|lavatrice|comprare|ritirare|consegnare|chiamare|telefonare|appuntament|aeroporto|ristorante/.test(
      text,
    )
  ) {
    return 'you_do';
  }
  if (/riassum|trascriv|formatt|organizz(?:a|are) (?:le )?note|raccogliere fonti/.test(text)) {
    return 'jarvis_does';
  }
  if (/analisi|analizzare|ricerca|report|bozza|documentazione|presentazione|strategia|piano|email/.test(text)) {
    return 'hybrid';
  }
  return 'you_do';
}

export function buildPlanDecisions(params: {
  tasks: SchedulableTask[];
  blocks: PlacedBlock[];
  unplaced: UnplacedTask[];
  now: number;
}): PlanDecision[] {
  const placedIds = new Set(
    params.blocks.map((block) => block.taskId).filter((id): id is string => Boolean(id)),
  );
  const unplacedById = new Map(params.unplaced.map((item) => [item.taskId, item]));

  return params.tasks.map((task) => {
    const planningClass = planningClassFor(task, params.now);
    const executionClass = executionClassFor(task);
    const unplaced = unplacedById.get(task.id);
    let outcome: DecisionOutcome = placedIds.has(task.id) ? 'keep' : 'postpone';
    let reason = reservationExplanation(task);

    if (unplaced) {
      outcome = outcomeForUnplaced(unplaced, planningClass, executionClass);
      reason = reasonForUnplaced(unplaced, outcome);
    }

    return {
      taskId: task.id,
      title: task.title,
      planningClass,
      executionClass,
      outcome,
      reason,
      reservedMinutes:
        task.plannedMinutes +
        (task.travelMinutes ?? 0) +
        (task.preparationMinutes ?? 0) +
        (task.recoveryMinutes ?? 0),
    };
  });
}

function outcomeForUnplaced(
  item: UnplacedTask,
  planningClass: PlanningClass,
  executionClass: ExecutionClass,
): DecisionOutcome {
  if (
    item.reason === 'pinned_conflict' ||
    item.reason === 'cycle' ||
    item.reason === 'duplicate' ||
    planningClass === 'constraint'
  ) {
    return 'needs_decision';
  }
  if (item.reason === 'no_free_time' && executionClass !== 'you_do') {
    return 'delegation_candidate';
  }
  return 'postpone';
}

function reasonForUnplaced(
  item: UnplacedTask,
  outcome: DecisionOutcome,
): string {
  if (outcome === 'needs_decision') {
    return item.detail ?? 'Un conflitto o un’ambiguità richiede una scelta di Giulia.';
  }
  if (outcome === 'delegation_candidate') {
    return 'Non entra nella capacità disponibile e può essere preparata da Jarvis, previa revisione.';
  }
  if (item.reason === 'blocked_by_dependency') {
    return 'Rinviata: prima deve terminare un prerequisito.';
  }
  if (item.reason === 'past_due_window') {
    return 'Rinviata: la finestra utile è già trascorsa.';
  }
  return 'Rinviata: non entra nella capacità dell’orizzonte corrente.';
}

export function markMoved(
  decisions: PlanDecision[],
  movedTaskIds: Set<string>,
): PlanDecision[] {
  return decisions.map((decision) =>
    decision.outcome === 'keep' && movedTaskIds.has(decision.taskId)
      ? {
          ...decision,
          outcome: 'move' as const,
          reason: `Spostata in un nuovo intervallo fattibile. ${decision.reason}`,
        }
      : decision,
  );
}

export function buildDecisionBriefing(params: {
  decisions: PlanDecision[];
  fixedCommitments: number;
}): string[] {
  const count = (outcome: DecisionOutcome) =>
    params.decisions.filter((decision) => decision.outcome === outcome).length;
  const requested = params.decisions.reduce(
    (sum, decision) => sum + decision.reservedMinutes,
    0,
  );
  const planned = params.decisions
    .filter((decision) => decision.outcome === 'keep' || decision.outcome === 'move')
    .reduce((sum, decision) => sum + decision.reservedMinutes, 0);
  const constraints = params.decisions.filter(
    (decision) => decision.planningClass === 'constraint',
  ).length;
  const delegated = params.decisions.filter(
    (decision) => decision.outcome === 'delegation_candidate',
  );
  const unresolved = params.decisions.filter(
    (decision) => decision.outcome === 'needs_decision',
  );

  return [
    `Capacità: ${requested} min richiesti, ${planned} min protetti nel piano.`,
    `Vincoli: ${params.fixedCommitments} impegni fissi e ${constraints} attività vincolanti.`,
    `Piano: ${count('keep')} mantenute, ${count('move')} spostate, ${count('postpone')} rinviate.`,
    delegated.length > 0
      ? `Delega AI: ${delegated.length} candidate — ${titles(delegated)}.`
      : 'Delega AI: nessuna candidata in questo piano.',
    unresolved.length > 0
      ? `Decisioni per Giulia: ${unresolved.length} — ${titles(unresolved)}.`
      : 'Decisioni per Giulia: nessun conflitto irrisolto.',
  ];
}

function titles(decisions: PlanDecision[]): string {
  const shown = decisions.slice(0, 3).map((decision) => decision.title);
  return `${shown.join(', ')}${decisions.length > shown.length ? ` +${decisions.length - shown.length}` : ''}`;
}
