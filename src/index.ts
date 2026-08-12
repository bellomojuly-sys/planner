import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { ZodError } from 'zod';
import { withDb, type AppBindings } from './auth/middleware';
import { authRoutes } from './routes/auth';
import { planRoutes } from './routes/plan';
import { taskRoutes } from './routes/tasks';
import { shoppingRoutes } from './routes/shopping';
import { settingsRoutes } from './routes/settings';
import { captureRoutes } from './routes/capture';
import { handleScheduled } from './jobs/cron';
import { PlannerError, toPlannerError } from './lib/errors';
import type { Env } from './env';

const app = new Hono<AppBindings>();

app.use(
  '*',
  secureHeaders({
    // The PWA is entirely self-hosted; nothing loads from a third party, and
    // no API key ever reaches the browser.
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
    referrerPolicy: 'no-referrer',
  }),
);

app.use('/api/*', withDb);

app.route('/api/auth', authRoutes);
app.route('/api/plan', planRoutes);
app.route('/api/tasks', taskRoutes);
app.route('/api/shopping', shoppingRoutes);
app.route('/api/settings', settingsRoutes);
app.route('/api/capture', captureRoutes);

app.get('/api/health', (c) =>
  c.json({ ok: true, environment: c.env.ENVIRONMENT, timezone: c.env.APP_TIMEZONE }),
);

/**
 * Single error boundary. Everything the client sees is a `PlannerError`'s
 * Italian `userMessage`; internal messages and upstream response bodies stay
 * in the logs.
 */
app.onError((err, c) => {
  if (err instanceof ZodError) {
    const details = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    console.warn('[validation]', details.join('; '));
    return c.json(
      { error: 'bad_request', message: 'Dati non validi.', details },
      400,
    );
  }

  const pe = toPlannerError(err);
  if (pe.status >= 500) {
    console.error('[error]', pe.code, pe.message, pe.cause ?? '');
  } else {
    console.warn('[error]', pe.code, pe.message);
  }

  return c.json(pe.toJSON(), pe.status as never);
});

app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) {
    return c.json(new PlannerError('not_found').toJSON(), 404);
  }
  // Everything else falls through to the static asset handler configured in
  // wrangler.toml, which serves the PWA shell for client-side routes.
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  fetch: app.fetch,

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    // waitUntil keeps the isolate alive for the full pass; without it a slow
    // Notion response can be cut off mid-sync.
    ctx.waitUntil(handleScheduled(env));
  },
} satisfies ExportedHandler<Env>;
