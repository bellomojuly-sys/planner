import { useEffect, useRef, useState } from 'react';
import {
  api,
  ApiError,
  type AgentCommitResult,
  type OrganizedOutcome,
} from '../lib/api';
import { enqueueCapture, queueDepth, requestFlush } from '../lib/queue';

interface Props {
  onApplied: () => void;
}

function commitmentSummary(draft: OrganizedOutcome): string {
  const proposal = draft.proposals[0];
  if (!proposal?.fixedStartAt || draft.blockingVerificationRequired) {
    return draft.clarifyingQuestion ?? draft.summary;
  }

  const start = Date.parse(proposal.fixedStartAt);
  const preparationStart =
    start - (proposal.preparationMinutes + proposal.travelMinutes) * 60_000;
  const departure = start - proposal.travelMinutes * 60_000;
  const end = start + proposal.estimatedMinutes * 60_000;
  const clock = (timestamp: number) =>
    new Intl.DateTimeFormat('it-IT', {
      timeZone: 'Europe/Rome',
      hour: '2-digit',
      minute: '2-digit',
    }).format(timestamp);
  const day = new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(start);

  return [
    `${proposal.title}: ${day}, dalle ${clock(start)} alle ${clock(end)}`,
    proposal.location ? `a ${proposal.location}` : null,
    proposal.preparationMinutes > 0
      ? `preparazione dalle ${clock(preparationStart)}`
      : null,
    proposal.travelMinutes > 0 ? `partenza alle ${clock(departure)}` : null,
    'Controlla e conferma per inserirlo nel piano.',
  ].filter(Boolean).join(' · ');
}

/**
 * Text-and-dictation capture inside the app. The iPhone keyboard's microphone
 * key produces the same Italian dictation the Action Button Shortcut uses, so
 * this and the Shortcut hit the same endpoint with the same text.
 *
 * When offline, the utterance is queued locally instead of being lost —
 * capture is the one action that must never fail.
 */
export function CaptureBar({ onApplied }: Props) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: string; text: string } | null>(null);
  const [pending, setPending] = useState(0);
  const [commitment, setCommitment] = useState<{
    outcome: string;
    conversation: Array<{ role: 'assistant' | 'user'; content: string }>;
    proposal: OrganizedOutcome;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void queueDepth().then(setPending);

    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'queue-flushed') {
        setPending(event.data.remaining ?? 0);
        if ((event.data.remaining ?? 0) === 0) onApplied();
      }
    };

    navigator.serviceWorker?.addEventListener('message', onMessage);
    window.addEventListener('online', () => void requestFlush());

    return () => navigator.serviceWorker?.removeEventListener('message', onMessage);
  }, [onApplied]);

  useEffect(() => {
    if (!feedback || commitment) return;
    const id = setTimeout(() => setFeedback(null), 6000);
    return () => clearTimeout(id);
  }, [feedback, commitment]);

  async function submit() {
    const value = text.trim();
    if (!value || busy) return;

    setBusy(true);
    setText('');

    try {
      const conversation = commitment
        ? [
            ...commitment.conversation,
            { role: 'user' as const, content: value },
          ]
        : [];
      const { data } = await api.post<{
        spoken: string;
        applied: string[];
        skipped: string[];
        commitment?: OrganizedOutcome;
      }>('/capture', {
        text: value,
        source: 'web',
        ...(commitment
          ? {
              commitment: {
                outcome: commitment.outcome,
                conversation,
              },
            }
          : {}),
      });

      if (data.commitment) {
        const nextConversation = data.commitment.clarifyingQuestion
          ? [
              ...conversation,
              {
                role: 'assistant' as const,
                content: data.commitment.clarifyingQuestion,
              },
            ]
          : conversation;
        setCommitment({
          outcome: commitment?.outcome ?? value,
          conversation: nextConversation,
          proposal: data.commitment,
        });
      }

      setFeedback({
        tone: data.skipped.length > 0 ? 'warn' : 'info',
        text: [
          data.commitment ? commitmentSummary(data.commitment) : data.spoken,
          ...data.skipped,
        ].filter(Boolean).join(' · '),
      });
      onApplied();
    } catch (err) {
      // Network failure — queue it. A validation failure is a real rejection
      // and should be shown, not retried forever.
      if (
        !commitment &&
        err instanceof ApiError &&
        (err.status === 0 || err.status >= 500)
      ) {
        await enqueueCapture(value);
        setPending(await queueDepth());
        setFeedback({
          tone: 'warn',
          text: 'Offline — l’ho messo in coda e lo invio appena torna la linea.',
        });
      } else {
        setFeedback({
          tone: 'error',
          text: err instanceof ApiError ? err.message : 'Errore imprevisto.',
        });
        setText(value);
      }
    } finally {
      setBusy(false);
    }
  }

  async function commitProposal() {
    if (!commitment || commitment.proposal.blockingVerificationRequired || busy) return;
    setBusy(true);
    try {
      const { data } = await api.post<AgentCommitResult>('/agents/commit', {
        sourceRequestId: commitment.proposal.trace.request.requestId,
      });
      setFeedback({ tone: 'info', text: data.confirmation });
      setCommitment(null);
      onApplied();
    } catch (err) {
      setFeedback({
        tone: 'error',
        text: err instanceof ApiError ? err.message : 'Non sono riuscita a pianificarlo.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {(feedback || pending > 0) && (
        <div
          className="capture"
          style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 128px)' }}
        >
          <div
            className="banner"
            data-tone={feedback?.tone ?? 'warn'}
            style={{ flex: 1, margin: 0 }}
            role="status"
          >
            {feedback?.text ??
              `${pending} ${pending === 1 ? 'nota' : 'note'} in attesa di connessione.`}
            {commitment && !commitment.proposal.blockingVerificationRequired && (
              <button
                className="btn"
                data-variant="primary"
                disabled={busy}
                onClick={() => void commitProposal()}
                style={{ marginLeft: '0.75rem' }}
              >
                {busy ? 'Pianifico…' : 'Inserisci e pianifica'}
              </button>
            )}
            {commitment && (
              <button
                className="btn"
                disabled={busy}
                onClick={() => {
                  setCommitment(null);
                  setFeedback(null);
                  setText('');
                }}
                style={{ marginLeft: '0.5rem' }}
              >
                Annulla
              </button>
            )}
          </div>
        </div>
      )}

      <div className="capture">
        <input
          ref={inputRef}
          value={text}
          placeholder={
            commitment?.proposal.blockingVerificationRequired
              ? 'Rispondi a Dani…'
              : commitment
                ? 'Conferma o annulla la proposta'
                : 'Detta o scrivi…'
          }
          disabled={Boolean(commitment && !commitment.proposal.blockingVerificationRequired)}
          enterKeyHint="send"
          autoCapitalize="sentences"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
        />
        <button
          onClick={() => void submit()}
          disabled={
            busy ||
            !text.trim() ||
            Boolean(commitment && !commitment.proposal.blockingVerificationRequired)
          }
        >
          {busy ? '…' : 'Invia'}
        </button>
      </div>
    </>
  );
}
