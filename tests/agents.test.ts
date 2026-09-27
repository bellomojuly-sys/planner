import { describe, expect, it } from 'vitest';
import {
  AGENT_IDS,
  SpecialistTraceSchema,
  TaskProposalSetSchema,
} from '../src/agents/contracts';
import { AGENT_REGISTRY, selectDomainAgent } from '../src/agents/registry';
import { buildDomainPrompt } from '../src/agents/orchestrator';
import { buildEvidencePack, detectProjectFocus } from '../src/agents/research';
import { DOMAIN_AGENT_INSTRUCTIONS } from '../src/agents/domain-context';

describe('agent foundation', () => {
  it('registers every required agent exactly once', () => {
    expect(AGENT_REGISTRY.map((agent) => agent.id)).toEqual([...AGENT_IDS]);
    expect(new Set(AGENT_REGISTRY.map((agent) => agent.id)).size).toBe(AGENT_IDS.length);
    expect(AGENT_REGISTRY.every((agent) => agent.status === 'active')).toBe(true);
  });

  it('routes explicit and obvious domain outcomes', () => {
    expect(selectDomainAgent('Preparare il portfolio Amexio', 'auto')).toBe('university-context');
    expect(selectDomainAgent('Chiudere inventario Heemia', 'auto')).toBe('work-portfolio');
    expect(selectDomainAgent('Prenotare il dentista', 'auto')).toBe('personal-admin');
    expect(selectDomainAgent('Inventario', 'university')).toBe('university-context');
    expect(selectDomainAgent('Programmare la settimana', 'auto')).toBe('personal-admin');
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
      }).status,
    ).toBe('completed');
  });
});
