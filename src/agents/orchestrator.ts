import { and, asc, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client';
import { agentProposals, scheduledBlocks, taskDependencies, tasks } from '../db/schema';
import type { Env } from '../env';
import { chat } from '../integrations/llm';
import { PlannerError } from '../lib/errors';
import { localDateKey } from '../lib/time';
import { blendLearning, loadEstimateModel } from '../scheduler/estimate';
import { drainOutbox } from '../services/outbox';
import { replan } from '../services/planner';
import {
  CommitProposalInputSchema,
  OrganizeOutcomeInputSchema,
  TaskProposalSetSchema,
  SpecialistRequestSchema,
  SpecialistTraceSchema,
  type TaskProposal,
} from './contracts';
import { DOMAIN_PROFILES, selectDomainAgent } from './registry';
import { buildDomainContext, DOMAIN_AGENT_INSTRUCTIONS } from './domain-context';

const PROPOSAL_TTL_MS = 30 * 60_000;

const StoredProposalSchema = TaskProposalSetSchema.extend({
  request: SpecialistRequestSchema,
  taskIds: z.array(z.string().uuid()).min(1).max(12),
  blockingVerificationRequired: z.boolean(),
  sourceGaps: z.array(z.string().max(500)).max(20),
});

export async function organizeOutcome(
  env: Env,
  db: DB,
  userId: string,
  rawInput: unknown,
) {
  const startedAt = Date.now();
  const input = OrganizeOutcomeInputSchema.parse(rawInput);
  const domainAgent = selectDomainAgent(input.outcome, input.domain);
  const profile = DOMAIN_PROFILES[domainAgent];
  const domainContext = await buildDomainContext(
    db,
    userId,
    domainAgent,
    input.outcome,
  );
  const evidencePack = domainContext.evidencePack;
  const request = SpecialistRequestSchema.parse({
    requestId: crypto.randomUUID(),
    userGoal: input.outcome,
    taskType: 'organize_outcome',
    contextRefs: [
      ...domainContext.sourceRefs,
      ...input.conversation.map((_, index) => `user:conversation:${index + 1}`),
    ],
    allowedSources: ['d1', 'curated_profile', 'settings', 'user_input'],
    allowedCapabilities: DOMAIN_PROFILES[domainAgent].capabilities,
    authority: 'propose',
    privacyClass: domainAgent === 'university-context' ? 'personal' : 'sensitive',
    expectedOutputSchema: 'TaskProposalSet',
    acceptanceContract:
      'Every proposal is observable, cites only allowed context, exposes unknowns, and leaves calendar placement to the Reality Planning Agent.',
  });

  const today = localDateKey(Date.now(), env.APP_TIMEZONE);
  const content = await chat(env, `agent.${domainAgent}.organize`, {
    max_tokens: 4096,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: buildDomainPrompt(
          domainAgent,
          DOMAIN_AGENT_INSTRUCTIONS[domainAgent],
          profile.defaultArea,
          today,
          input.maxTasks,
        ),
      },
      {
        role: 'user',
        content: JSON.stringify({
          outcome: input.outcome,
          constraints: input.constraints ?? null,
          conversation: input.conversation,
          request,
          domainContext: {
            projectFocus: domainContext.projectFocus,
            projectFocuses: domainContext.projectFocuses,
            curatedProfile: domainContext.curatedProfile,
            curatedProfiles: domainContext.curatedProfiles,
            operationalTasks: domainContext.operationalTasks,
            planningDefaults: domainContext.planningDefaults,
            retrieval: domainContext.retrieval,
          },
          evidencePack,
        }),
      },
    ],
  });

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content);
  } catch {
    throw new PlannerError('upstream_rejected', {
      message: `${domainAgent}: invalid json`,
      userMessage: "L'agente non ha restituito un piano valido. Riprova.",
      retryable: true,
    });
  }

  const parsed = TaskProposalSetSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new PlannerError('upstream_rejected', {
      message: `${domainAgent}: ${parsed.error.message.slice(0, 400)}`,
      userMessage: "L'agente ha proposto attività incomplete. Riprova.",
      retryable: true,
    });
  }

  const proposals = parsed.data.proposals.slice(0, input.maxTasks);
  validateProposalDependencies(proposals);
  const assumptions = [...evidencePack.assumptions, ...parsed.data.assumptions];
  const unknowns = [...evidencePack.unknowns, ...parsed.data.unknowns];
  const { accepted: acceptedEvidenceRefs, rejected: rejectedEvidenceRefs } =
    reconcileEvidenceRefs(request.contextRefs, parsed.data.evidenceRefs);
  const evidenceRefs = [
    ...new Set([
      ...evidencePack.claims.map((claim) => claim.evidenceRef),
      ...acceptedEvidenceRefs,
    ]),
  ];
  const verificationRequired = [
    ...parsed.data.verificationRequired,
    ...rejectedEvidenceRefs.map(
      (ref) => `Riferimento non autorizzato rifiutato: ${ref}`,
    ),
  ];
  const blockingVerificationRequired =
    unknowns.length > 0 ||
    parsed.data.verificationRequired.length > 0 ||
    rejectedEvidenceRefs.length > 0;
  const trace = SpecialistTraceSchema.parse({
    request,
    agents: [
      'dani-supervisor',
      'context-perception',
      'research-knowledge',
      domainAgent,
      'outcome-evaluator',
    ],
    status: blockingVerificationRequired ? 'input_required' : 'completed',
    steps: [
      {
        agentId: 'context-perception',
        operation: 'retrieve_domain_context',
        status: 'completed',
        detail: `${domainContext.retrieval.retained} task contestuali su ${domainContext.retrieval.queried} letti`,
        evidenceRefs: domainContext.sourceRefs,
      },
      {
        agentId: 'research-knowledge',
        operation: 'build_evidence_pack',
        status: 'completed',
        detail: `${evidencePack.claims.length} claim autorizzati; ${evidencePack.gaps.length} limiti dichiarati`,
        evidenceRefs,
      },
      {
        agentId: domainAgent,
        operation: 'decompose_outcome',
        status: blockingVerificationRequired ? 'input_required' : 'completed',
        detail: `${proposals.length} attività proposte`,
        evidenceRefs,
      },
      {
        agentId: 'outcome-evaluator',
        operation: 'validate_contract_and_dependencies',
        status: blockingVerificationRequired ? 'input_required' : 'completed',
        detail: rejectedEvidenceRefs.length > 0
          ? `${rejectedEvidenceRefs.length} riferimenti non autorizzati rifiutati`
          : 'Schema, dipendenze e riferimenti validati',
        evidenceRefs,
      },
      {
        agentId: 'dani-supervisor',
        operation: 'synthesise_proposal',
        status: blockingVerificationRequired ? 'input_required' : 'completed',
        detail: blockingVerificationRequired
          ? 'Proposta salvata ma non approvabile finché mancano chiarimenti'
          : 'Proposta salvata e pronta per approvazione',
        evidenceRefs,
      },
    ],
  });
  const storedProposal = StoredProposalSchema.parse({
    ...parsed.data,
    proposals,
    assumptions,
    unknowns,
    evidenceRefs,
    verificationRequired,
    sourceGaps: evidencePack.gaps,
    clarifyingQuestion: parsed.data.clarifyingQuestion,
    request,
    taskIds: proposals.map(() => crypto.randomUUID()),
    blockingVerificationRequired,
  });
  const expiresAt = Date.now() + PROPOSAL_TTL_MS;
  await db.insert(agentProposals).values({
    id: request.requestId,
    userId,
    domainAgent,
    payload: storedProposal,
    proposalHash: await proposalHash(storedProposal),
    expiresAt,
  });

  return {
    supervisor: 'dani-supervisor' as const,
    contextAgent: 'context-perception' as const,
    domainAgent,
    plannerAgent: 'reality-planner' as const,
    evaluatorAgent: 'outcome-evaluator' as const,
    researchAgent: 'research-knowledge' as const,
    summary: parsed.data.summary,
    proposals,
    assumptions,
    unknowns,
    evidenceRefs,
    verificationRequired,
    sourceGaps: evidencePack.gaps,
    clarifyingQuestion: parsed.data.clarifyingQuestion,
    blockingVerificationRequired,
    expiresAt,
    actionsProposed: proposals.map((proposal) => proposal.title),
    costAndLatency: {
      durationMs: Date.now() - startedAt,
      tokenUsage: null,
      costUsd: null,
    },
    trace,
    committed: false,
  };
}

