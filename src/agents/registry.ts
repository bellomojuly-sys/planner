import type {
  AgentDefinition,
  DomainAgentId,
} from './contracts';

export const AGENT_REGISTRY: readonly AgentDefinition[] = [
  {
    id: 'dani-supervisor',
    name: 'Dani Supervisor',
    role: 'supervisor',
    transport: 'agent_as_tool',
    implementation: 'agents/orchestrator',
    capabilities: ['route_goal', 'select_domain_agent', 'synthesise', 'request_commit'],
    a2aEligible: false,
    status: 'active',
  },
  {
    id: 'context-perception',
    name: 'Context and Perception Agent',
    role: 'core',
    transport: 'agent_as_tool',
    implementation: 'D1 task context adapter',
    capabilities: ['read_open_tasks', 'identify_domain', 'report_unknowns'],
    a2aEligible: false,
    status: 'active',
  },
  {
    id: 'reality-planner',
    name: 'Reality Planning Agent',
    role: 'core',
    transport: 'agent_as_tool',
    implementation: 'services/planner',
    capabilities: ['prioritise', 'keep_move_postpone_ask', 'request_feasible_schedule'],
    a2aEligible: false,
    status: 'active',
  },
  {
    id: 'research-knowledge',
    name: 'Research and Knowledge Agent',
    role: 'core',
    transport: 'agent_as_tool',
    implementation: 'agents/research D1 evidence adapter',
    capabilities: ['retrieve_d1_evidence', 'separate_fact_assumption_unknown', 'report_source_gaps'],
    a2aEligible: false,
    status: 'active',
  },
  {
    id: 'execution-operator',
    name: 'Execution Operator Agent',
    role: 'core',
    transport: 'agent_as_tool',
    implementation: 'agents/orchestrator commitProposalSet',
    capabilities: ['create_tasks', 'create_dependencies', 'request_replan'],
    a2aEligible: false,
    status: 'active',
  },
  {
    id: 'voice-conversation',
    name: 'Voice and Conversation Agent',
    role: 'core',
    transport: 'agent_as_tool',
    implementation: 'services/capture',
    capabilities: ['interpret_voice', 'answer_agenda', 'apply_confirmed_intent'],
    a2aEligible: false,
    status: 'active',
  },
  {
    id: 'memory-learning',
    name: 'Memory and Learning Agent',
    role: 'core',
    transport: 'agent_as_tool',
    implementation: 'scheduler/estimate learning adapter',
    capabilities: ['apply_duration_learning', 'preserve_provenance'],
    a2aEligible: false,
    status: 'active',
  },
  {
    id: 'outcome-evaluator',
    name: 'Outcome Evaluator Agent',
    role: 'core',
    transport: 'agent_as_tool',
    implementation: 'scheduler deterministic validation',
    capabilities: ['validate_schema', 'validate_feasibility', 'report_unplaced'],
    a2aEligible: false,
    status: 'active',
  },
  {
    id: 'university-context',
    name: 'University Context Agent',
    role: 'domain',
    transport: 'agent_as_tool',
    implementation: 'agents/orchestrator domain profile',
    capabilities: ['curated_project_profile', 'd1_task_context', 'session_decomposition'],
    a2aEligible: true,
    status: 'active',
  },
  {
    id: 'work-portfolio',
    name: 'Work Portfolio Agent',
    role: 'domain',
    transport: 'agent_as_tool',
    implementation: 'agents/orchestrator domain profile',
    capabilities: ['curated_project_profile', 'd1_task_context', 'cross_project_decomposition'],
    a2aEligible: true,
    status: 'active',
  },
  {
    id: 'personal-admin',
    name: 'Personal Admin Agent',
    role: 'domain',
    transport: 'agent_as_tool',
    implementation: 'agents/orchestrator domain profile',
    capabilities: ['d1_task_context', 'bureaucracy_decomposition', 'errand_preparation'],
    a2aEligible: true,
    status: 'active',
  },
] as const;

export interface DomainProfile {
  agentId: DomainAgentId;
  label: string;
  defaultArea: 'university' | 'heemia' | 'mg' | 'personal';
  capabilities: string[];
}

export const DOMAIN_PROFILES: Record<DomainAgentId, DomainProfile> = {
  'university-context': {
    agentId: 'university-context',
    label: 'Università',
    defaultArea: 'university',
    capabilities: ['curated_project_profile', 'd1_task_context', 'session_decomposition'],
  },
  'work-portfolio': {
    agentId: 'work-portfolio',
    label: 'Lavoro',
    defaultArea: 'heemia',
    capabilities: ['curated_project_profile', 'd1_task_context', 'cross_project_decomposition'],
  },
  'personal-admin': {
    agentId: 'personal-admin',
    label: 'Personale',
    defaultArea: 'personal',
    capabilities: ['d1_task_context', 'bureaucracy_decomposition', 'errand_preparation'],
  },
};

const UNIVERSITY_MARKERS = /\b(universit[aà]|university|portfolio|berzi|amexio|professore|docente)\b/i;
const WORK_MARKERS = /\b(heemia|mg|dmg|cliente|client|proposal|inventario|integration)\b/i;

export function selectDomainAgent(
  outcome: string,
  requested: 'auto' | 'university' | 'work' | 'personal',
): DomainAgentId {
  if (requested === 'university') return 'university-context';
  if (requested === 'work') return 'work-portfolio';
  if (requested === 'personal') return 'personal-admin';

  if (UNIVERSITY_MARKERS.test(outcome)) {
    return 'university-context';
  }
  if (WORK_MARKERS.test(outcome)) {
    return 'work-portfolio';
  }
  return 'personal-admin';
}
