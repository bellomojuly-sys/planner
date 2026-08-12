import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';

/**
 * PIN gate. Purely a client of the server-side check — the PIN is never
 * compared in the browser, and the lockout that actually stops brute force
 * lives in the Worker.
 */
export function Lock({ onUnlocked }: { onUnlocked: () => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (pin.length < 4) return;
    // Auto-submit at 6 digits, the common case; shorter PINs need the button.
    if (pin.length === 6) void submit(pin);
  }, [pin]);

  async function submit(value: string) {
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      await api.post('/auth/unlock', { pin: value });
      onUnlocked();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Errore imprevisto.');
      setPin('');
      // A short vibration is the clearest signal on a phone held at arm's length.
      navigator.vibrate?.(80);
    } finally {
      setBusy(false);
    }
  }

  const press = (digit: string) => {
    if (pin.length >= 10) return;
    setPin((p) => p + digit);
    navigator.vibrate?.(8);
  };

  return (
    <div className="lock">
      <h1>Planner</h1>
      <p>Inserisci il PIN per continuare.</p>

      <div className="pin" aria-label={`${pin.length} cifre inserite`}>
        {Array.from({ length: Math.max(6, pin.length) }).map((_, i) => (
          <span key={i} data-filled={i < pin.length} />
        ))}
      </div>

      {error && (
        <div className="banner" data-tone="error" role="alert">
          {error}
        </div>
      )}

      <div className="keypad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button key={d} onClick={() => press(d)} disabled={busy}>
            {d}
          </button>
        ))}
        <button data-role="blank" aria-hidden="true" tabIndex={-1} />
        <button onClick={() => press('0')} disabled={busy}>
          0
        </button>
        <button
          onClick={() => setPin((p) => p.slice(0, -1))}
          disabled={busy || pin.length === 0}
          aria-label="Cancella"
        >
          ⌫
        </button>
      </div>

      {pin.length >= 4 && pin.length !== 6 && (
        <button
          className="btn"
          data-variant="primary"
          onClick={() => void submit(pin)}
          disabled={busy}
        >
          Sblocca
        </button>
      )}
    </div>
  );
}

/** First-run configuration, shown only while no user exists. */
export function Setup({ onDone }: { onDone: (captureToken: string) => void }) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (pin !== confirm) {
      setError('I due PIN non coincidono.');
      return;
    }
    setBusy(true);
    setError(null);

    try {
      const { data } = await api.post<{ captureToken: string }>('/auth/setup', {
        email,
        displayName,
        pin,
      });
      onDone(data.captureToken);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Errore imprevisto.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lock">
      <h1>Configurazione</h1>
      <p>Serve solo una volta. Il PIN protegge l’app su questo dispositivo.</p>

      <div style={{ width: '100%', maxWidth: 340 }}>
        <label className="field">
          <span>Nome</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label className="field">
          <span>Email</span>
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="field">
          <span>PIN (4–10 cifre)</span>
          <input
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          />
        </label>
        <label className="field">
          <span>Conferma PIN</span>
          <input
            type="password"
            inputMode="numeric"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value.replace(/\D/g, ''))}
          />
        </label>

        {error && (
          <div className="banner" data-tone="error" role="alert">
            {error}
          </div>
        )}

        <button
          className="btn"
          data-variant="primary"
          style={{ width: '100%' }}
          disabled={busy || pin.length < 4 || !email || !displayName}
          onClick={() => void submit()}
        >
          {busy ? 'Creo…' : 'Crea account'}
        </button>
      </div>
    </div>
  );
}