export async function commitProposalSet(
  env: Env,
  db: DB,
  userId: string,
  rawInput: unknown,
) {
  const startedAt = Date.now();
  const input = CommitProposalInputSchema.parse(rawInput);
  const [stored] = await db
    .select()
    .from(agentProposals)
    .where(
      and(
        eq(agentProposals.id, input.sourceRequestId),
        eq(agentProposals.userId, userId),
      ),
    )
    .limit(1);
  if (!stored) throw new PlannerError('not_found');

  if (stored.status === 'expired' || stored.status === 'cancelled') {
    throw new PlannerError('conflict', {
      userMessage: 'Questa proposta non è più approvabile. Generane una nuova.',
    });
  }
  if (stored.status === 'pending' && stored.expiresAt <= Date.now()) {
    await db
      .update(agentProposals)
      .set({ status: 'expired' })
      .where(and(eq(agentProposals.id, stored.id), eq(agentProposals.status, 'pending')));
    throw new PlannerError('conflict', {
      userMessage: 'La proposta è scaduta. Generane una nuova con il contesto aggiornato.',
    });
  }

  const approved = StoredProposalSchema.parse(stored.payload);
  if ((await proposalHash(approved)) !== stored.proposalHash) {
    throw new PlannerError('conflict', {
      message: `Agent proposal ${stored.id} failed its integrity check`,
      userMessage: 'La proposta approvata non supera il controllo di integrità.',
    });
  }
  if (approved.blockingVerificationRequired) {
    throw new PlannerError('conflict', {
      userMessage: 'Prima di inserire le attività devi risolvere i chiarimenti o le verifiche bloccanti.',
    });
  }
  validateProposalDependencies(approved.proposals);

  const idempotentReplay = stored.status === 'committed';
  if (!idempotentReplay) {
    const estimateRows = await loadEstimateModel(db, userId);
    const taskValues = approved.proposals.map((proposal, index) => {
      const learned = proposal.fixedStartAt
        ? {
            plannedMinutes: proposal.estimatedMinutes,
            factor: 1,
            confidence: 1,
            basis: [],
          }
        : blendLearning(estimateRows, {
            area: proposal.area,
            energy: proposal.energy,
            title: proposal.title,
            estimatedMinutes: proposal.estimatedMinutes,
          });
      return {
        id: approved.taskIds[index]!,
        userId,
        title: proposal.title,
        notes: buildAgentNotes(stored.domainAgent, proposal, approved),
        area: proposal.area,
        energy: proposal.energy,
        priority: proposal.priority,
        estimatedMinutes: proposal.estimatedMinutes,
        plannedMinutes: learned.plannedMinutes,
        estimateSource: 'claude' as const,
        estimateConfidence: learned.confidence,
        dueAt: proposal.dueDate ? Date.parse(`${proposal.dueDate}T18:00:00`) : null,
        fixedStartAt: proposal.fixedStartAt ? Date.parse(proposal.fixedStartAt) : null,
        location: proposal.location,
        travelMinutes: proposal.travelMinutes,
        preparationMinutes: proposal.preparationMinutes,
        recoveryMinutes: proposal.recoveryMinutes,
        flexibility: proposal.flexibility,
        dirty: true,
      };
    });
    const dependencyValues = approved.proposals.flatMap((proposal, taskIndex) =>
      proposal.dependsOn.map((dependencyIndex) => ({
          id: crypto.randomUUID(),
          userId,
          taskId: approved.taskIds[taskIndex]!,
          dependsOnId: approved.taskIds[dependencyIndex]!,
          lagMinutes: 0,
          createdBy: 'claude' as const,
      })),
    );
    const statements = [
      ...taskValues.map((value) => db.insert(tasks).values(value)),
      ...dependencyValues.map((value) => db.insert(taskDependencies).values(value)),
      db
        .update(agentProposals)
        .set({
          status: 'committed' as const,
          committedAt: Date.now(),
          createdTaskIds: approved.taskIds,
        })
        .where(
          and(
            eq(agentProposals.id, stored.id),
            eq(agentProposals.status, 'pending'),
          ),
        ),
    ];
    await db.batch(statements as [any, ...any[]]);
  }

  const diff = await replan(env, db, userId, 'manual');
  const outbox = await drainOutbox(env, db);
  const requiresInput = commitRequiresInput(diff, outbox);
  const confirmation = await buildCommitConfirmation(
    db,
    userId,
    env.APP_TIMEZONE,
    approved.proposals,
    requiresInput,
  );
  const request = SpecialistRequestSchema.parse({
    ...approved.request,
    taskType: 'commit_proposal_set',
    allowedSources: ['approved_proposal'],
    allowedCapabilities: ['create_tasks', 'create_dependencies', 'request_replan'],
    authority: 'change_with_confirmation',
    expectedOutputSchema: 'CommitProposalResult',
    acceptanceContract:
      'Write only the immutable approved proposal set, then run deterministic replanning and report its real result.',
  });
  const trace = SpecialistTraceSchema.parse({
    request,
    agents: [
      'dani-supervisor',
      stored.domainAgent,
      'execution-operator',
      'reality-planner',
      'outcome-evaluator',
    ],
    status: requiresInput ? 'input_required' : 'completed',
    steps: [
      {
        agentId: 'dani-supervisor',
        operation: 'verify_approved_snapshot',
        status: 'completed',
        detail: 'Hash, scadenza, proprietario e stato della proposta verificati',
        evidenceRefs: approved.evidenceRefs,
      },
      {
        agentId: stored.domainAgent,
        operation: 'load_approved_proposal',
        status: 'completed',
        detail: 'Caricata la proposta immutabile generata dall’agente di dominio',
        evidenceRefs: approved.evidenceRefs,
      },
      {
        agentId: 'execution-operator',
        operation: 'commit_tasks_and_dependencies',
        status: 'completed',
        detail: idempotentReplay
          ? 'Retry riconosciuto: nessuna attività duplicata'
          : `${approved.proposals.length} attività inserite in un batch atomico`,
        evidenceRefs: approved.evidenceRefs,
      },
      {
        agentId: 'reality-planner',
        operation: 'replan',
        status: requiresInput ? 'input_required' : 'completed',
        detail: diff.blockedByStaleData
          ? 'Piano bloccato da dati non aggiornati'
          : diff.requiresConfirmation
            ? 'Il piano richiede conferma'
            : diff.unplaced.length > 0
              ? `${diff.unplaced.length} attività non collocate`
              : 'Piano globale applicato',
        evidenceRefs: [],
      },
      {
        agentId: 'outcome-evaluator',
        operation: 'evaluate_commit_result',
        status: requiresInput ? 'input_required' : 'completed',
        detail: outbox.dead > 0
          ? `${outbox.dead} operazioni esterne non recuperabili`
          : `${outbox.processed} operazioni esterne completate; ${outbox.failed} in retry`,
        evidenceRefs: [],
      },
    ],
  });

  return {
    supervisor: 'dani-supervisor' as const,
    executionAgent: 'execution-operator' as const,
    plannerAgent: 'reality-planner' as const,
    evaluatorAgent: 'outcome-evaluator' as const,
    domainAgent: stored.domainAgent,
    committed: true,
    idempotentReplay,
    created: approved.taskIds.map((id, index) => ({
      id,
      title: approved.proposals[index]!.title,
    })),
    diff,
    outbox,
    confirmation,
    actionsProposed: approved.proposals.map((proposal) => proposal.title),
    costAndLatency: {
      durationMs: Date.now() - startedAt,
      tokenUsage: null,
      costUsd: null,
    },
    trace,
  };
}

