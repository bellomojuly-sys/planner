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

interface IntegrationCheck {
  service: string;
  state: 'ok' | 'missing' | 'error';
  detail: string;
}

const LABELS: Record<string, string> = {
  voice: 'DeepSeek — voce',
  notion: 'Notion — attività',
  google: 'Google Calendar — turni e lezioni',
  push: 'Notifiche',
};

export function Settings({ onChanged }: { onChanged: () => void }) {
  const [checks, setChecks] = useState<IntegrationCheck[]>([]);
  const [checking, setChecking] = useState(false);
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
          {Object.entries(data.integrations).map(([name, present]) => {
            // A live probe, when one has been run, always beats the mere
            // presence of a secret: a wrong key looks identical to a right one
            // until something actually calls the service.
            const probe = checks.find((c) => c.service === name);
            const state = probe?.state ?? (present ? 'ok' : 'missing');

            return (
              <li key={name}>
                <div className="list__main">
                  <div className="list__title">{LABELS[name] ?? name}</div>
                  <div className="list__meta">
                    {probe
                      ? probe.detail
                      : present
                        ? 'Secret presente — non ancora verificata'
                        : 'Non configurata'}
                  </div>
                </div>
                <span className="chip">
                  {state === 'ok' ? '\u2713' : state === 'error' ? '\u26a0' : '\u2014'}
                </span>
              </li>
            );
          })}
        </ul>

        <button
          className="btn"
          disabled={checking}
          onClick={async () => {
            setChecking(true);
            try {
              const { data: result } = await api.get<{ checks: IntegrationCheck[] }>(
                '/settings/integrations/check',
              );
              setChecks(result.checks);
              const broken = result.checks.filter((c) => c.state !== 'ok');
              setStatus(
                broken.length === 0
                  ? { tone: 'info', text: 'Tutte le integrazioni rispondono.' }
                  : {
                      tone: 'warn',
                      text: `${broken.length} da sistemare: ${broken
                        .map((c) => LABELS[c.service] ?? c.service)
                        .join(', ')}.`,
                    },
              );
            } catch (err) {
              setStatus({
                tone: 'error',
                text: err instanceof ApiError ? err.message : 'Errore.',
              });
            } finally {
              setChecking(false);
            }
          }}
        >
          {checking ? 'Verifico\u2026' : 'Verifica connessioni'}
        </button>

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
        <h2>Calendari</h2>
        <p className="list__meta">
          Gli impegni fissi bloccano il tempo; i calendari di contesto restano
          visibili senza togliere spazio alle attività. Un solo calendario riceve
          i blocchi creati dal planner. I calendari a cui sei iscritta (turni
          eitje, scadenze università) si aggiungono con il loro indirizzo iCal:
          Google non permette di condividerli.
        </p>
        <GoogleCalendars
          calendars={data.calendars}
          onReload={load}
          onChanged={onChanged}
        />
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

      <VoiceTodayToken />
      <CaptureTokens />
    </>
  );
}

function VoiceTodayToken() {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endpoint = `${window.location.origin}/api/plan/today/voice`;

  return (
    <div className="card voice-card">
      <div className="voice-card__mark" aria-hidden="true">))</div>
      <h2>Siri · cosa devo fare oggi?</h2>
      <p className="list__meta">
        Di’ «Siri, cosa devo fare oggi». L’iPhone leggerà soltanto gli impegni
        e le attività ancora da fare oggi, in ordine di orario.
      </p>

      {error && (
        <div className="banner" data-tone="error" role="alert">
          {error}
        </div>
      )}

      {!token ? (
        <button
          className="btn"
          data-variant="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const { data } = await api.post<{ token: string }>('/auth/tokens', {
                name: `Siri piano di oggi ${new Date().toLocaleDateString('it-IT')}`,
                scope: 'read',
              });
              setToken(data.token);
            } catch (err) {
              setError(err instanceof ApiError ? err.message : 'Non sono riuscita a creare l’accesso Siri.');
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Preparo…' : 'Prepara il comando Siri'}
        </button>
      ) : (
        <div className="voice-setup">
          <div className="banner" data-tone="warn">
            <strong>Token da copiare una sola volta</strong>
            <code>{token}</code>
            <button
              className="btn"
              onClick={async () => {
                await navigator.clipboard.writeText(token);
                setCopied(true);
              }}
            >
              {copied ? 'Copiato' : 'Copia token'}
            </button>
          </div>

          <ol className="voice-steps">
            <li>
              Apri <strong>Comandi</strong>, premi <strong>+</strong> e chiamalo
              <strong> Cosa devo fare oggi</strong>.
            </li>
            <li>
              Aggiungi <strong>Ottieni contenuto dell’URL</strong> con metodo GET e URL
              <code>{endpoint}</code>.
            </li>
            <li>
              Nelle intestazioni aggiungi <strong>Authorization</strong> con valore
              <code>Bearer {token}</code>.
            </li>
            <li>
              Aggiungi <strong>Pronuncia testo</strong> usando il risultato del passaggio
              precedente.
            </li>
          </ol>
          <p className="voice-card__ready">
            Fatto: da quel momento basta dire «Siri, cosa devo fare oggi?».
          </p>
        </div>
      )}
    </div>
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
              <option value="career">Carriera / ICT</option>
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

