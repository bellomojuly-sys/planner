import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type PlanResponse, type Block } from './lib/api';
import { Lock, Setup } from './components/Lock';
import { DayCalendar } from './components/DayCalendar';
import { EventSheet, type SheetTarget } from './components/EventSheet';
import { CaptureBar } from './components/CaptureBar';
import { Shopping } from './components/Shopping';
import { Tasks } from './components/Tasks';
import { Settings } from './components/Settings';
import {
  addDays,
  dayLong,
  dayShort,
  overlapsDay,
  sameDay,
  startOfDay,
} from './lib/format';
import { withoutTaskBlocks } from './lib/optimistic';

type View = 'day' | 'tasks' | 'shopping' | 'settings';
type AuthState = 'loading' | 'setup' | 'recover' | 'locked' | 'unlocked';

interface AuthStatus {
  configured: boolean;
  authenticated: boolean;
  pinSet?: boolean;
  email?: string;
  displayName?: string;
}

export function App() {
  const [auth, setAuth] = useState<AuthState>('loading');
  const [view, setView] = useState<View>('day');

  const [status, setStatus] = useState<AuthStatus | null>(null);

  useEffect(() => {
    void api
      .get<AuthStatus>('/auth/status')
      .then(({ data }) => {
        setStatus(data);
        setAuth(
          !data.configured
            ? 'setup'
            : // An account with no PIN has been through a reset; offer to set
              // a new one rather than a lock screen that cannot be opened.
              data.pinSet === false
              ? 'recover'
              : data.authenticated
                ? 'unlocked'
                : 'locked',
        );
      })
      .catch(() => setAuth('locked'));
  }, []);

  // Deep links from the manifest shortcuts and from notification clicks.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get('view');
    if (requested === 'shopping' || requested === 'tasks' || requested === 'settings') {
      setView(requested);
    }
  }, []);

  if (auth === 'loading') return <div className="empty">Carico…</div>;
  if (auth === 'setup') return <Setup onDone={() => setAuth('unlocked')} />;
  if (auth === 'recover')
    return (
      <Setup
        recovering
        presetEmail={status?.email}
        presetName={status?.displayName}
        onDone={() => setAuth('unlocked')}
      />
    );
  if (auth === 'locked') return <Lock onUnlocked={() => setAuth('unlocked')} />;

  return <Shell view={view} setView={setView} />;
}