function validateProposalDependencies(proposals: TaskProposal[]) {
  for (let index = 0; index < proposals.length; index++) {
    for (const dependency of proposals[index]!.dependsOn) {
      if (dependency >= proposals.length || dependency === index) {
        throw new PlannerError('bad_request', {
          userMessage: 'Una dipendenza proposta non è valida.',
        });
      }
    }
  }
}

function buildAgentNotes(
  domainAgent: string,
  proposal: TaskProposal,
  approved: z.infer<typeof StoredProposalSchema>,
): string | null {
  const parts = [`Proposto da ${domainAgent}.`];
  if (proposal.notes.trim()) parts.push(proposal.notes.trim());
  if (proposal.evidence.trim()) parts.push(`Evidenza: ${proposal.evidence.trim()}`);
  if (approved.evidenceRefs.length > 0) {
    parts.push(`Riferimenti: ${approved.evidenceRefs.join(', ')}`);
  }
  if (approved.assumptions.length > 0) {
    parts.push(`Assunzioni dichiarate: ${approved.assumptions.join(' | ')}`);
  }
  return parts.join('\n\n') || null;
}

async function proposalHash(value: z.infer<typeof StoredProposalSchema>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function reconcileEvidenceRefs(contextRefs: string[], proposedRefs: string[]) {
  const allowed = new Set(contextRefs);
  return {
    accepted: [...new Set(proposedRefs.filter((ref) => allowed.has(ref)))],
    rejected: [...new Set(proposedRefs.filter((ref) => !allowed.has(ref)))],
  };
}

export function commitRequiresInput(
  diff: {
    requiresConfirmation: boolean;
    blockedByStaleData: boolean;
    unplaced: unknown[];
  },
  outbox: { dead: number; failed: number },
) {
  return (
    diff.requiresConfirmation ||
    diff.blockedByStaleData ||
    diff.unplaced.length > 0 ||
    outbox.dead > 0 ||
    outbox.failed > 0
  );
}

async function buildCommitConfirmation(
  db: DB,
  userId: string,
  timezone: string,
  proposals: TaskProposal[],
  requiresInput: boolean,
): Promise<string> {
  const fixed = proposals.find((proposal) => proposal.fixedStartAt);
  if (!fixed?.fixedStartAt) {
    return requiresInput
      ? `${proposals.length} attività inserite. Il planner richiede ancora una decisione.`
      : `${proposals.length} attività inserite e pianificate.`;
  }

  const start = Date.parse(fixed.fixedStartAt);
  const preparationStart =
    start - (fixed.preparationMinutes + fixed.travelMinutes) * 60_000;
  const eventEnd = start + fixed.estimatedMinutes * 60_000;
  const [nextGym] = await db
    .select({ title: scheduledBlocks.title, startAt: scheduledBlocks.startAt })
    .from(scheduledBlocks)
    .where(
      and(
        eq(scheduledBlocks.userId, userId),
        eq(scheduledBlocks.kind, 'gym'),
        gt(scheduledBlocks.startAt, eventEnd),
      ),
    )
    .orderBy(asc(scheduledBlocks.startAt))
    .limit(1);

  const parts = [
    `Ho pianificato ${fixed.title} dalle ${formatClock(start, timezone)}.`,
  ];
  if (fixed.preparationMinutes > 0 || fixed.travelMinutes > 0) {
    parts.push(`Inizi a prepararti alle ${formatClock(preparationStart, timezone)}.`);
  }
  if (nextGym) {
    parts.push(
      `Cerca di non fare troppo tardi: ${nextGym.title} ti aspetta ${formatDateTime(nextGym.startAt, timezone)}.`,
    );
  }
  if (requiresInput) {
    parts.push('Il planner ha rilevato un punto che richiede ancora la tua conferma.');
  }
  return parts.join(' ');
}

function formatClock(timestamp: number, timezone: string): string {
  return new Intl.DateTimeFormat('it-IT', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

function formatDateTime(timestamp: number, timezone: string): string {
  return new Intl.DateTimeFormat('it-IT', {
    timeZone: timezone,
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

export function buildDomainPrompt(
  domainAgent: string,
  instructions: string,
  defaultArea: string,
  today: string,
  maxTasks: number,
) {
  return `Sei ${domainAgent}, un agente di contesto interno a Dani. Non assegni orari: proponi attività strutturate al Reality Planning Agent globale.

ISTRUZIONI SPECIFICHE DEL RUOLO
${instructions}

REGOLE
- Oggi è ${today}.
- Trasforma l'outcome in massimo ${maxTasks} attività concrete, ordinate e verificabili.
- Non duplicare attività già aperte: se una proposta coincide, omettila.
- Ogni attività deve avere un risultato osservabile, non formule vaghe come “lavorare su”.
- Usa area ${defaultArea} salvo che Heemia richieda heemia o MG/DMG richieda mg.
- Le priorità vanno da 1 urgente a 4 differibile. Non rendere tutto urgente.
- La durata è lavoro effettivo in minuti; viaggio e preparazione non vanno nascosti nella stima.
- dependsOn contiene gli indici zero-based delle proposte precedenti da completare prima.
- L'outcome e la conversazione sono dichiarazioni dell'utente. Per gli altri fatti di contesto usa soltanto i claim dell'evidencePack.
- Se si tratta di un impegno a un orario preciso, compila fixedStartAt con data, ora e offset Europe/Rome; il planner resta responsabile di verificare conflitti e collocazione.
- Se mancano orario, luogo, durata, viaggio o preparazione necessari per pianificare correttamente, aggiungi l'elemento a unknowns e formula una sola domanda diretta in clarifyingQuestion. Non fare più domande insieme.
- Quando la conversazione contiene la risposta, aggiorna la proposta e chiedi soltanto il prossimo dato ancora indispensabile. Se non manca nulla, clarifyingQuestion deve essere null.
- Mantieni distinti assumptions, unknowns ed evidenceRefs e cita soltanto gli evidenceRef presenti nella richiesta.
- Se manca una fonte necessaria, dichiarala in verificationRequired invece di colmare il vuoto.

Rispondi solo con JSON:
{"summary":"...","proposals":[{"title":"...","notes":"...","area":"general|mg|university|heemia|career|personal|health|errand","energy":"high|medium|low","priority":1,"estimatedMinutes":30,"dueDate":"YYYY-MM-DD oppure null","fixedStartAt":"ISO 8601 con offset oppure null","location":"luogo oppure null","travelMinutes":0,"preparationMinutes":0,"recoveryMinutes":0,"flexibility":"fixed|low|medium|high","dependsOn":[],"evidence":"criterio osservabile di completamento"}],"assumptions":[],"unknowns":[],"evidenceRefs":[],"verificationRequired":[],"clarifyingQuestion":"una domanda oppure null"}`;
}
