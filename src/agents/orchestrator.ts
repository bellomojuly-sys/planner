import { and, asc, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client';
import { agentProposals, scheduledBlocks, taskDependencies, tasks } from '../db/schema';
import type { Env } from '../env';
import { chat } from '../integrations/llm';
import { PlannerError } from '../lib/errors';
import { addLocalDays, atLocalMinutes, localDateKey } from '../lib/time';
import { blendLearning, loadEstimateModel } from '../scheduler/estimate';
import { drainOutbox } from '../services/outbox';
import { replan } from '../services/planner';
import {
  CommitProposalInputSchema,
  OrganizeOutcomeInputSchema,
  PHASE_ONE_CONTEXT_POLICY,
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
  conversation: z.array(
    z.object({
      role: z.enum(['assistant', 'user']),
      content: z.string().min(1).max(1000),
    }),
  ).max(12).optional(),
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
    allowedSources: [...PHASE_ONE_CONTEXT_POLICY.approvedSources],
    allowedCapabilities: DOMAIN_PROFILES[domainAgent].capabilities,
    authority: 'propose',
    privacyClass: domainAgent === 'university-context' ? 'personal' : 'sensitive',
    expectedOutputSchema: 'TaskProposalSet',
    acceptanceContract:
      'Every proposal is observable, cites only allowed context, exposes unknowns, and leaves calendar placement to the Reality Planning Agent.',
  });

  const today = localDateKey(Date.now(), env.APP_TIMEZONE);
  const simpleCommitment = isSimpleCommitmentRequest(input.outcome);

  // A simple fixed commitment — the "pianifica il barbecue" dialogue — is fully
  // resolved by normalizeSimpleCommitment below, so it must not depend on the
  // model being reachable. A DeepSeek outage, an empty reply or invalid JSON
  // then falls back to the deterministic draft instead of failing the whole
  // capture with a 500. Only the richer multi-task decomposition still needs a
  // valid model response.
  let parsedJson: unknown;
  try {
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
    parsedJson = JSON.parse(content);
  } catch (err) {
    if (!simpleCommitment) {
      if (err instanceof PlannerError) throw err;
      throw new PlannerError('upstream_rejected', {
        message: `${domainAgent}: invalid json or unreachable`,
        userMessage: "L'agente non ha restituito un piano valido. Riprova.",
        retryable: true,
      });
    }
    parsedJson = undefined;
  }

  const parsed =
    parsedJson === undefined ? null : TaskProposalSetSchema.safeParse(parsedJson);
  if (parsed && !parsed.success && !simpleCommitment) {
    throw new PlannerError('upstream_rejected', {
      message: `${domainAgent}: ${parsed.error.message.slice(0, 400)}`,
      userMessage: "L'agente ha proposto attività incomplete. Riprova.",
      retryable: true,
    });
  }

  const baseProposalSet = parsed?.success
    ? parsed.data
    : fallbackSimpleCommitmentProposalSet(input.outcome);
  const proposalSet = simpleCommitment
    ? normalizeSimpleCommitment({
        proposalSet: baseProposalSet,
        outcome: input.outcome,
        conversation: input.conversation,
        timezone: env.APP_TIMEZONE,
        defaultTravelMinutes:
          domainContext.planningDefaults?.defaultTravelMinutes ?? 20,
      })
    : baseProposalSet;
  const proposals = proposalSet.proposals.slice(0, input.maxTasks);
  validateProposalDependencies(proposals);
  const assumptions = [...evidencePack.assumptions, ...proposalSet.assumptions];
  const unknowns = [...evidencePack.unknowns, ...proposalSet.unknowns];
  const { accepted: acceptedEvidenceRefs, rejected: rejectedEvidenceRefs } =
    reconcileEvidenceRefs(request.contextRefs, proposalSet.evidenceRefs);
  const evidenceRefs = [
    ...new Set([
      ...evidencePack.claims.map((claim) => claim.evidenceRef),
      ...acceptedEvidenceRefs,
    ]),
  ];
  const verificationRequired = [
    ...proposalSet.verificationRequired,
    ...rejectedEvidenceRefs.map(
      (ref) => `Riferimento non autorizzato rifiutato: ${ref}`,
    ),
  ];
  const blockingVerificationRequired =
    unknowns.length > 0 ||
    proposalSet.verificationRequired.length > 0 ||
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
    ...proposalSet,
    proposals,
    assumptions,
    unknowns,
    evidenceRefs,
    verificationRequired,
    sourceGaps: evidencePack.gaps,
    clarifyingQuestion: proposalSet.clarifyingQuestion,
    request,
    taskIds: proposals.map(() => crypto.randomUUID()),
    blockingVerificationRequired,
    conversation: input.conversation,
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
    summary: proposalSet.summary,
    proposals,
    assumptions,
    unknowns,
    evidenceRefs,
    verificationRequired,
    sourceGaps: evidencePack.gaps,
    clarifyingQuestion: proposalSet.clarifyingQuestion,
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

