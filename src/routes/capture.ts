import { Hono } from 'hono';
import { z } from 'zod';
import type { AppBindings } from '../auth/middleware';
import { requireAuth } from '../auth/middleware';
import { handleCapture, type CaptureResult } from '../services/capture';
import { drainOutbox } from '../services/outbox';
import { loadAgenda, renderVoiceAgenda } from '../jobs/daily';

export const captureRoutes = new Hono<AppBindings>();

/**
 * Never repeat the model's optimistic summary when the requested write failed.
 * `summary` describes what DeepSeek understood; only `applied` proves that the
 * action reached D1. Mixed utterances report both the success and the failure.
 */
export function renderCaptureOutcome(
  result: Pick<CaptureResult, 'summary' | 'applied' | 'skipped'> &
    Partial<Pick<CaptureResult, 'language'>>,
): string {
  const applied = result.applied.join('. ');
  const skipped = result.skipped.join('. ');
  const english = result.language === 'en';

  if (applied && skipped) {
    return `${applied}. ${english ? 'Not applied' : 'Non applicato'}: ${skipped}`;
  }
  if (applied) return applied;
  if (skipped) {
    return english
      ? `I did not save the request: ${skipped}`
      : `Non ho salvato la richiesta: ${skipped}`;
  }
  return result.summary;
}

/** Noon UTC is safely inside the requested Europe/Rome calendar date. */
export function agendaAnchor(requestedDate: string | undefined, now = Date.now()): number {
  if (!requestedDate) return now;
  const anchor = Date.parse(`${requestedDate}T12:00:00Z`);
  return Number.isFinite(anchor) ? anchor : now;
}

/**
 * The iPhone Action Button endpoint.
 *
 * Reachable with a `capture`-scoped bearer token and nothing else, so the
 * token stored in the Shortcut cannot read the plan or change settings. The
 * response is plain enough to be spoken back by the Shortcut.
 */
captureRoutes.post('/', requireAuth('capture'), async (c) => {
  const body = z
    .object({
      text: z.string().min(1).max(2000),
      source: z.enum(['action_button', 'web', 'shortcut', 'api']).default('action_button'),
      /** Idempotency key — the Shortcut resends on a flaky connection. */
      clientRequestId: z.string().max(100).optional(),
    })
    .parse(await c.req.json());

  const result = await handleCapture(c.env, c.get('db'), c.get('auth').userId, body);

  // Answer questions inline so "cosa devo fare oggi?" works from the lock
  // screen without opening the app.
  let spoken = renderCaptureOutcome(result);
  if (result.answer) {
    const agenda = await loadAgenda(
      c.get('db'),
      c.get('auth').userId,
      c.env.APP_TIMEZONE,
      agendaAnchor(result.answerDate),
    );
    const agendaSpeech = renderVoiceAgenda(
      agenda,
      c.env.APP_TIMEZONE,
      Date.now(),
      result.language,
    );
    const changed = result.applied.length > 0 || result.skipped.length > 0;
    spoken = changed ? `${renderCaptureOutcome(result)}. ${agendaSpeech}` : agendaSpeech;
  }

  // Fire the Notion and Google writes now; the Shortcut has already got its
  // answer, so this only affects how quickly other devices see the change.
  c.executionCtx.waitUntil(drainOutbox(c.env, c.get('db')));

  return c.json({
    ok: true,
    spoken,
    summary: result.summary,
    applied: result.applied,
    skipped: result.skipped,
    replanned: result.replanned,
    captureId: result.captureId,
    language: result.language,
  });
});

/**
 * Plain-text variant. iOS Shortcuts can post a dictated string here with no
 * JSON building at all, which makes the Action Button setup a three-step
 * shortcut instead of ten.
 */
captureRoutes.post('/text', requireAuth('capture'), async (c) => {
  const text = (await c.req.text()).trim();
  const result = await handleCapture(c.env, c.get('db'), c.get('auth').userId, {
    text,
    source: 'action_button',
  });

  c.executionCtx.waitUntil(drainOutbox(c.env, c.get('db')));

  // A question gets the requested day's agenda, so the
  // same dictation shortcut both changes the plan and reads it back. Anything
  // it also changed in the same sentence is said first.
  if (result.answer) {
    const agenda = await loadAgenda(
      c.get('db'),
      c.get('auth').userId,
      c.env.APP_TIMEZONE,
      agendaAnchor(result.answerDate),
    );
    const changed = result.applied.length > 0 || result.skipped.length > 0;
    const outcome = changed ? `${renderCaptureOutcome(result)}. ` : '';
    return c.text(
      outcome +
        renderVoiceAgenda(
          agenda,
          c.env.APP_TIMEZONE,
          Date.now(),
          result.language,
        ),
    );
  }

  return c.text(renderCaptureOutcome(result));
});
