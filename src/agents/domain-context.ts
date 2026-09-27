import { and, desc, eq, inArray, like, notInArray, or } from 'drizzle-orm';
import type { DB } from '../db/client';
import { tasks } from '../db/schema';
import type { DomainAgentId } from './contracts';
import {
  buildEvidencePack,
  detectProjectFocuses,
  matchesProjectFocus,
  projectSearchTerms,
  type EvidencePack,
  type OperationalContextTask,
} from './research';

interface CuratedProjectProfile {
  ref: string;
  label: string;
  context: string[];
}

const CURATED_PROJECT_PROFILES: Record<string, CuratedProjectProfile> = {
  amexio: {
    ref: 'curated:university:amexio:v1',
    label: 'Amexio',
    context: [
      'University Industry Project.',
      'A deliverable is OpenText-ready only after target requirements and import proof exist.',
    ],
  },
  berzi: {
    ref: 'curated:university:berzi:v1',
    label: 'Berzi',
    context: [
      'University project.',
      'No project-specific roadmap fact is assumed unless it is present in D1 or the request.',
    ],
  },
  dani: {
    ref: 'curated:university:dani:v1',
    label: 'Dani',
    context: [
      'University project and Personal Chief of Staff product.',
      'Calendar placement remains owned by the deterministic Reality Planning Agent.',
    ],
  },
  heemia: {
    ref: 'curated:work:heemia:v1',
    label: 'Heemia',
    context: [
      'Product, inventory, integrations and operations are distinct workstreams.',
      'Do not claim a production change without deployment and verification evidence.',
    ],
  },
  'mg-dmg': {
    ref: 'curated:work:mg-dmg:v1',
    label: 'MG/DMG',
    context: [
      'Protect the client delivery gate: approved requirements, jointly validated proposal and payment evidence.',
      'Keep client onboarding, ownership and shared-system boundaries explicit.',
    ],
  },
};

export const DOMAIN_AGENT_INSTRUCTIONS: Record<DomainAgentId, string> = {
  'university-context':
    'Turn the requested university outcome into reviewable artefacts, evidence and checkpoints. Preserve the project relationship and distinguish coursework facts, feedback, assumptions and open questions.',
  'work-portfolio':
    'Treat Heemia and MG/DMG as separate portfolios. Protect client gates and production boundaries; never merge project context or invent approval, payment, access or deployment state.',
  'personal-admin':
    'Decompose bureaucracy, home, appointments, practical health and errands into atomic actions. Keep sensitive detail minimal and surface preparation, travel and required documents as explicit unknowns when absent.',
};

export interface DomainContext {
  domainAgent: DomainAgentId;
  projectFocus: string | null;
  projectFocuses: string[];
  curatedProfile: CuratedProjectProfile | null;
  curatedProfiles: CuratedProjectProfile[];
  operationalTasks: OperationalContextTask[];
  evidencePack: EvidencePack;
  sourceRefs: string[];
  retrieval: {
    queried: number;
    retained: number;
    limit: number;
  };
}

export async function buildDomainContext(
  db: DB,
  userId: string,
  domainAgent: DomainAgentId,
  outcome: string,
): Promise<DomainContext> {
  const projectFocuses = detectProjectFocuses(domainAgent, outcome);
  const projectFocus = projectFocuses.length === 1 ? projectFocuses[0]! : null;
  const limit = projectFocuses.length > 0 ? 80 : 40;
  const domainAreas = areasForDomain(domainAgent);
  const projectCondition = projectFocuses.length > 0
    ? or(
        ...projectFocuses.flatMap((focus) => projectSearchTerms(focus)).flatMap((term) => [
          like(tasks.projectKey, `%${term}%`),
          like(tasks.title, `%${term}%`),
        ]),
      )
    : undefined;
  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      area: tasks.area,
      status: tasks.status,
      dueAt: tasks.dueAt,
      projectKey: tasks.projectKey,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        notInArray(tasks.status, ['done', 'cancelled']),
        inArray(tasks.area, domainAreas),
        projectCondition,
      ),
    )
    .orderBy(desc(tasks.updatedAt))
    .limit(limit);

  const domainRows = rows.filter((task) => belongsToDomain(task, domainAgent));
  const operationalTasks = projectFocuses.length > 0
    ? domainRows.filter((task) =>
        projectFocuses.some((focus) => matchesProjectFocus(focus, task)),
      )
    : domainRows;
  const curatedProfiles = projectFocuses
    .map((focus) => CURATED_PROJECT_PROFILES[focus])
    .filter((profile): profile is CuratedProjectProfile => Boolean(profile));
  const curatedProfile = curatedProfiles.length === 1 ? curatedProfiles[0]! : null;
  const operationalEvidencePack = buildEvidencePack({
    domainAgent,
    outcome,
    tasks: operationalTasks,
    projectFocus,
    projectFocuses,
  });
  const evidencePack: EvidencePack = {
    ...operationalEvidencePack,
    claims: [
      ...curatedProfiles.flatMap((profile) => profile.context.map((claim) => ({
        claim,
        evidenceRef: profile.ref,
        source: 'curated_profile' as const,
      }))),
      ...operationalEvidencePack.claims,
    ],
  };
  const sourceRefs = [
    ...new Set([
      ...curatedProfiles.map((profile) => profile.ref),
      ...evidencePack.claims.map((claim) => claim.evidenceRef),
    ]),
  ];

  return {
    domainAgent,
    projectFocus,
    projectFocuses,
    curatedProfile,
    curatedProfiles,
    operationalTasks,
    evidencePack,
    sourceRefs,
    retrieval: { queried: rows.length, retained: operationalTasks.length, limit },
  };
}

function belongsToDomain(task: OperationalContextTask, domainAgent: DomainAgentId): boolean {
  if (domainAgent === 'university-context') return task.area === 'university';
  if (domainAgent === 'work-portfolio') return task.area === 'heemia' || task.area === 'mg';
  return ['general', 'personal', 'health', 'errand', 'career'].includes(task.area);
}

function areasForDomain(domainAgent: DomainAgentId) {
  if (domainAgent === 'university-context') return ['university'] as const;
  if (domainAgent === 'work-portfolio') return ['heemia', 'mg'] as const;
  return ['general', 'personal', 'health', 'errand', 'career'] as const;
}
