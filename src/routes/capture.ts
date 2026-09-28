import { Hono } from 'hono';
import { z } from 'zod';
import type { AppBindings } from '../auth/middleware';
import { requireAuth } from '../auth/middleware';
import { handleCapture, type CaptureResult } from '../services/capture';
import { drainOutbox } from '../services/outbox';
import { loadAgenda, renderVoiceAgenda } from '../jobs/daily';
import {
  cancelCommitmentProposal,
  commitProposalSet,
  continueCommitmentProposal,
  isSimpleCommitmentRequest,
  organizeOutcome,
} from '../agents/orchestrator';
import type { TaskProposal } from '../agents/contracts';

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

interface CommitmentPreview {
  summary: string;
  clarifyingQuestion: string | null;
  blockingVerificationRequired: boolean;
  proposals: TaskProposal[];
  trace: { request: { requestId: string } };
}

export function renderActionButtonCommitment(
  proposal: CommitmentPreview,
  timezone = 'Europe/Rome',
) {
  const sessionId = proposal.trace.request.requestId;
  if (proposal.blockingVerificationRequired) {
    return {
      state: 'needs_input' as const,
      sessionId,
      spoken: proposal.clarifyingQuestion ?? 'Mi serve un dettaglio in più.',
    };
  }

  const fixed = proposal.proposals.find((item) => item.fixedStartAt);
  if (!fixed?.fixedStartAt) {
    return {
      state: 'ready' as const,
      sessionId,
      spoken: `${proposal.summary} Vuoi inserirlo e pianificarlo?`,
    };
  }
  return {
    state: 'ready' as const,
    sessionId,
    spoken: renderFixedCommitmentPreview(fixed, timezone),
  };
}

function renderFixedCommitmentPreview(
  proposal: TaskProposal,
  timezone: string,
): string {
  const start = Date.parse(proposal.fixedStartAt!);
  const end = start + proposal.estimatedMinutes * 60_000;
  const preparationStart =
    start - (proposal.preparationMinutes + proposal.travelMinutes) * 60_000;
  const departure = start - proposal.travelMinutes * 60_000;
  const clock = (timestamp: number) =>
    new Intl.DateTimeFormat('it-IT', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
    }).format(timestamp);
  const day = new Intl.DateTimeFormat('it-IT', {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(start);
  const parts = [
    `${proposal.title}: ${day}, dalle ${clock(start)} alle ${clock(end)}`,
    proposal.location ? `a ${proposal.location}` : null,
    proposal.preparationMinutes > 0
      ? `preparazione dalle ${clock(preparationStart)}`
      : null,
    proposal.travelMinutes > 0 ? `partenza alle ${clock(departure)}` : null,
    'Vuoi inserirlo e pianificarlo?',
  ];
  return parts.filter(Boolean).join('. ');
}

const ActionButtonRequestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('start'),
    text: z.string().min(1).max(2000),
    clientRequestId: z.string().max(100).optional(),
  }),
  z.object({
    action: z.literal('reply'),
    sessionId: z.string().uuid(),
    text: z.string().min(1).max(1000),
  }),
  z.object({ action: z.literal('confirm'), sessionId: z.string().uuid() }),
  z.object({ action: z.literal('cancel'), sessionId: z.string().uuid() }),
]);

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
      commitment: z
        .object({
          outcome: z.string().min(3).max(4000),
          conversation: z
            .array(
              z.object({
                role: z.enum(['assistant', 'user']),
                content: z.string().min(1).max(1000),
              }),
            )
            .max(12),
        })
        .optional(),
    })
    .parse(await c.req.json());

  const auth = c.get('auth');
  const conversationalCommitment =
    body.source === 'web' &&
    auth.scope === 'full' &&
    (body.commitment || isSimpleCommitmentRequest(body.text));

  if (conversationalCommitment) {
    const outcome = body.commitment?.outcome ?? body.text;
    const conversation = body.commitment?.conversation ?? [];
    const proposal = await organizeOutcome(c.env, c.get('db'), auth.userId, {
      outcome,
      domain: 'personal',
      conversation,
      maxTasks: 1,
    });
    const spoken = proposal.clarifyingQuestion ??
      `${proposal.summary} Controlla i dettagli e conferma per inserirlo nel piano.`;
    return c.json({
      ok: true,
      spoken,
      summary: proposal.summary,
      applied: [],
      skipped: [],
      replanned: false,
      captureId: null,
      language: 'it' as const,
      commitment: proposal,
    });
  }

  const result = await handleCapture(c.env, c.get('db'), auth.userId, body);

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
 * Stateful JSON endpoint for the Action Button Shortcut. The capture token can
 * continue and approve only its own immutable, expiring proposal; it still
 * cannot read the task ledger, settings or arbitrary agent proposals.
 *
 * Non-commitment commands use the existing one-shot capture path so the same
 * Shortcut also keeps completing tasks and answering agenda questions.
 */
captureRoutes.post('/action-button', requireAuth('capture'), async (c) => {
  const body = ActionButtonRequestSchema.parse(await c.req.json());
  const db = c.get('db');
  const userId = c.get('auth').userId;

  if (body.action === 'reply') {
    const proposal = await continueCommitmentProposal(c.env, db, userId, {
      sourceRequestId: body.sessionId,
      answer: body.text,
    });
    return c.json({ ok: true, ...renderActionButtonCommitment(proposal, c.env.APP_TIMEZONE) });
  }

  if (body.action === 'confirm') {
    const committed = await commitProposalSet(c.env, db, userId, {
      sourceRequestId: body.sessionId,
    });
    return c.json({
      ok: true,
      state: 'done' as const,
      sessionId: body.sessionId,
      spoken: committed.confirmation,
      committed: true,
    });
  }

  if (body.action === 'cancel') {
    await cancelCommitmentProposal(db, userId, body.sessionId);
    return c.json({
      ok: true,
      state: 'done' as const,
      sessionId: body.sessionId,
      spoken: 'Va bene, non ho cambiato il piano.',
      committed: false,
    });
  }

  if (isSimpleCommitmentRequest(body.text)) {
    const proposal = await organizeOutcome(c.env, db, userId, {
      outcome: body.text,
      domain: 'personal',
      conversation: [],
      maxTasks: 1,
    });
    return c.json({ ok: true, ...renderActionButtonCommitment(proposal, c.env.APP_TIMEZONE) });
  }

  const result = await handleCapture(c.env, db, userId, {
    text: body.text,
    source: 'shortcut',
    clientRequestId: body.clientRequestId,
  });
  let spoken = renderCaptureOutcome(result);
  if (result.answer) {
    const agenda = await loadAgenda(
      db,
      userId,
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
  c.executionCtx.waitUntil(drainOutbox(c.env, db));
  return c.json({
    ok: true,
    state: 'done' as const,
    sessionId: null,
    spoken,
    committed: result.applied.length > 0,
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
