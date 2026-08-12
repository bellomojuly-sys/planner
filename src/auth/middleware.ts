import type { MiddlewareHandler } from 'hono';
import { getDb, type DB } from '../db/client';
import { authenticate, type AuthContext } from './session';
import { PlannerError } from '../lib/errors';
import type { Env } from '../env';

export interface AppBindings {
  Bindings: Env;
  Variables: {
    db: DB;
    auth: AuthContext;
  };
}

/** Attaches a Drizzle handle to every request so routes never build their own. */
export const withDb: MiddlewareHandler<AppBindings> = async (c, next) => {
  c.set('db', getDb(c.env));
  await next();
};

/**
 * `minScope` is ordered: full > read > capture. A `capture` token presented to
 * a route requiring `read` is rejected rather than silently downgraded.
 */
const RANK = { capture: 0, read: 1, full: 2 } as const;

export function requireAuth(
  minScope: 'capture' | 'read' | 'full' = 'full',
): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const auth = await authenticate(c, c.get('db'));
    if (!auth) throw new PlannerError('unauthorized');

    if (RANK[auth.scope] < RANK[minScope]) {
      throw new PlannerError('unauthorized', {
        message: `scope ${auth.scope} < required ${minScope}`,
        userMessage: 'Questo token non ha i permessi necessari.',
      });
    }

    c.set('auth', auth);
    await next();
  };
}
