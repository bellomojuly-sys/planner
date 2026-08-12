import { useEffect, useState } from 'react';
import { api, ApiError, type SettingsView } from '../lib/api';

const NUMERIC_FIELDS: Array<{ key: string; label: string; hint?: string }> = [
  { key: 'dayStartMinutes', label: 'Inizio giornata', hint: 'minuti da mezzanotte' },
  { key: 'dayEndMinutes', label: 'Fine giornata' },
  { key: 'morningEndMinutes', label: 'Fine mattina (lavoro impegnativo prima)' },
  { key: 'afternoonEndMinutes', label: 'Fine pomeriggio (lavoro medio prima)' },
  { key: 'minBlockMinutes', label: 'Blocco minimo (min)' },
  { key: 'maxBlockMinutes', label: 'Blocco massimo (min)' },
  { key: 'breakMinutes', label: 'Pausa fra blocchi (min)' },
  { key: 'bufferAroundEventsMinutes', label: 'Margine attorno agli impegni fissi (min)' },
  { key: 'gymSessionsPerWeek', label: 'Palestra a settimana' },
  { key: 'gymDurationMinutes', label: 'Durata palestra (min)' },
  { key: 'briefingMinutes', label: 'Ora del briefing' },
  { key: 'reviewMinutes', label: 'Ora della revisione' },
  { key: 'reviewAfterShiftMinutes', label: 'Minuti dopo il turno per la revisione' },
  { key: 'planningHorizonDays', label: 'Giorni pianificati in avanti' },
];

function minutesToTime(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

export function Settings({ onChanged }: { onChanged: () => void }) {
  const [data, setData] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<Record<string, number | string | boolean>>({});
  const [status, setStatus] = useState<{ tone: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const { data: response } = await api.get<SettingsView>('/settings');
      setData(response);
      setDraft(response.settings);
    } catch (err) {
      setStatus({
        tone: 'error',
        text: err instanceof ApiError ? err.message : 'Errore di caricamento.',
      });
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (!data) return <div className="empty">Carico…</div>;

  const dirty = Object.keys(draft).some((k) => draft[k] !== data.settings[k]);

  async function save() {
    setBusy(true);
    try {
      // Only changed keys are sent, so a concurrent change elsewhere is not
      // clobbered by echoing back the whole object.
      const changed = Object.fromEntries(
        Object.entries(draft).filter(([k, v]) => v !== data!.settings[k]),
      );
      await api.patch('/settings', changed);
      setStatus({ tone: 'info', text: 'Salvato e ripianificato.' });
      await load();
      onChanged();
    } catch (err) {
      setStatus({
        tone: 'error',
        text: err instanceof ApiError ? err.message : 'Errore nel salvataggio.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {status && (
        <div className="banner" data-tone={status.tone} role="status">
          {status.text}
        </div>
      )}

      <div className="card">
        <h2>Integrazioni</h2>
        <ul className="list">
          {Object.entries(data.integrations).map(([name, ok]) => (
            <li key={name}>
              <div className="list__main">
                <div className="list__title">{name}</div>
                <div className="list__meta">
                  {ok ? 'Collegata' : 'Non configurata — imposta il secret nel Worker'}
                </div>
              </div>
              <span className="chip">{ok ? '✓' : '—'}</span>
            </li>
          ))}
        </ul>
        <button
          className="btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.post('/settings/sync');
              setStatus({ tone: 'info', text: 'Sincronizzato.' });
              onChanged();
            } catch (err) {
              setStatus({
                tone: 'error',
                text: err instanceof ApiError ? err.message : 'Errore.',
              });
            } finally {
              setBusy(false);
            }
          }}
        >
          Sincronizza adesso
        </button>
      </div>

      <div className="card">
        <h2>Database Notion</h2>
        {data.sources.length === 0 && (
          <p className="list__meta">
            Nessun database collegato. Aggiungi General Tasks e MG Integration qui sotto.
          </p>
        )}
        <ul className="list">
          {data.sources.map((source) => (
            <li key={source.id}>
              <div className="list__main">
                <div className="list__title">{source.name}</div>
                <div className="list__meta">
                  {source.area}
                  {source.lastSyncedAt
                    ? ` · sincronizzato ${new Date(source.lastSyncedAt).toLocaleString('it-IT')}`
                    : ' · mai sincronizzato'}
                  {source.lastSyncError && ` · ⚠ ${source.lastSyncError}`}
                </div>
              </div>
              <span className="chip">{source.enabled ? 'attivo' : 'disattivo'}</span>
            </li>
          ))}
        </ul>
        <AddSource onAdded={load} />
      </div>

      <div className="card">
        <h2>Notifiche</h2>
        <PushToggle />
      </div>

      <div className="card">
        <h2>Pianificazione</h2>
        {NUMERIC_FIELDS.map((field) => {
          const value = Number(draft[field.key] ?? 0);
          const isTime = field.key.endsWith('Minutes') && value > 300 && value < 1440;

          return (
            <label className="field" key={field.key}>
              <span>
                {field.label}
                {isTime && ` — ${minutesToTime(value)}`}
                {field.hint && ` (${field.hint})`}
              </span>
              <input
                type="number"
                value={value}
                onChange={(e) =>
                  setDraft({ ...draft, [field.key]: Number(e.target.value) })
                }
              />
            </label>
          );
        })}

        <label className="field">
          <span>Giorni palestra (1 = lunedì … 7 = domenica)</span>
          <input
            value={String(draft.gymPreferredDays ?? '')}
            onChange={(e) => setDraft({ ...draft, gymPreferredDays: e.target.value })}
          />
        </label>

        <label className="field">
          <span>Parole che identificano gli impegni fissi</span>
          <input
            value={String(draft.fixedEventKeywords ?? '')}
            onChange={(e) => setDraft({ ...draft, fixedEventKeywords: e.target.value })}
          />
        </label>

        <button
          className="btn"
          data-variant="primary"
          disabled={!dirty || busy}
          onClick={() => void save()}
        >
          {busy ? 'Salvo…' : 'Salva e ripianifica'}
        </button>
      </div>

      <div className="card">
        <h2>Precisione delle stime</h2>
        {data.accuracy.samples < 3 ? (
          <p className="list__meta">
            Servono almeno qualche attività completata prima di poter correggere le stime.
          </p>
        ) : (
          <p className="list__meta">
            Su {data.accuracy.samples} attività completate, il tempo reale è in media{' '}
            <strong>{data.accuracy.meanRatio.toFixed(2)}×</strong> quello stimato.{' '}
            {Math.round(data.accuracy.withinTolerance * 100)}% delle stime cade entro il 25%.
          </p>
        )}
      </div>

      <CaptureTokens />
    </>
  );
}

