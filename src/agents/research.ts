import type { DomainAgentId } from './contracts';

export interface OperationalContextTask {
  id: string;
  title: string;
  area: string;
  status: string;
  dueAt: number | null;
  projectKey: string | null;
}

export interface EvidenceClaim {
  claim: string;
  evidenceRef: string;
  source: 'd1' | 'curated_profile' | 'settings';
}

export interface EvidencePack {
  sourceBoundary: 'd1_operational_state';
  domainAgent: DomainAgentId;
  projectFocus: string | null;
  projectFocuses: string[];
  claims: EvidenceClaim[];
  assumptions: string[];
  unknowns: string[];
  gaps: string[];
}

const PROJECT_MARKERS: Record<DomainAgentId, Array<{ key: string; markers: RegExp }>> = {
  'university-context': [
    { key: 'amexio', markers: /\bamexio\b/i },
    { key: 'berzi', markers: /\bberzi\b/i },
    { key: 'dani', markers: /\bdani\b|\bplanner\b/i },
  ],
  'work-portfolio': [
    { key: 'heemia', markers: /\bheemia\b/i },
    { key: 'mg-dmg', markers: /\bmg\b|\bdmg\b|mg integration|dmg integration/i },
  ],
  'personal-admin': [],
};

const PROJECT_SEARCH_TERMS: Record<string, string[]> = {
  amexio: ['amexio'],
  berzi: ['berzi'],
  dani: ['dani', 'planner'],
  heemia: ['heemia'],
  'mg-dmg': ['mg', 'dmg', 'mg integration', 'dmg integration'],
};

export function projectSearchTerms(projectFocus: string): string[] {
  return PROJECT_SEARCH_TERMS[projectFocus] ?? [projectFocus];
}

export function detectProjectFocus(
  domainAgent: DomainAgentId,
  outcome: string,
): string | null {
  return PROJECT_MARKERS[domainAgent].find(({ markers }) => markers.test(outcome))?.key ?? null;
}

export function detectProjectFocuses(
  domainAgent: DomainAgentId,
  outcome: string,
): string[] {
  return PROJECT_MARKERS[domainAgent]
    .filter(({ markers }) => markers.test(outcome))
    .map(({ key }) => key);
}

export function matchesProjectFocus(
  projectFocus: string,
  task: OperationalContextTask,
): boolean {
  const marker = Object.values(PROJECT_MARKERS)
    .flat()
    .find((entry) => entry.key === projectFocus);
  return marker?.markers.test(`${task.projectKey ?? ''} ${task.title}`) ?? false;
}

/**
 * Honest Phase-1 research adapter. It retrieves only authorised operational
 * D1 facts and keeps absent knowledge explicit. Vault/Notion/web retrieval is
 * not implied by the agent name and can be added only through an allowlist.
 */
export function buildEvidencePack(params: {
  domainAgent: DomainAgentId;
  outcome: string;
  tasks: OperationalContextTask[];
  projectFocus?: string | null;
  projectFocuses?: string[];
}): EvidencePack {
  const projectFocuses =
    params.projectFocuses ??
    (params.projectFocus === undefined
      ? detectProjectFocuses(params.domainAgent, params.outcome)
      : params.projectFocus
        ? [params.projectFocus]
        : []);
  const projectFocus = projectFocuses.length === 1 ? projectFocuses[0]! : null;
  const relevant = projectFocuses.length > 0
    ? params.tasks.filter((task) =>
        projectFocuses.some((focus) => matchesProjectFocus(focus, task)),
      )
    : params.tasks;

  const claims = relevant.map((task) => ({
    claim: `Open task: ${task.title} [${task.area}; ${task.status}]${task.dueAt ? `; due ${new Date(task.dueAt).toISOString()}` : ''}`,
    evidenceRef: `d1:task:${task.id}`,
    source: 'd1' as const,
  }));

  const unknowns: string[] = [];
  const gaps: string[] = [];
  if (projectFocuses.length === 0 && params.domainAgent !== 'personal-admin') {
    unknowns.push('The requested project is not explicit.');
  }
  if (claims.length === 0) {
    gaps.push(
      projectFocuses.length > 0
        ? `No open D1 tasks were found for ${projectFocuses.join(', ')}.`
        : 'No relevant open D1 tasks were found.',
    );
  }
  gaps.push('Decision logs, vault notes and external sources are not loaded in this Phase-1 adapter.');

  return {
    sourceBoundary: 'd1_operational_state',
    domainAgent: params.domainAgent,
    projectFocus,
    projectFocuses,
    claims,
    assumptions: [],
    unknowns,
    gaps,
  };
}
