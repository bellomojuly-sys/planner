import { describe, expect, it } from 'vitest';
import { AGENT_IDS, TaskProposalSetSchema } from '../src/agents/contracts';
import { AGENT_REGISTRY, selectDomainAgent } from '../src/agents/registry';
import { buildDomainPrompt } from '../src/agents/orchestrator';

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
    const prompt = buildDomainPrompt('context', 'university', '2026-09-27', 6);
    expect(prompt).toContain('Non assegni orari');
    expect(prompt).toContain('Reality Planning Agent globale');
    expect(prompt).toContain('massimo 6 attività');
  });
});
