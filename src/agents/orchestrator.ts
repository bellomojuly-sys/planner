import { and, desc, eq, ne } from 'drizzle-orm';
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
  type TaskProposal,
} from './contracts';
import {
  DOMAIN_PROFILES,
  selectDomainAgent,
} from './registry';

export async function organizeOutcome(
  env: Env,
  db: DB,
  userId: string,
  rawInput: unknown,
) {
  const input = OrganizeOutcomeInputSchema.parse(rawInput);
  const domainAgent = selectDomainAgent(input.outcome, input.domain);
  const profile = DOMAIN_PROFILES[domainAgent];
  const openTasks = await db
    .select({ title: tasks.title, area: tasks.area, dueAt: tasks.dueAt })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), ne(tasks.status, 'done')))
    .orderBy(desc(tasks.updatedAt))
    .limit(40);

  const today = localDateKey(Date.now(), env.APP_TIMEZONE);
  const content = await chat(env, `agent.${domainAgent}.organize`, {
    max_tokens: 4096,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: buildDomainPrompt(profile.context, profile.defaultArea, today, input.maxTasks),
      },
      {
        role: 'user',
        content: JSON.stringify({
          outcome: input.outcome,
          constraints: input.constraints ?? null,
          existingOpenTasks: openTasks,
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
  return {
    supervisor: 'dani-supervisor' as const,
    contextAgent: 'context-perception' as const,
    domainAgent,
    plannerAgent: 'reality-planner' as const,
    evaluatorAgent: 'outcome-evaluator' as const,
    summary: parsed.data.summary,
    proposals,
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

  return {
    supervisor: 'dani-supervisor' as const,
    executionAgent: 'execution-operator' as const,
    plannerAgent: 'reality-planner' as const,
    evaluatorAgent: 'outcome-evaluator' as const,
    domainAgent: input.domainAgent,
    committed: true,
    created: created.map((task) => ({ id: task.id, title: task.title })),
    diff,
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
  context: string,
  defaultArea: string,
  today: string,
  maxTasks: number,
) {
  return `Sei un agente di contesto interno a Dani. Non assegni orari: proponi attività strutturate al Reality Planning Agent globale.

CONTESTO AUTORIZZATO
${context}

REGOLE
- Oggi è ${today}.
- Trasforma l'outcome in massimo ${maxTasks} attività concrete, ordinate e verificabili.
- Non duplicare attività già aperte: se una proposta coincide, omettila.
- Ogni attività deve avere un risultato osservabile, non formule vaghe come “lavorare su”.
- Usa area ${defaultArea} salvo che Heemia richieda heemia o MG/DMG richieda mg.
- Le priorità vanno da 1 urgente a 4 differibile. Non rendere tutto urgente.
- La durata è lavoro effettivo in minuti; viaggio e preparazione non vanno nascosti nella stima.
- dependsOn contiene gli indici zero-based delle proposte precedenti da completare prima.
- Non inserire orari di calendario. Non dichiarare fatti non presenti nell'outcome o nel contesto.

Rispondi solo con JSON:
{"summary":"...","proposals":[{"title":"...","notes":"...","area":"general|mg|university|heemia|career|personal|health|errand","energy":"high|medium|low","priority":1,"estimatedMinutes":30,"dueDate":"YYYY-MM-DD oppure null","flexibility":"fixed|low|medium|high","dependsOn":[],"evidence":"criterio osservabile di completamento"}]}`;
}