/**
 * Continues a capture-scoped commitment without giving the phone general read
 * access. The only accepted state is a still-pending proposal owned by the
 * same user; the previous immutable proposal is cancelled after its answer has
 * produced the next one.
 */
export async function continueCommitmentProposal(
  env: Env,
  db: DB,
  userId: string,
  rawInput: unknown,
) {
  const input = z.object({
    sourceRequestId: z.string().uuid(),
    answer: z.string().min(1).max(1000),
  }).parse(rawInput);
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
  if (stored.status !== 'pending' || stored.expiresAt <= Date.now()) {
    throw new PlannerError('conflict', {
      userMessage: 'Questa conversazione è scaduta. Premi di nuovo il tasto Azione.',
    });
  }

  const previous = StoredProposalSchema.parse(stored.payload);
  if (!previous.blockingVerificationRequired || !previous.clarifyingQuestion) {
    throw new PlannerError('conflict', {
      userMessage: 'La proposta è già pronta: confermala oppure annullala.',
    });
  }
  const priorConversation = previous.conversation ?? [];
  if (priorConversation.length > 10) {
    throw new PlannerError('conflict', {
      userMessage: 'La conversazione è troppo lunga. Ricomincia con una frase più precisa.',
    });
  }

  const domain = stored.domainAgent === 'university-context'
    ? 'university'
    : stored.domainAgent === 'work-portfolio'
      ? 'work'
      : 'personal';
  const next = await organizeOutcome(env, db, userId, {
    outcome: previous.request.userGoal,
    domain,
    conversation: [
      ...priorConversation,
      { role: 'assistant', content: previous.clarifyingQuestion },
      { role: 'user', content: input.answer },
    ],
    maxTasks: 1,
  });
  await db
    .update(agentProposals)
    .set({ status: 'cancelled' })
    .where(
      and(
        eq(agentProposals.id, stored.id),
        eq(agentProposals.userId, userId),
        eq(agentProposals.status, 'pending'),
      ),
    );
  return next;
}

