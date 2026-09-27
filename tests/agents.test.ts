import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_IDS,
  CommitProposalInputSchema,
  OrganizeOutcomeInputSchema,
  SpecialistTraceSchema,
  TaskProposalSetSchema,
} from '../src/agents/contracts';
import {
  AGENT_REGISTRY,
  agentRuntimeStatus,
  selectDomainAgent,
} from '../src/agents/registry';
import {
  buildDomainPrompt,
  commitRequiresInput,
  fallbackSimpleCommitmentProposalSet,
  normalizeSimpleCommitment,
  reconcileEvidenceRefs,
} from '../src/agents/orchestrator';
import {
  buildEvidencePack,
  detectProjectFocus,
  detectProjectFocuses,
} from '../src/agents/research';
import { DOMAIN_AGENT_INSTRUCTIONS } from '../src/agents/domain-context';

describe('agent foundation', () => {
  it('registers every required agent exactly once', () => {
    expect(AGENT_REGISTRY.map((agent) => agent.id)).toEqual([...AGENT_IDS]);
    expect(new Set(AGENT_REGISTRY.map((agent) => agent.id)).size).toBe(AGENT_IDS.length);
    expect(AGENT_REGISTRY.every((agent) => agent.status === 'registered')).toBe(true);
  });

  it('routes explicit and obvious domain outcomes', () => {
    expect(selectDomainAgent('Preparare il portfolio Amexio', 'auto')).toBe('university-context');
    expect(selectDomainAgent('Chiudere inventario Heemia', 'auto')).toBe('work-portfolio');
    expect(selectDomainAgent('Prenotare il dentista', 'auto')).toBe('personal-admin');
    expect(selectDomainAgent('Inventario', 'university')).toBe('university-context');
    expect(selectDomainAgent('Programmare la settimana', 'auto')).toBe('personal-admin');
  });

  it('reports runtime readiness separately from registry membership', () => {
    expect(agentRuntimeStatus('reality-planner', false)).toBe('ready');
    expect(agentRuntimeStatus('university-context', false)).toBe('unconfigured');
    expect(agentRuntimeStatus('university-context', true)).toBe('ready');
  });

  it('backs the research agent with cited D1 facts and explicit source gaps', () => {
    expect(detectProjectFocus('work-portfolio', 'Chiudere onboarding MG')).toBe('mg-dmg');
    const pack = buildEvidencePack({
      domainAgent: 'work-portfolio',
      outcome: 'Chiudere onboarding MG',
      tasks: [
        {
          id: 'mg-1',
          title: 'Approvare proposta MG',
          area: 'mg',
          status: 'todo',
          dueAt: null,
          projectKey: 'mg-integration',
        },
        {
          id: 'h-1',
          title: 'Inventario Heemia',
          area: 'heemia',
          status: 'todo',
          dueAt: null,
          projectKey: 'heemia',
        },
      ],
    });
    expect(pack.projectFocus).toBe('mg-dmg');
    expect(pack.claims).toEqual([
      expect.objectContaining({ evidenceRef: 'd1:task:mg-1' }),
    ]);
    expect(pack.assumptions).toEqual([]);
    expect(pack.gaps.join(' ')).toContain('vault');
  });

  it('keeps every explicitly named work project in a cross-project request', () => {
    expect(detectProjectFocuses('work-portfolio', 'Allinea Heemia e MG')).toEqual([
      'heemia',
      'mg-dmg',
    ]);
  });

  it('accepts only an immutable proposal id at the commit boundary', () => {
    const sourceRequestId = '06cd59bd-3662-4cd4-8a05-cf6d2a421ffe';
    expect(CommitProposalInputSchema.parse({ sourceRequestId })).toEqual({ sourceRequestId });
    expect(
      CommitProposalInputSchema.safeParse({
        sourceRequestId,
        proposals: [{ title: 'Payload sostituito dal browser' }],
      }).success,
    ).toBe(false);
  });

  it('rejects evidence references outside the request allowlist', () => {
    expect(
      reconcileEvidenceRefs(
        ['d1:task:one', 'curated:work:heemia:v1'],
        ['d1:task:one', 'invented:reference', 'd1:task:one'],
      ),
    ).toEqual({
      accepted: ['d1:task:one'],
      rejected: ['invented:reference'],
    });
  });

  it('keeps the commit trace open when planning or publishing needs attention', () => {
    expect(
      commitRequiresInput(
        { requiresConfirmation: false, blockedByStaleData: false, unplaced: [] },
        { dead: 0, failed: 0 },
      ),
    ).toBe(false);
    expect(
      commitRequiresInput(
        { requiresConfirmation: true, blockedByStaleData: false, unplaced: [] },
        { dead: 0, failed: 0 },
      ),
    ).toBe(true);
    expect(
      commitRequiresInput(
        { requiresConfirmation: false, blockedByStaleData: false, unplaced: [{}] },
        { dead: 0, failed: 0 },
      ),
    ).toBe(true);
    expect(
      commitRequiresInput(
        { requiresConfirmation: false, blockedByStaleData: false, unplaced: [] },
        { dead: 0, failed: 1 },
      ),
    ).toBe(true);
  });

  it('rejects incomplete task proposals at the agent boundary', () => {
    expect(TaskProposalSetSchema.safeParse({ summary: 'x', proposals: [] }).success).toBe(false);
    expect(
      TaskProposalSetSchema.safeParse({
        summary: 'Piano',
        proposals: [
          {
            title: 'Preparare evidenza',
            notes: '',
            area: 'university',
            energy: 'high',
            priority: 2,
            estimatedMinutes: 45,
            dueDate: null,
            flexibility: 'medium',
            dependsOn: [],
            evidence: 'Documento revisionabile',
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('carries a bounded multi-turn conversation into the organizer', () => {
    const parsed = OrganizeOutcomeInputSchema.parse({
      outcome: 'Domani pianifica barbecue',
      conversation: [
        { role: 'assistant', content: 'A che ora?' },
        { role: 'user', content: 'Alle sei circa.' },
      ],
    });
    expect(parsed.conversation).toHaveLength(2);
    expect(parsed.maxTasks).toBe(8);
  });

  it('accepts an exact commitment with preparation and travel', () => {
    const parsed = TaskProposalSetSchema.parse({
      summary: 'Barbecue pianificabile',
      proposals: [
        {
          title: 'Barbecue',
          notes: '',
          area: 'personal',
          energy: 'low',
          priority: 3,
          estimatedMinutes: 180,
          dueDate: '2026-09-28',
          fixedStartAt: '2026-09-28T18:00:00+02:00',
          location: 'Downtown',
          travelMinutes: 20,
          preparationMinutes: 20,
          recoveryMinutes: 0,
          flexibility: 'fixed',
          dependsOn: [],
          evidence: 'Presenza al barbecue alle 18:00',
        },
      ],
      clarifyingQuestion: null,
    });
    expect(parsed.proposals[0]).toMatchObject({
      fixedStartAt: '2026-09-28T18:00:00+02:00',
      location: 'Downtown',
      travelMinutes: 20,
      preparationMinutes: 20,
    });
  });

  it('asks one commitment question at a time and does not invent hosting work', () => {
    const proposalSet = TaskProposalSetSchema.parse({
      summary: 'Piano barbecue',
      proposals: [
        {
          title: 'Definire invitati e budget',
          area: 'personal',
          energy: 'medium',
          priority: 3,
          estimatedMinutes: 30,
          dueDate: '2026-09-27',
          flexibility: 'high',
          dependsOn: [],
          evidence: '',
        },
        {
          title: 'Fare la spesa',
          area: 'errand',
          energy: 'low',
          priority: 3,
          estimatedMinutes: 60,
          dueDate: '2026-09-27',
          flexibility: 'high',
          dependsOn: [],
          evidence: '',
        },
      ],
      unknowns: ['ora', 'luogo', 'invitati', 'budget'],
      clarifyingQuestion: 'A che ora e dove si tiene?',
    });
    const normalized = normalizeSimpleCommitment({
      proposalSet,
      outcome: 'domani pianifica barbecue',
      conversation: [],
      timezone: 'Europe/Rome',
      defaultTravelMinutes: 20,
    });
    expect(normalized.proposals).toHaveLength(1);
    expect(normalized.proposals[0]!.title).toBe('Barbecue');
    expect(normalized.clarifyingQuestion).toBe('A che ora devi essere lì?');
    expect(normalized.unknowns).toEqual(['Orario di inizio di Barbecue']);
  });

  it('keeps a simple commitment conversation alive when the model output is unusable', () => {
    const fallback = fallbackSimpleCommitmentProposalSet('domani pianifica barbecue');
    expect(fallback.proposals).toHaveLength(1);
    expect(fallback.proposals[0]).toMatchObject({
      title: 'Barbecue',
      area: 'personal',
      estimatedMinutes: 60,
    });
  });

  it('builds the fixed evening only after time, place and duration are answered', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T10:00:00.000Z'));
    const proposalSet = TaskProposalSetSchema.parse({
      summary: 'Barbecue',
      proposals: [
        {
          title: 'Barbecue',
          area: 'personal',
          energy: 'low',
          priority: 3,
          estimatedMinutes: 180,
          dueDate: '2026-09-28',
          fixedStartAt: '2026-09-28T18:00:00+02:00',
          location: 'Downtown',
          flexibility: 'fixed',
          dependsOn: [],
          evidence: '',
        },
      ],
    });
    const normalized = normalizeSimpleCommitment({
      proposalSet,
      outcome: 'domani pianifica barbecue',
      conversation: [
        { role: 'assistant', content: 'A che ora?' },
        { role: 'user', content: 'Alle sei circa, devo essere lì.' },
        { role: 'assistant', content: 'Dove si tiene?' },
        { role: 'user', content: 'Al Downtown.' },
        { role: 'assistant', content: 'Fino a che ora?' },
        { role: 'user', content: 'Tutta la sera.' },
      ],
      timezone: 'Europe/Rome',
      defaultTravelMinutes: 20,
    });
    expect(normalized.unknowns).toEqual([]);
    expect(normalized.clarifyingQuestion).toBeNull();
    expect(normalized.proposals[0]).toMatchObject({
      title: 'Barbecue',
      fixedStartAt: '2026-09-28T16:00:00.000Z',
      location: 'Downtown',
      travelMinutes: 20,
      preparationMinutes: 40,
      estimatedMinutes: 300,
      flexibility: 'fixed',
    });
    vi.useRealTimers();
  });

  it('keeps calendar placement outside the domain-agent prompt', () => {
    const prompt = buildDomainPrompt(
      'university-context',
      DOMAIN_AGENT_INSTRUCTIONS['university-context'],
      'university',
      '2026-09-27',
      6,
    );
    expect(prompt).toContain('Non assegni orari');
    expect(prompt).toContain('Reality Planning Agent globale');
    expect(prompt).toContain('massimo 6 attività');
    expect(prompt).toContain('assumptions');
    expect(prompt).toContain('verificationRequired');
    expect(prompt).toContain('clarifyingQuestion');
    expect(prompt).toContain('fixedStartAt');
  });

  it('gives each domain agent distinct instructions', () => {
    expect(DOMAIN_AGENT_INSTRUCTIONS['university-context']).toContain('university');
    expect(DOMAIN_AGENT_INSTRUCTIONS['work-portfolio']).toContain('MG/DMG');
    expect(DOMAIN_AGENT_INSTRUCTIONS['personal-admin']).toContain('bureaucracy');
    expect(new Set(Object.values(DOMAIN_AGENT_INSTRUCTIONS)).size).toBe(3);
  });

  it('validates the observable specialist trace', () => {
    expect(
      SpecialistTraceSchema.parse({
        request: {
          requestId: '06cd59bd-3662-4cd4-8a05-cf6d2a421ffe',
          userGoal: 'Preparare il portfolio Dani',
          taskType: 'organize_outcome',
          contextRefs: ['curated:university:dani:v1'],
          allowedSources: ['d1', 'curated_profile'],
          allowedCapabilities: ['session_decomposition'],
          authority: 'propose',
          privacyClass: 'personal',
          expectedOutputSchema: 'TaskProposalSet',
          acceptanceContract: 'Propose only; do not place calendar blocks.',
        },
        agents: ['dani-supervisor', 'university-context'],
        status: 'completed',
        steps: [
          {
            agentId: 'university-context',
            operation: 'decompose_outcome',
            status: 'completed',
            detail: '2 attività proposte',
            evidenceRefs: ['curated:university:dani:v1'],
          },
        ],
      }).status,
    ).toBe('completed');
  });
});