const CALENDAR_ROLE_LABELS = {
  busy: 'Impegno fisso',
  context: 'Solo contesto',
  ignore: 'Ignora',
  planner: 'Destinazione planner',
} as const;

/**
 * A subscribed calendar is registered by URL rather than discovered: Google
 * refuses to share those, so Planner reads the feed itself. The address never
 * comes back from the server, only its host.
 */
function AddIcsCalendar({
  onAdded,
  onChanged,
}: {
  onAdded: () => Promise<void>;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<'busy' | 'context'>('busy');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button className="btn" onClick={() => setOpen(true)}>
        Aggiungi calendario iscritto
      </button>
    );
  }

  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api.post('/settings/calendars/ics', { url, name, role });
          setUrl('');
          setName('');
          setOpen(false);
          await onAdded();
          onChanged();
        } catch (err) {
          setError(err instanceof ApiError ? err.message : 'Calendario non aggiunto.');
        } finally {
          setBusy(false);
        }
      }}
    >
      {error && (
        <div className="banner" data-tone="error">
          {error}
        </div>
      )}
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Nome (es. Turni eitje)"
        required
      />
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="Indirizzo iCal (https://…)"
        type="url"
        required
      />
      <select value={role} onChange={(e) => setRole(e.target.value as 'busy' | 'context')}>
        <option value="busy">Impegno fisso — blocca il tempo</option>
        <option value="context">Contesto — solo visibile (scadenze)</option>
      </select>
      <p className="list__meta">
        L’indirizzo vale come una password: chi ce l’ha legge il calendario.
        Resta sul server, l’app non lo mostra più.
      </p>
      <div className="row">
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Aggiungo…' : 'Aggiungi'}
        </button>
        <button className="btn" type="button" onClick={() => setOpen(false)}>
          Annulla
        </button>
      </div>
    </form>
  );
}

function GoogleCalendars({
  calendars,
  onReload,
  onChanged,
}: {
  calendars: SettingsView['calendars'];
  onReload: () => Promise<void>;
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function patchCalendar(
    id: string,
    patch: { role?: keyof typeof CALENDAR_ROLE_LABELS; enabled?: boolean },
  ) {
    setBusyId(id);
    setError(null);
    try {
      await api.patch(`/settings/google/calendars/${id}`, patch);
      await onReload();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Errore nel calendario.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      {error && (
        <div className="banner" data-tone="error">
          {error}
        </div>
      )}

      {calendars.length === 0 ? (
        <p className="list__meta">
          Nessun calendario ancora rilevato. Il planner continuerà a usare il
          calendario principale finché non completi questo passaggio.
        </p>
      ) : (
        <ul className="list calendar-sources">
          {calendars.map((calendar) => {
            const writable =
              calendar.accessRole === 'writer' || calendar.accessRole === 'owner';
            return (
              <li key={calendar.id}>
                <span
                  className="calendar-source__color"
                  style={{ backgroundColor: calendar.color }}
                  aria-hidden="true"
                />
                <div className="list__main">
                  <div className="list__title">
                    {calendar.summary}
                    {calendar.kind === 'ics' && (
                      <span className="block__badge">iscritto</span>
                    )}
                    {calendar.primary && <span className="block__badge">principale</span>}
                  </div>
                  <div className="list__meta">
                    {writable ? 'scrivibile' : 'sola lettura'}
                    {!calendar.enabled && ' · disattivato'}
                  </div>
                </div>
                <select
                  className="calendar-source__role"
                  aria-label={`Ruolo di ${calendar.summary}`}
                  value={calendar.role}
                  disabled={busyId !== null}
                  onChange={(event) =>
                    void patchCalendar(calendar.id, {
                      role: event.target.value as keyof typeof CALENDAR_ROLE_LABELS,
                    })
                  }
                >
                  {Object.entries(CALENDAR_ROLE_LABELS).map(([value, label]) => (
                    <option
                      key={value}
                      value={value}
                      disabled={value === 'planner' && !writable}
                    >
                      {label}
                    </option>
                  ))}
                </select>
                <button
                  className="btn"
                  data-variant="quiet"
                  disabled={busyId !== null || calendar.role === 'planner'}
                  onClick={() =>
                    void patchCalendar(calendar.id, { enabled: !calendar.enabled })
                  }
                >
                  {calendar.enabled ? 'Disattiva' : 'Attiva'}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <AddIcsCalendar onAdded={onReload} onChanged={onChanged} />

      <button
        className="btn"
        disabled={busyId !== null}
        onClick={async () => {
          setBusyId('discover');
          setError(null);
          try {
            await api.post('/settings/google/calendars/discover');
            await onReload();
          } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Errore Google Calendar.');
          } finally {
            setBusyId(null);
          }
        }}
      >
        {busyId === 'discover' ? 'Cerco…' : 'Rileva o aggiorna calendari'}
      </button>
    </>
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
      <h2>Dettatura · aggiungi attività</h2>
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