function Shell({ view, setView }: { view: View; setView: (v: View) => void }) {
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [day, setDay] = useState(() => startOfDay(Date.now()));
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetTarget | null>(null);

  const loadPlan = useCallback(async () => {
    try {
      const { data, offline: fromCache } = await api.get<PlanResponse>('/plan?days=14');
      setPlan(data);
      setOffline(fromCache);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Errore di caricamento.');
    }
  }, []);

  useEffect(() => {
    void loadPlan();
  }, [loadPlan]);

  // Refresh when the app comes back to the foreground — the cron may have
  // rescheduled while it was in the background.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void loadPlan();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [loadPlan]);

  async function moveBlock(blockId: string, start: number, end: number) {
    // Optimistic move: the block follows the finger, and the server confirms.
    setPlan((p) =>
      p
        ? {
            ...p,
            blocks: p.blocks.map((b) =>
              b.id === blockId ? { ...b, start, end } : b,
            ),
          }
        : p,
    );

    try {
      const { data } = await api.patch<{ diff: { changes: string[]; moved: number } }>(
        `/plan/blocks/${blockId}`,
        { start, end },
      );

      const cascaded = Math.max(0, data.diff.moved - 1);
      setNotice(
        cascaded > 0
          ? `Spostato. ${cascaded} ${cascaded === 1 ? 'attività dipendente' : 'attività dipendenti'} riprogrammate.`
          : 'Spostato.',
      );
      await loadPlan();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Non sono riuscita a spostarlo.');
      await loadPlan();
    }
  }

  async function saveSheet(
    target: SheetTarget,
    patch: { title: string; start: number; end: number },
  ) {
    setError(null);
    try {
      if (target.type === 'block') {
        await api.patch(`/plan/blocks/${target.block.id}/details`, patch);
        setNotice('Salvato. Il blocco resta fisso a questo orario.');
      } else {
        await api.patch(`/plan/events/${target.event.id}`, patch);
        setNotice('Evento aggiornato anche in Google Calendar.');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Non sono riuscita a salvare.');
    }
    await loadPlan();
  }

  async function deleteSheet(target: SheetTarget) {
    setError(null);
    try {
      if (target.type === 'block') {
        const { data } = await api.del<{ outcome: string }>(`/plan/blocks/${target.block.id}`);
        setNotice(
          data.outcome === 'task_paused'
            ? 'Eliminato. L’attività resta aperta, fuori dal piano.'
            : 'Eliminato. Il piano non lo ricrea.',
        );
      } else {
        await api.del(`/plan/events/${target.event.id}`);
        setNotice('Evento eliminato anche da Google Calendar.');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Non sono riuscita a eliminarlo.');
    }
    await loadPlan();
  }

  async function completeBlock(block: Block) {
    if (!block.taskId || block.kind !== 'task') return;

    const taskId = block.taskId;
    setPlan((current) =>
      current
        ? { ...current, blocks: withoutTaskBlocks(current.blocks, taskId) }
        : current,
    );
    setError(null);
    setNotice('Completata. Sincronizzo Notion e calendario in background…');

    try {
      await api.post(`/plan/blocks/${block.id}/complete`);
      window.setTimeout(() => void loadPlan(), 1500);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Errore.');
      await loadPlan();
    }
  }

  async function confirmReplan() {
    try {
      const { data } = await api.post<{ diff: { applied: boolean } }>(
        '/plan/replan/confirm',
      );
      setNotice(data.diff.applied ? 'Replan confermato e applicato.' : 'Il piano non è cambiato.');
      await loadPlan();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Non sono riuscita ad applicare il replan.');
    }
  }

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(id);
  }, [notice]);

  const dayBlocks = plan?.blocks.filter((b) => sameDay(b.start, day)) ?? [];
  const dayEvents =
    plan?.events.filter((event) =>
      event.allDay
        ? overlapsDay(event.start, event.end, day)
        : sameDay(event.start, day),
    ) ?? [];
  const unplaced = plan?.lastRun?.summary?.unplaced ?? [];
  const decisionBriefing = plan?.lastRun?.summary?.briefing ?? [];
  const viewingToday = sameDay(day, startOfDay(Date.now()));
  const pendingConfirmation =
    plan?.lastRun?.status === 'pending_confirmation'
      ? plan.lastRun.summary
      : null;
  const staleData = plan?.lastRun?.status === 'blocked_stale_data';

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__row">
          <h1>
            {view === 'day'
              ? dayLong(day)
              : view === 'tasks'
                ? 'Attività'
                : view === 'shopping'
                  ? 'Spesa'
                  : 'Impostazioni'}
          </h1>
          {view === 'day' && (
            <button className="btn" data-variant="quiet" onClick={() => void loadPlan()}>
              Aggiorna
            </button>
          )}
        </div>

        {view === 'day' && plan && (
          <div className="daystrip">
            {Array.from({ length: 14 }, (_, i) => addDays(Date.now(), i)).map((ts) => (
              <button
                key={ts}
                aria-pressed={sameDay(ts, day)}
                onClick={() => setDay(startOfDay(ts))}
              >
                {dayShort(ts)}
              </button>
            ))}
          </div>
        )}
      </header>

      <main className="main">
        {offline && (
          <div className="banner" data-tone="warn">
            Offline — stai vedendo l’ultimo piano salvato.
          </div>
        )}
        {error && (
          <div className="banner" data-tone="error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="banner" data-tone="info" role="status">
            {notice}
          </div>
        )}
        {staleData && (
          <div className="banner" data-tone="warn" role="status">
            Il piano non è stato aggiornato: Notion o Google Calendar non sono
            sincronizzati. Stai vedendo l’ultimo piano valido.
          </div>
        )}
        {pendingConfirmation && (
          <div className="banner" data-tone="warn" role="alert">
            <div>
              Il nuovo piano richiede la tua conferma.{' '}
              {pendingConfirmation.confirmationReasons?.includes('permanent_task_conflict')
                ? 'Un task permanente è in conflitto con un impegno fisso. Puoi trascinarlo in un altro orario oppure lasciarlo da ricollocare. '
                : ''}
              {pendingConfirmation.confirmationReasons?.includes('near_term_change')
                ? 'Almeno un blocco entro 60 minuti cambierebbe.'
                : ''}
            </div>
            <button className="btn" onClick={() => void confirmReplan()}>
              {pendingConfirmation.confirmationReasons?.includes('permanent_task_conflict')
                ? 'Lascia da ricollocare'
                : 'Applica il replan'}
            </button>
          </div>
        )}

        {view === 'day' && (
          <>
            {viewingToday && decisionBriefing.length > 0 && (
              <div className="card">
                <h2>Decisione del piano</h2>
                <ol className="list__meta">
                  {decisionBriefing.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ol>
              </div>
            )}
            {viewingToday && unplaced.length > 0 && (
              <div className="card">
                <h2>Attività non ancora collocate nel piano</h2>
                <ul className="list__meta">
                  {unplaced.map((item) => {
                    const label =
                      item.outcome === 'needs_decision'
                        ? 'Serve una scelta'
                        : item.outcome === 'delegation_candidate'
                          ? 'Candidata per Jarvis'
                          : 'Rinviata';
                    return <li key={`${item.title}-${item.reason}`}>{label}: {item.title}</li>;
                  })}
                </ul>
              </div>
            )}
            <DayCalendar
              dayStart={day}
              blocks={dayBlocks}
              events={dayEvents}
              onMove={moveBlock}
              onSelect={(block) => setSheet({ type: 'block', block })}
              onSelectEvent={(event) => setSheet({ type: 'event', event })}
            />
            {sheet && (
              <EventSheet
                key={sheet.type === 'block' ? sheet.block.id : sheet.event.id}
                target={sheet}
                onClose={() => setSheet(null)}
                onSave={saveSheet}
                onDelete={deleteSheet}
                onComplete={completeBlock}
              />
            )}
          </>
        )}

        {view === 'tasks' && <Tasks onChanged={loadPlan} />}
        {view === 'shopping' && <Shopping />}
        {view === 'settings' && <Settings onChanged={loadPlan} />}
      </main>

      {view !== 'settings' && <CaptureBar onApplied={loadPlan} />}

      <nav className="tabbar">
        {(
          [
            ['day', '📅', 'Giorno'],
            ['tasks', '✓', 'Attività'],
            ['shopping', '🛒', 'Spesa'],
            ['settings', '⚙', 'Impostazioni'],
          ] as const
        ).map(([key, icon, label]) => (
          <button
            key={key}
            aria-current={view === key ? 'page' : undefined}
            onClick={() => setView(key)}
          >
            <span className="tabbar__icon" aria-hidden="true">
              {icon}
            </span>
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}
