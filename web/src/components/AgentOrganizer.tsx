import { useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type AgentCommitResult,
  type AgentRegistryView,
  type OrganizedOutcome,
} from '../lib/api';

export function AgentOrganizer({ onCommitted }: { onCommitted: () => void }) {
  const [registry, setRegistry] = useState<AgentRegistryView | null>(null);
  const [domain, setDomain] = useState<'auto' | 'university' | 'work' | 'personal'>('auto');
  const [outcome, setOutcome] = useState('');
  const [constraints, setConstraints] = useState('');
  const [draft, setDraft] = useState<OrganizedOutcome | null>(null);
  const [conversation, setConversation] = useState<Array<{
    role: 'assistant' | 'user';
    content: string;
  }>>([]);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void api.get<AgentRegistryView>('/agents').then(({ data }) => setRegistry(data));
  }, []);

  async function requestProposal(
    messages: Array<{ role: 'assistant' | 'user'; content: string }>,
  ) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { data } = await api.post<OrganizedOutcome>('/agents/organize', {
        outcome,
        domain,
        constraints: constraints || undefined,
        conversation: messages,
        maxTasks: 8,
      });
      setDraft(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Non sono riuscita a organizzarlo.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card agent-organizer">
      <div className="agent-organizer__heading">
        <div>
          <h2>Organizza con Dani</h2>
          <p className="list__meta">
            Il Supervisor passa l’outcome all’agente giusto. Il planner globale decide poi dove collocare le attività.
          </p>
        </div>
        {registry && (
          <span className="chip">
            {registry.agents.filter((agent) => agent.runtimeStatus === 'ready').length} pronti ·{' '}
            {registry.agents.length} registrati
          </span>
        )}
      </div>

      <label className="field">
        <span>Contesto</span>
        <select value={domain} onChange={(event) => setDomain(event.target.value as typeof domain)}>
          <option value="auto">Automatico</option>
          <option value="university">Università</option>
          <option value="work">Lavoro — Heemia e MG/DMG</option>
          <option value="personal">Personale</option>
        </select>
      </label>

      <label className="field">
        <span>Risultato che vuoi ottenere</span>
        <textarea
          rows={3}
          value={outcome}
          placeholder="Es. preparare il portfolio Dani per il prossimo feedback"
          onChange={(event) => setOutcome(event.target.value)}
        />
      </label>

      <label className="field">
        <span>Vincoli o scadenze, se servono</span>
        <input
          value={constraints}
          placeholder="Es. deve essere pronto venerdì; massimo due ore oggi"
          onChange={(event) => setConstraints(event.target.value)}
        />
      </label>

      {error && <div className="banner" data-tone="error">{error}</div>}
      {notice && <div className="banner" data-tone="info">{notice}</div>}

      {!draft && (
              <button
          className="btn"
          data-variant="primary"
          disabled={busy || outcome.trim().length < 3}
          onClick={() => void requestProposal(conversation)}
        >
          {busy ? 'Gli agenti stanno organizzando…' : 'Proponi le attività'}
        </button>
      )}

      {draft && (
        <div className="agent-proposal">
          <p>{draft.summary}</p>
          {draft.unknowns.length > 0 && (
            <div className="banner" data-tone="info">
              <strong>Da chiarire:</strong> {draft.unknowns.join(' · ')}
            </div>
          )}
          {draft.assumptions.length > 0 && (
            <div className="banner" data-tone="info">
              <strong>Assunzioni:</strong> {draft.assumptions.join(' · ')}
            </div>
          )}
          {draft.verificationRequired.length > 0 && (
            <div className="banner" data-tone="info">
              <strong>Verifiche richieste prima di inserire:</strong>{' '}
              {draft.verificationRequired.join(' · ')}
            </div>
          )}
          {draft.sourceGaps.length > 0 && (
            <div className="banner" data-tone="info">
              <strong>Limiti delle fonti disponibili:</strong>{' '}
              {draft.sourceGaps.join(' · ')}
            </div>
          )}
          {draft.blockingVerificationRequired && draft.clarifyingQuestion && (
            <div className="agent-conversation">
              {conversation.map((message, index) => (
                <p key={`${message.role}-${index}`} data-role={message.role}>
                  <strong>{message.role === 'assistant' ? 'Dani' : 'Tu'}:</strong>{' '}
                  {message.content}
                </p>
              ))}
              <p data-role="assistant">
                <strong>Dani:</strong> {draft.clarifyingQuestion}
              </p>
              <div className="row">
                <input
                  value={reply}
                  placeholder="Rispondi a Dani"
                  onChange={(event) => setReply(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' || !reply.trim() || busy) return;
                    event.preventDefault();
                    const next = [
                      ...conversation,
                      { role: 'assistant' as const, content: draft.clarifyingQuestion! },
                      { role: 'user' as const, content: reply.trim() },
                    ];
                    setConversation(next);
                    setReply('');
                    void requestProposal(next);
                  }}
                />
                <button
                  className="btn"
                  data-variant="primary"
                  disabled={busy || !reply.trim()}
                  onClick={() => {
                    const next = [
                      ...conversation,
                      { role: 'assistant' as const, content: draft.clarifyingQuestion! },
                      { role: 'user' as const, content: reply.trim() },
                    ];
                    setConversation(next);
                    setReply('');
                    void requestProposal(next);
                  }}
                >
                  {busy ? 'Capisco…' : 'Rispondi'}
                </button>
              </div>
            </div>
          )}
          <details>
            <summary>Come Dani ha costruito la proposta</summary>
            <ol>
              {draft.trace.steps.map((step) => (
                <li key={`${step.agentId}-${step.operation}`}>
                  <strong>{step.agentId}</strong>
                  <span>{step.detail}</span>
                </li>
              ))}
            </ol>
            {draft.evidenceRefs.length > 0 && (
              <small>Riferimenti usati: {draft.evidenceRefs.join(' · ')}</small>
            )}
          </details>
          <ol>
            {draft.proposals.map((proposal, index) => (
              <li key={`${proposal.title}-${index}`}>
                <strong>{proposal.title}</strong>
                <span>
                  {proposal.estimatedMinutes} min · P{proposal.priority} · {proposal.area}
                  {proposal.dueDate && ` · entro ${proposal.dueDate}`}
                  {proposal.fixedStartAt &&
                    ` · ${new Date(proposal.fixedStartAt).toLocaleString('it-IT', {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}`}
                  {proposal.location && ` · ${proposal.location}`}
                </span>
                {(proposal.preparationMinutes > 0 || proposal.travelMinutes > 0) && (
                  <small>
                    {proposal.preparationMinutes > 0 &&
                      `Preparazione ${proposal.preparationMinutes} min`}
                    {proposal.preparationMinutes > 0 && proposal.travelMinutes > 0 && ' · '}
                    {proposal.travelMinutes > 0 && `Viaggio ${proposal.travelMinutes} min`}
                  </small>
                )}
                {proposal.evidence && <small>Fatto quando: {proposal.evidence}</small>}
              </li>
            ))}
          </ol>
          <div className="row">
            <button
              className="btn"
              data-variant="quiet"
              disabled={busy}
              onClick={() => {
                setDraft(null);
                setConversation([]);
                setReply('');
              }}
            >
              Modifica richiesta
            </button>
            <button
              className="btn"
              data-variant="primary"
                disabled={busy || draft.blockingVerificationRequired}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const { data } = await api.post<AgentCommitResult>('/agents/commit', {
                    sourceRequestId: draft.trace.request.requestId,
                  });
                  setNotice(data.confirmation);
                  setDraft(null);
                  setOutcome('');
                  setConstraints('');
                  setConversation([]);
                  setReply('');
                  onCommitted();
                } catch (err) {
                  setError(err instanceof ApiError ? err.message : 'Non sono riuscita a inserirle.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy
                ? 'Pianifico…'
                : draft.blockingVerificationRequired
                  ? 'Chiarisci prima di inserire'
                  : 'Inserisci e pianifica'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
