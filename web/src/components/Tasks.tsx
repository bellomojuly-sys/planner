import { useEffect, useState } from 'react';
import { api, ApiError, type TaskView } from '../lib/api';
import { AREA_LABELS, ENERGY_LABELS, dayShort, duration } from '../lib/format';

export function Tasks({ onChanged }: { onChanged: () => void }) {
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('open');
  const [showForm, setShowForm] = useState(false);

  async function load() {
    try {
      const { data } = await api.get<{ tasks: TaskView[] }>('/tasks');
      setTasks(data.tasks);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Errore di caricamento.');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const visible = tasks.filter((t) =>
    filter === 'open' ? t.status !== 'done' : filter === 'done' ? t.status === 'done' : true,
  );

  return (
    <>
      {error && (
        <div className="banner" data-tone="error" role="alert">
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
        {(['open', 'done', 'all'] as const).map((f) => (
          <button
            key={f}
            className="btn"
            data-variant={filter === f ? 'primary' : 'quiet'}
            onClick={() => setFilter(f)}
          >
            {f === 'open' ? 'Da fare' : f === 'done' ? 'Fatte' : 'Tutte'}
          </button>
        ))}
        <button
          className="btn"
          style={{ marginLeft: 'auto' }}
          onClick={() => setShowForm((v) => !v)}
        >
          {showForm ? 'Chiudi' : 'Nuova'}
        </button>
      </div>

      {showForm && (
        <NewTaskForm
          onCreated={async () => {
            setShowForm(false);
            await load();
            onChanged();
          }}
        />
      )}

      {visible.length === 0 && <div className="empty">Nessuna attività.</div>}

      <ul className="list">
        {visible.map((task) => (
          <li key={task.id}>
            <button
              className="check"
              aria-pressed={task.status === 'done'}
              aria-label="Segna come completata"
              onClick={async () => {
                await api.patch(`/tasks/${task.id}`, {
                  status: task.status === 'done' ? 'todo' : 'done',
                });
                await load();
                onChanged();
              }}
            >
              {task.status === 'done' ? '✓' : ''}
            </button>

            <div className="list__main">
              <div className="list__title" data-done={task.status === 'done'}>
                {task.title}
              </div>
              <div className="list__meta">
                {AREA_LABELS[task.area] ?? task.area} · {duration(task.plannedMinutes)}
                {task.plannedMinutes !== task.estimatedMinutes && (
                  <span title="Corretto in base ai tempi reali registrati">
                    {' '}
                    (stima {duration(task.estimatedMinutes)})
                  </span>
                )}
                {' · '}
                energia {ENERGY_LABELS[task.energy]}
                {task.dueAt && ` · entro ${dayShort(task.dueAt)}`}
                {task.actualMinutes && ` · reali ${duration(task.actualMinutes)}`}
              </div>
            </div>

            <span className="chip">P{task.priority}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function NewTaskForm({ onCreated }: { onCreated: () => void }) {
  const [draft, setDraft] = useState({
    title: '',
    area: 'general',
    energy: 'medium',
    priority: 3,
    estimatedMinutes: 30,
    dueAt: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="card">
      <h2>Nuova attività</h2>

      <label className="field">
        <span>Titolo</span>
        <input
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        />
      </label>

      <div className="row">
        <label className="field">
          <span>Area</span>
          <select
            value={draft.area}
            onChange={(e) => setDraft({ ...draft, area: e.target.value })}
          >
            {Object.entries(AREA_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Energia</span>
          <select
            value={draft.energy}
            onChange={(e) => setDraft({ ...draft, energy: e.target.value })}
          >
            {Object.entries(ENERGY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="row">
        <label className="field">
          <span>Priorità (1 = massima)</span>
          <input
            type="number"
            min={1}
            max={4}
            value={draft.priority}
            onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })}
          />
        </label>

        <label className="field">
          <span>Durata stimata (min)</span>
          <input
            type="number"
            min={5}
            max={600}
            step={5}
            value={draft.estimatedMinutes}
            onChange={(e) =>
              setDraft({ ...draft, estimatedMinutes: Number(e.target.value) })
            }
          />
        </label>
      </div>

      <label className="field">
        <span>Scadenza</span>
        <input
          type="date"
          value={draft.dueAt}
          onChange={(e) => setDraft({ ...draft, dueAt: e.target.value })}
        />
      </label>

      {error && (
        <div className="banner" data-tone="error">
          {error}
        </div>
      )}

      <button
        className="btn"
        data-variant="primary"
        disabled={busy || !draft.title.trim()}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await api.post('/tasks', {
              ...draft,
              // A date without a time means "by the end of that working day".
              dueAt: draft.dueAt ? new Date(`${draft.dueAt}T18:00:00`).getTime() : null,
            });
            onCreated();
          } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Errore.');
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Pianifico…' : 'Crea e pianifica'}
      </button>
    </div>
  );
}
