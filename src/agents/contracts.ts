import { z } from 'zod';
import { AREAS, ENERGY } from '../db/schema';

export const AGENT_IDS = [
  'dani-supervisor',
  'context-perception',
  'reality-planner',
  'research-knowledge',
  'execution-operator',
  'voice-conversation',
  'memory-learning',
  'outcome-evaluator',
  'university-context',
  'work-portfolio',
  'personal-admin',
] as const;

export type AgentId = (typeof AGENT_IDS)[number];
export type DomainAgentId =
  | 'university-context'
  | 'work-portfolio'
  | 'personal-admin';

/**
 * Phase-1 is deliberately closed over Dani's own state. Adding a provider here
 * is an authority change, not an implementation detail: it requires a later
 * explicit decision and a new acceptance run.
 */
export const PHASE_ONE_CONTEXT_POLICY = {
  version: 'phase-1-v1',
  approvedSources: ['d1', 'curated_profile', 'settings', 'user_input'],
  deniedByDefault: ['notion', 'obsidian', 'web', 'email'],
  provenanceRequired: true,
  externalContextIngestion: false,
} as const;

export interface AgentDefinition {
  id: AgentId;
  name: string;
  role: 'supervisor' | 'core' | 'domain';
  transport: 'agent_as_tool';
  implementation: string;
  capabilities: string[];
  a2aEligible: boolean;
  status: 'registered';
}

export const SpecialistAuthoritySchema = z.enum([
  'read',
  'propose',
  'draft',
  'change_with_confirmation',
  'autonomous_reversible',
]);

export const PrivacyClassSchema = z.enum([
  'operational',
  'personal',
  'sensitive',
]);

export const SpecialistRequestSchema = z.object({
  requestId: z.string().uuid(),
  userGoal: z.string().min(3).max(4000),
  taskType: z.string().min(1).max(120),
  contextRefs: z.array(z.string().max(300)).max(100).default([]),
  allowedSources: z.array(z.string().max(120)).max(20).default(['d1']),
  allowedCapabilities: z.array(z.string().max(120)).max(30).default([]),
  authority: SpecialistAuthoritySchema.default('propose'),
  deadline: z.number().int().positive().nullable().default(null),
  costBudget: z.number().nonnegative().nullable().default(null),
  privacyClass: PrivacyClassSchema.default('personal'),
  expectedOutputSchema: z.string().max(300),
  acceptanceContract: z.string().min(1).max(1000),
});

export type SpecialistRequest = z.infer<typeof SpecialistRequestSchema>;

export const SpecialistTraceSchema = z.object({
  request: SpecialistRequestSchema,
  agents: z.array(z.enum(AGENT_IDS)).min(1),
  status: z.enum(['completed', 'input_required', 'failed', 'cancelled']),
  steps: z.array(
    z.object({
      agentId: z.enum(AGENT_IDS),
      operation: z.string().min(1).max(120),
      status: z.enum(['completed', 'input_required', 'failed', 'cancelled']),
      detail: z.string().max(500),
      evidenceRefs: z.array(z.string().max(300)).max(100).default([]),
    }),
  ).min(1),
});

export const TaskProposalSchema = z.object({
  title: z.string().min(1).max(300),
  notes: z.string().max(4000).default(''),
  area: z.enum(AREAS),
  energy: z.enum(ENERGY).default('medium'),
  priority: z.number().int().min(1).max(4).default(3),
  estimatedMinutes: z.number().int().min(5).max(600),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  fixedStartAt: z.string().datetime({ offset: true }).nullable().default(null),
  location: z.string().max(300).nullable().default(null),
  travelMinutes: z.number().int().min(0).max(240).default(0),
  preparationMinutes: z.number().int().min(0).max(240).default(0),
  recoveryMinutes: z.number().int().min(0).max(240).default(0),
  flexibility: z.enum(['fixed', 'low', 'medium', 'high']).default('high'),
  dependsOn: z.array(z.number().int().min(0).max(11)).max(6).default([]),
  evidence: z.string().max(800).default(''),
});

export type TaskProposal = z.infer<typeof TaskProposalSchema>;

export const OrganizeOutcomeInputSchema = z.object({
  outcome: z.string().min(3).max(4000),
  domain: z
    .enum(['auto', 'university', 'work', 'personal'])
    .default('auto'),
  constraints: z.string().max(2000).optional(),
  conversation: z.array(
    z.object({
      role: z.enum(['assistant', 'user']),
      content: z.string().min(1).max(1000),
    }),
  ).max(12).default([]),
  maxTasks: z.number().int().min(1).max(12).default(8),
});

export const TaskProposalSetSchema = z.object({
  summary: z.string().min(1).max(1000),
  proposals: z.array(TaskProposalSchema).min(1).max(12),
  assumptions: z.array(z.string().max(500)).max(20).default([]),
  unknowns: z.array(z.string().max(500)).max(20).default([]),
  evidenceRefs: z.array(z.string().max(300)).max(80).default([]),
  verificationRequired: z.array(z.string().max(500)).max(20).default([]),
  clarifyingQuestion: z.string().min(1).max(500).nullable().default(null),
});

export const CommitProposalInputSchema = z.object({
  sourceRequestId: z.string().uuid(),
}).strict();
