import { Hono } from 'hono';
import type { AppBindings } from '../auth/middleware';
import { requireAuth } from '../auth/middleware';
import { AGENT_REGISTRY, DOMAIN_PROFILES } from '../agents/registry';
import { commitProposalSet, organizeOutcome } from '../agents/orchestrator';

export const agentRoutes = new Hono<AppBindings>();

agentRoutes.use('*', requireAuth('read'));

agentRoutes.get('/', (c) =>
  c.json({
    architecture: 'supervisor_with_agents_as_tools',
    taskLedger: 'd1',
    calendarAuthority: 'reality-planner',
    a2a: 'reserved_for_independent_boundaries',
    agents: AGENT_REGISTRY,
    domains: Object.values(DOMAIN_PROFILES).map(({ agentId, label }) => ({
      agentId,
      label,
    })),
  }),
);

agentRoutes.post('/organize', requireAuth('full'), async (c) =>
  c.json(
    await organizeOutcome(c.env, c.get('db'), c.get('auth').userId, await c.req.json()),
  ),
);

agentRoutes.post('/commit', requireAuth('full'), async (c) =>
  c.json(
    await commitProposalSet(
      c.env,
      c.get('db'),
      c.get('auth').userId,
      await c.req.json(),
    ),
  ),
);
