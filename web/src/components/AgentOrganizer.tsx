import { useEffect, useState } from 'react';
import { api, ApiError, type AgentRegistryView, type OrganizedOutcome } from '../lib/api';

export function AgentOrganizer({ onCommitted }: { onCommitted: () => void }) {
  const [registry, setRegistry] = useState<AgentRegistryView | null>(null);
  const [domain, setDomain] = useState<'auto' | 'university' | 'work' | 'personal'>('auto');
  const [outcome, setOutcome] = useState('');
  const [constraints, setConstraints] = useState('');
  const [draft, setDraft] = useState<OrganizedOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void api.get<AgentRegistryView>('/agents').then(({ data }) => setRegistry(data));
  }, []);

  return (
    <div className="card agent-organizer">
      <div className="agent-organizer__heading">
        <div>
          <h2>Organizza con Dani</h2>
          <p className="list__meta">
            Il Supervisor passa l’outcome all’agente giusto. Il planner globale decide poi dove collocare le attività.
          </p>
        </div>
        {registry && <span className="chip">{registry.agents.length} agenti attivi</span>}
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
          onClick={async () => {
            setBusy(true);
            setError(null);
            setNotice(null);
            try {
              const { data } = await api.post<OrganizedOutcome>('/agents/organize', {
                outcome,
                domain,
                constraints: constraints || undefined,
                maxTasks: 8,
              });
              setDraft(data);
            } catch (err) {
              setError(err instanceof ApiError ? err.message : 'Non sono riuscita a organizzarlo.');
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Gli agenti stanno organizzando…' : 'Proponi le attività'}
        </button>
      )}

      {draft && (
        <div className="agent-proposal">
          <p>{draft.summary}</p>
          <ol>
            {draft.proposals.map((proposal, index) => (
              <li key={`${proposal.title}-${index}`}>
                <strong>{proposal.title}</strong>
                <span>
                  {proposal.estimatedMinutes} min · P{proposal.priority} · {proposal.area}
                  {proposal.dueDate && ` · entro ${proposal.dueDate}`}
                </span>
                {proposal.evidence && <small>Fatto quando: {proposal.evidence}</small>}
              </li>
            ))}
          </ol>
          <div className="row">
            <button className="btn" data-variant="quiet" disabled={busy} onClick={() => setDraft(null)}>
              Modifica richiesta
            </button>
            <button
              className="btn"
              data-variant="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await api.post('/agents/commit', {
                    domainAgent: draft.domainAgent,
                    summary: draft.summary,
                    proposals: draft.proposals,
                  });
                  setNotice(`${draft.proposals.length} attività inserite e passate al planner.`);
                  setDraft(null);
                  setOutcome('');
                  setConstraints('');
                  onCommitted();
                } catch (err) {
                  setError(err instanceof ApiError ? err.message : 'Non sono riuscita a inserirle.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Pianifico…' : 'Inserisci e pianifica'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
