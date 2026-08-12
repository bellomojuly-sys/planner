import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type PlanResponse, type Block } from './lib/api';
import { Lock, Setup } from './components/Lock';
import { DayCalendar } from './components/DayCalendar';
import { CaptureBar } from './components/CaptureBar';
import { Shopping } from './components/Shopping';
import { Tasks } from './components/Tasks';
import { Settings } from './components/Settings';
import { addDays, dayLong, dayShort, sameDay, startOfDay } from './lib/format';

type View = 'day' | 'tasks' | 'shopping' | 'settings';
type AuthState = 'loading' | 'setup' | 'locked' | 'unlocked';

export function App() {
  const [auth, setAuth] = useState<AuthState>('loading');
  const [view, setView] = useState<View>('day');

  useEffect(() => {
    void api
      .get<{ configured: boolean; authenticated: boolean }>('/auth/status')
      .then(({ data }) => {
        setAuth(
          !data.configured ? 'setup' : data.authenticated ? 'unlocked' : 'locked',
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
  if (auth === 'locked') return <Lock onUnlocked={() => setAuth('unlocked')} />;

  return <Shell view={view} setView={setView} />;
}

function Shell({ view, setView }: { view: View; setView: (v: View) => void }) {
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [day, setDay] = useState(() => startOfDay(Date.now()));
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
              b.id === blockId ? { ...b, start, end, pinned: true } : b,
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

  async function selectBlock(block: Block) {
    if (!block.taskId) return;
    if (!confirm(`Segnare "${block.title}" come completata?`)) return;

    try {
      await api.post(`/plan/blocks/${block.id}/complete`);
      setNotice('Completata. Ho aggiornato la stima con il tempo reale.');
      await loadPlan();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Errore.');
    }
  }

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(id);
  }, [notice]);

  const dayBlocks = plan?.blocks.filter((b) => sameDay(b.start, day)) ?? [];
  const dayEvents = plan?.events.filter((e) => sameDay(e.start, day)) ?? [];
  const unplaced = plan?.lastRun?.summary?.unplaced ?? [];

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

        {view === 'day' && (
          <>
            {unplaced.length > 0 && (
              <div className="banner" data-tone="warn">
                Non c’è spazio per {unplaced.length}{' '}
                {unplaced.length === 1 ? 'attività' : 'attività'}:{' '}
                {unplaced.map((u) => u.title).join(', ')}.
              </div>
            )}
            <DayCalendar
              dayStart={day}
              blocks={dayBlocks}
              events={dayEvents}
              onMove={moveBlock}
              onSelect={selectBlock}
            />
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