export async function cancelCommitmentProposal(
  db: DB,
  userId: string,
  sourceRequestId: string,
): Promise<void> {
  const [stored] = await db
    .select({ status: agentProposals.status })
    .from(agentProposals)
    .where(
      and(
        eq(agentProposals.id, sourceRequestId),
        eq(agentProposals.userId, userId),
      ),
    )
    .limit(1);
  if (!stored) throw new PlannerError('not_found');
  if (stored.status === 'cancelled' || stored.status === 'expired') return;
  if (stored.status === 'committed') {
    throw new PlannerError('conflict', {
      userMessage: 'Questa proposta è già stata inserita nel piano.',
    });
  }
  await db
    .update(agentProposals)
    .set({ status: 'cancelled' })
    .where(
      and(
        eq(agentProposals.id, sourceRequestId),
        eq(agentProposals.userId, userId),
        eq(agentProposals.status, 'pending'),
      ),
    );
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

export function isSimpleCommitmentRequest(outcome: string): boolean {
  const excluded =
    /\b(organizza|prepara|ospit|invitati|lista della spesa|budget|host|tutti i giorni|ogni giorno|volte (?:a|alla) settimana|giorno s[iì] giorno no)\b/i.test(
      outcome,
    );
  if (excluded) return false;

  if (/\b(pianifica|programma|metti|aggiungi|segna|plan|schedule)\b/i.test(outcome)) {
    return true;
  }

  // People often enter a commitment as a compact noun phrase ("Barbecue alle
  // sei") rather than as a command. Route common calendar commitments through
  // the same confirmation dialogue so the exact time can never be reduced to
  // a due date by generic capture.
  return (
    /\b(barbecue|cena|pranzo|aperitivo|festa|compleanno|appuntamento|dentista|medico|visita|riunione|meeting|call|evento|concerto|lezione|esame)\b/i.test(
      outcome,
    ) && hasTimeHint(outcome)
  );
}

export function fallbackSimpleCommitmentProposalSet(
  outcome: string,
): z.infer<typeof TaskProposalSetSchema> {
  const title = commitmentTitle(outcome);
  return TaskProposalSetSchema.parse({
    summary: `Sto completando i dettagli necessari per pianificare ${title}.`,
    proposals: [
      {
        title,
        area: 'personal',
        energy: 'low',
        priority: 2,
        estimatedMinutes: 60,
        flexibility: 'high',
        evidence: '',
      },
    ],
  });
}

export function normalizeSimpleCommitment(params: {
  proposalSet: z.infer<typeof TaskProposalSetSchema>;
  outcome: string;
  conversation: Array<{ role: 'assistant' | 'user'; content: string }>;
  timezone: string;
  defaultTravelMinutes: number;
}): z.infer<typeof TaskProposalSetSchema> {
  const userAnswers = params.conversation
    .filter((message) => message.role === 'user')
    .map((message) => message.content);
  const declarations = [params.outcome, ...userAnswers].join(' ');
  const title = commitmentTitle(params.outcome);
  const selected =
    params.proposalSet.proposals.find((proposal) => proposal.fixedStartAt) ??
    params.proposalSet.proposals.find((proposal) =>
      proposal.title.toLocaleLowerCase('it-IT').includes(title.toLocaleLowerCase('it-IT')),
    ) ??
    params.proposalSet.proposals[0]!;

  const hasDeclaredTime = hasTimeHint(declarations);
  const fixedStartAt = hasDeclaredTime
    ? deriveFixedStart(params.outcome, userAnswers, params.timezone)
    : null;
  const explicitLocation = hasLocationHint(declarations);
  const location = explicitLocation
    ? extractLocation([...userAnswers, params.outcome].join(' '))
    : null;
  const durationConfirmed = hasDurationHint(declarations) || userAnswers.length >= 3;

  let clarifyingQuestion: string | null = null;
  let unknowns: string[] = [];
  if (!fixedStartAt) {
    clarifyingQuestion = 'A che ora devi essere lì?';
    unknowns = [`Orario di inizio di ${title}`];
  } else if (!location) {
    clarifyingQuestion = 'Dove devi andare?';
    unknowns = [`Luogo di ${title}`];
  } else if (!durationConfirmed) {
    clarifyingQuestion = 'Fino a che ora vuoi tenere libera la serata?';
    unknowns = [`Durata o orario di fine di ${title}`];
  }

  const start = fixedStartAt ? Date.parse(fixedStartAt) : null;
  const estimatedMinutes =
    start && durationConfirmed
      ? durationMinutesFromDeclarations(declarations, start, params.timezone) ??
        selected.estimatedMinutes
      : selected.estimatedMinutes;
  const ready = Boolean(fixedStartAt && location && durationConfirmed);
  const proposal: TaskProposal = {
    ...selected,
    title,
    notes: ready
      ? `Impegno personale confermato tramite conversazione con Dani.`
      : `Bozza in attesa di: ${unknowns.join(', ')}.`,
    area: 'personal',
    energy: 'low',
    estimatedMinutes,
    dueDate: start ? localDateKey(start, params.timezone) : null,
    fixedStartAt,
    location,
    travelMinutes: location ? params.defaultTravelMinutes : 0,
    preparationMinutes: ready ? 40 : 0,
    recoveryMinutes: 0,
    flexibility: fixedStartAt ? 'fixed' : 'high',
    dependsOn: [],
    evidence: ready
      ? `Presenza a ${title} all'orario e nel luogo confermati.`
      : `Confermare ${unknowns.join(', ')}.`,
  };

  return {
    summary: ready
      ? `${title} è pronto per la verifica del planner globale.`
      : `Sto completando i dettagli necessari per pianificare ${title}.`,
    proposals: [proposal],
    assumptions: [],
    unknowns,
    evidenceRefs: [],
    verificationRequired: [],
    clarifyingQuestion,
  };
}

function commitmentTitle(outcome: string): string {
  const cleaned = outcome
    .replace(/\b(oggi|domani|dopodomani)\b/gi, '')
    .replace(/\b(pianifica|programma|metti|aggiungi|segna|plan|schedule)\b/gi, '')
    .replace(
      /\b(?:circa\s+)?(?:alle(?:\s+ore)?|ore|at)\s+(?:\d{1,2}(?::\d{2})?|una|due|tre|quattro|cinque|sei|sette|otto|nove|dieci|undici|dodici)\b/gi,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'questo impegno';
  return cleaned[0]!.toUpperCase() + cleaned.slice(1);
}

const ITALIAN_HOURS: Record<string, number> = {
  una: 1,
  due: 2,
  tre: 3,
  quattro: 4,
  cinque: 5,
  sei: 6,
  sette: 7,
  otto: 8,
  nove: 9,
  dieci: 10,
  undici: 11,
  dodici: 12,
  tredici: 13,
  quattordici: 14,
  quindici: 15,
  sedici: 16,
  diciassette: 17,
  diciotto: 18,
  diciannove: 19,
  venti: 20,
  ventuno: 21,
  ventidue: 22,
  ventitré: 23,
};

function hasTimeHint(text: string): boolean {
  return parseTimeMinutes(text) !== null;
}

function parseTimeMinutes(text: string): number | null {
  const numeric = text.match(/(?:\balle?\b|\bore\b)\s*(\d{1,2})(?::(\d{2}))?/i) ??
    text.match(/\b([01]?\d|2[0-3]):(\d{2})\b/);
  if (numeric) {
    let hour = Number(numeric[1]);
    const minute = Number(numeric[2] ?? 0);
    if (hour <= 11 && !/\b(mattina|am)\b/i.test(text)) hour += 12;
    return hour * 60 + minute;
  }
  const words = Object.keys(ITALIAN_HOURS).join('|');
  const wordMatch = text.match(new RegExp(`(?:\\balle?\\b|\\bore\\b)\\s*(${words})`, 'i'));
  if (!wordMatch) return null;
  let hour = ITALIAN_HOURS[wordMatch[1]!.toLocaleLowerCase('it-IT')]!;
  if (hour <= 11 && !/\b(mattina)\b/i.test(text)) hour += 12;
  return hour * 60;
}

function deriveFixedStart(
  outcome: string,
  userAnswers: string[],
  timezone: string,
): string | null {
  const minutes = parseTimeMinutes([...userAnswers].reverse().join(' ')) ?? parseTimeMinutes(outcome);
  if (minutes === null) return null;
  const dayOffset = /\bdopodomani\b/i.test(outcome)
    ? 2
    : /\bdomani\b/i.test(outcome)
      ? 1
      : 0;
  const timestamp = atLocalMinutes(addLocalDays(Date.now(), timezone, dayOffset), timezone, minutes);
  return new Date(timestamp).toISOString();
}

function hasLocationHint(text: string): boolean {
  return /\b(downtown|casa|giardino|parco|ristorante|locale|ufficio|universit[aà]|da [A-ZÀ-ÖØ-Ý])/i.test(
    text,
  );
}

function extractLocation(text: string): string | null {
  const known = text.match(/\b(downtown|casa|giardino|parco|ristorante|locale|ufficio|universit[aà])\b/i);
  if (known) return known[1]!;
  const afterPreposition = text.match(/\b(?:al|alla|a|in|da)\s+([^,.!?]+)/i);
  return afterPreposition?.[1]?.trim() || null;
}

function hasDurationHint(text: string): boolean {
  return /\b(tutta la sera|fino (?:a|alle)|per \d+\s*(?:ore|h)|dura|finisce|termine)\b/i.test(text);
}

function durationMinutesFromDeclarations(
  text: string,
  start: number,
  timezone: string,
): number | null {
  const hours = text.match(/\bper\s+(\d+)\s*(?:ore|h)\b/i);
  if (hours) return Math.min(600, Math.max(30, Number(hours[1]) * 60));
  if (/\btutta la sera\b/i.test(text)) {
    const end = atLocalMinutes(start, timezone, 23 * 60);
    return Math.min(600, Math.max(60, Math.round((end - start) / 60_000)));
  }
  const until = text.match(/\bfino (?:a|alle)\s+(.+)$/i);
  if (until) {
    const endMinutes = parseTimeMinutes(`alle ${until[1]}`);
    if (endMinutes !== null) {
      let end = atLocalMinutes(start, timezone, endMinutes);
      if (end <= start) end = addLocalDays(end, timezone, 1);
      return Math.min(600, Math.max(30, Math.round((end - start) / 60_000)));
    }
  }
  return null;
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