function AddSource({ onAdded }: { onAdded: () => void }) {
  const [databases, setDatabases] = useState<Array<{ id: string; title: string }>>([]);
  const [selected, setSelected] = useState('');
  const [area, setArea] = useState('general');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div style={{ marginTop: 12 }}>
      <button
        className="btn"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const { data } = await api.get<{ databases: Array<{ id: string; title: string }> }>(
              '/settings/notion/databases',
            );
            setDatabases(data.databases);
          } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Errore.');
          } finally {
            setBusy(false);
          }
        }}
      >
        Cerca database Notion
      </button>

      {error && (
        <div className="banner" data-tone="error">
          {error}
        </div>
      )}

      {databases.length > 0 && (
        <>
          <label className="field">
            <span>Database</span>
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              <option value="">Scegli…</option>
              {databases.map((db) => (
                <option key={db.id} value={db.id}>
                  {db.title}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Area</span>
            <select value={area} onChange={(e) => setArea(e.target.value)}>
              <option value="general">Generale</option>
              <option value="mg">MG Integration</option>
              <option value="university">Università</option>
              <option value="heemia">Heemia</option>
              <option value="personal">Personale</option>
            </select>
          </label>

          <button
            className="btn"
            data-variant="primary"
            disabled={!selected || busy}
            onClick={async () => {
              setBusy(true);
              try {
                const db = databases.find((d) => d.id === selected)!;
                await api.post('/settings/sources', {
                  externalId: db.id,
                  name: db.title,
                  area,
                });
                setDatabases([]);
                setSelected('');
                onAdded();
              } catch (err) {
                setError(err instanceof ApiError ? err.message : 'Errore.');
              } finally {
                setBusy(false);
              }
            }}
          >
            Collega
          </button>
        </>
      )}
    </div>
  );
}

function PushToggle() {
  const [state, setState] = useState<'unknown' | 'on' | 'off' | 'unsupported'>('unknown');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) {
      setState('unsupported');
      return;
    }
    void navigator.serviceWorker.ready.then(async (reg) => {
      const sub = await reg.pushManager.getSubscription();
      setState(sub ? 'on' : 'off');
    });
  }, []);

  if (state === 'unsupported') {
    return (
      <p className="list__meta">
        Questo browser non supporta le notifiche. Su iPhone aggiungi prima l’app alla schermata
        Home.
      </p>
    );
  }

  return (
    <>
      {error && (
        <div className="banner" data-tone="error">
          {error}
        </div>
      )}
      <p className="list__meta">
        Briefing alle 07:00 e revisione la sera. Su iOS servono l’installazione dalla schermata
        Home e il permesso notifiche.
      </p>
      <button
        className="btn"
        data-variant={state === 'on' ? 'quiet' : 'primary'}
        onClick={async () => {
          setError(null);
          try {
            const registration = await navigator.serviceWorker.ready;

            if (state === 'on') {
              const sub = await registration.pushManager.getSubscription();
              if (sub) {
                await api.post('/settings/push/unsubscribe', { endpoint: sub.endpoint });
                await sub.unsubscribe();
              }
              setState('off');
              return;
            }

            const permission = await Notification.requestPermission();
            if (permission !== 'granted') {
              setError('Permesso negato.');
              return;
            }

            const { data } = await api.get<{ publicKey: string }>('/settings/push/key');
            const sub = await registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: data.publicKey,
            });

            await api.post('/settings/push/subscribe', sub.toJSON());
            setState('on');
          } catch (err) {
            setError(err instanceof ApiError ? err.message : String(err));
          }
        }}
      >
        {state === 'on' ? 'Disattiva notifiche' : 'Attiva notifiche'}
      </button>
    </>
  );
}

function CaptureTokens() {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="card">
      <h2>Tasto Azione iPhone</h2>
      <p className="list__meta">
        Genera un token per il Comando Rapido. Vale solo per registrare note vocali: non può
        leggere il piano né cambiare le impostazioni.
      </p>

      {token && (
        <div className="banner" data-tone="warn">
          Copialo adesso, non sarà più mostrato:
          <br />
          <code>{token}</code>
        </div>
      )}

      <button
        className="btn"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const { data } = await api.post<{ token: string }>('/auth/tokens', {
              name: `Tasto Azione ${new Date().toLocaleDateString('it-IT')}`,
              scope: 'capture',
            });
            setToken(data.token);
          } finally {
            setBusy(false);
          }
        }}
      >
        Genera token
      </button>
    </div>
  );
}
