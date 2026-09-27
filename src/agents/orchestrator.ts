import { eq } from 'drizzle-orm';
import type { DB } from '../db/client';
import { taskDependencies, tasks } from '../db/schema';
import type { Env } from '../env';
import { chat } from '../integrations/llm';
import { PlannerError } from '../lib/errors';
import { localDateKey } from '../lib/time';
import { applyLearning } from '../scheduler/estimate';
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

export async function organizeOutcome(
  env: Env,
  db: DB,
  userId: string,
  rawInput: unknown,
) {
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
    contextRefs: domainContext.sourceRefs,
    allowedSources: ['d1', 'curated_profile'],
    allowedCapabilities: DOMAIN_PROFILES[domainAgent].capabilities,
    authority: 'propose',
    privacyClass: 'personal',
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
          request,
          domainContext: {
            projectFocus: domainContext.projectFocus,
            curatedProfile: domainContext.curatedProfile,
            operationalTasks: domainContext.operationalTasks,
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
  const verificationRequired = [
    ...evidencePack.gaps,
    ...parsed.data.verificationRequired,
  ];
  const trace = SpecialistTraceSchema.parse({
    request,
    agents: [
      'dani-supervisor',
      'context-perception',
      'research-knowledge',
      domainAgent,
      'outcome-evaluator',
    ],
    status: unknowns.length > 0 ? 'input_required' : 'completed',
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
    evidenceRefs: [
      ...new Set([
        ...evidencePack.claims.map((claim) => claim.evidenceRef),
        ...parsed.data.evidenceRefs,
      ]),
    ],
    verificationRequired,
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
  const input = CommitProposalInputSchema.parse(rawInput);
  validateProposalDependencies(input.proposals);
  const request = SpecialistRequestSchema.parse({
    requestId: input.sourceRequestId ?? crypto.randomUUID(),
    userGoal: input.summary ?? input.proposals.map((proposal) => proposal.title).join('; '),
    taskType: 'commit_proposal_set',
    contextRefs: [],
    allowedSources: ['approved_proposal'],
    allowedCapabilities: ['create_tasks', 'create_dependencies', 'request_replan'],
    authority: 'change_with_confirmation',
    privacyClass: 'personal',
    expectedOutputSchema: 'CommitProposalResult',
    acceptanceContract:
      'Write only the explicitly approved proposal set, then run deterministic replanning and return the resulting diff.',
  });

  const created = [];
  for (const proposal of input.proposals) {
    const learned = await applyLearning(db, userId, {
      area: proposal.area,
      energy: proposal.energy,
      title: proposal.title,
      estimatedMinutes: proposal.estimatedMinutes,
    });
    const [task] = await db
      .insert(tasks)
      .values({
        userId,
        title: proposal.title,
        notes: buildAgentNotes(input.domainAgent, proposal),
        area: proposal.area,
        energy: proposal.energy,
        priority: proposal.priority,
        estimatedMinutes: proposal.estimatedMinutes,
        plannedMinutes: learned.plannedMinutes,
        estimateSource: 'claude',
        estimateConfidence: learned.confidence,
        dueAt: proposal.dueDate ? Date.parse(`${proposal.dueDate}T18:00:00`) : null,
        flexibility: proposal.flexibility,
        dirty: true,
      })
      .returning();
    if (!task) throw new PlannerError('internal');
    created.push(task);
  }

  for (let taskIndex = 0; taskIndex < input.proposals.length; taskIndex++) {
    const proposal = input.proposals[taskIndex]!;
    for (const dependencyIndex of proposal.dependsOn) {
      await db
        .insert(taskDependencies)
        .values({
          userId,
          taskId: created[taskIndex]!.id,
          dependsOnId: created[dependencyIndex]!.id,
          lagMinutes: 0,
        })
        .onConflictDoNothing();
    }
  }

  const diff = await replan(env, db, userId, 'manual');
  await drainOutbox(env, db);
  const trace = SpecialistTraceSchema.parse({
    request,
    agents: [
      'dani-supervisor',
      input.domainAgent,
      'execution-operator',
      'reality-planner',
      'outcome-evaluator',
    ],
    status: 'completed',
  });

  return {
    supervisor: 'dani-supervisor' as const,
    executionAgent: 'execution-operator' as const,
    plannerAgent: 'reality-planner' as const,
    evaluatorAgent: 'outcome-evaluator' as const,
    domainAgent: input.domainAgent,
    committed: true,
    created: created.map((task) => ({ id: task.id, title: task.title })),
    diff,
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

function buildAgentNotes(domainAgent: string, proposal: TaskProposal): string | null {
  const parts = [`Proposto da ${domainAgent}.`];
  if (proposal.notes.trim()) parts.push(proposal.notes.trim());
  if (proposal.evidence.trim()) parts.push(`Evidenza: ${proposal.evidence.trim()}`);
  return parts.join('\n\n') || null;
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
- Non inserire orari di calendario. Non dichiarare fatti non presenti nell'outcome, nel domainContext o nell'evidencePack.
- Usa solo i claim dell'evidencePack come fatti. Mantieni distinti assumptions, unknowns ed evidenceRefs.
- Se manca una fonte necessaria, dichiarala in verificationRequired invece di colmare il vuoto.

Rispondi solo con JSON:
{"summary":"...","proposals":[{"title":"...","notes":"...","area":"general|mg|university|heemia|career|personal|health|errand","energy":"high|medium|low","priority":1,"estimatedMinutes":30,"dueDate":"YYYY-MM-DD oppure null","flexibility":"fixed|low|medium|high","dependsOn":[],"evidence":"criterio osservabile di completamento"}],"assumptions":[],"unknowns":[],"evidenceRefs":[],"verificationRequired":[]}`;
}
