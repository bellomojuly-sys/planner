import { useEffect, useState } from 'react';
import { api, ApiError, type ShoppingItemView } from '../lib/api';

interface Group {
  category: string;
  items: ShoppingItemView[];
}

export function Shopping() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [showBought, setShowBought] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    name: '',
    quantity: 1,
    unit: 'pz',
    category: 'altro',
    store: '',
    url: '',
  });

  async function load() {
    try {
      const { data } = await api.get<{ groups: Group[] }>(
        `/shopping?status=${showBought ? 'all' : 'open'}`,
      );
      setGroups(data.groups);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Errore di caricamento.');
    }
  }

  useEffect(() => {
    void load();
  }, [showBought]);

  async function toggle(item: ShoppingItemView) {
    // Optimistic: the list should respond instantly in a supermarket aisle,
    // where the connection is usually poor.
    setGroups((gs) =>
      gs.map((g) => ({
        ...g,
        items: g.items.map((i) =>
          i.id === item.id
            ? { ...i, status: i.status === 'bought' ? 'open' : 'bought' }
            : i,
        ),
      })),
    );

    try {
      await api.patch(`/shopping/${item.id}`, {
        status: item.status === 'bought' ? 'open' : 'bought',
      });
    } catch {
      void load();
    }
  }

  async function add() {
    if (!draft.name.trim()) return;
    setAdding(true);
    try {
      await api.post('/shopping', {
        ...draft,
        store: draft.store || null,
        url: draft.url || null,
      });
      setDraft({ name: '', quantity: 1, unit: 'pz', category: 'altro', store: '', url: '' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Errore.');
    } finally {
      setAdding(false);
    }
  }

  const openCount = groups.reduce(
    (n, g) => n + g.items.filter((i) => i.status === 'open').length,
    0,
  );

  return (
    <>
      {error && (
        <div className="banner" data-tone="error" role="alert">
          {error}
        </div>
      )}

      <div className="card">
        <h2>Aggiungi</h2>
        <label className="field">
          <span>Articolo</span>
          <input
            value={draft.name}
            placeholder="Latte intero"
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void add();
            }}
          />
        </label>
        <div className="row">
          <label className="field">
            <span>Quantità</span>
            <input
              type="number"
              inputMode="decimal"
              min={0.1}
              step={0.5}
              value={draft.quantity}
              onChange={(e) => setDraft({ ...draft, quantity: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>Unità</span>
            <input
              value={draft.unit}
              onChange={(e) => setDraft({ ...draft, unit: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Categoria</span>
            <input
              value={draft.category}
              onChange={(e) => setDraft({ ...draft, category: e.target.value })}
            />
          </label>
        </div>
        <div className="row">
          <label className="field">
            <span>Negozio</span>
            <input
              value={draft.store}
              placeholder="Esselunga"
              onChange={(e) => setDraft({ ...draft, store: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Link per acquisto online</span>
            <input
              type="url"
              inputMode="url"
              value={draft.url}
              placeholder="https://…"
              onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            />
          </label>
        </div>
        <button
          className="btn"
          data-variant="primary"
          disabled={adding || !draft.name.trim()}
          onClick={() => void add()}
        >
          Aggiungi
        </button>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="chip">{openCount} da comprare</span>
        <button className="btn" data-variant="quiet" onClick={() => setShowBought((v) => !v)}>
          {showBought ? 'Nascondi comprati' : 'Mostra comprati'}
        </button>
      </div>

      {groups.length === 0 && <div className="empty">La lista è vuota.</div>}

      {groups.map((group) => (
        <div className="card" key={group.category}>
          <h2>{group.category}</h2>
          <ul className="list">
            {group.items.map((item) => (
              <li key={item.id}>
                <button
                  className="check"
                  aria-pressed={item.status === 'bought'}
                  aria-label={
                    item.status === 'bought' ? 'Segna da comprare' : 'Segna come comprato'
                  }
                  onClick={() => void toggle(item)}
                >
                  {item.status === 'bought' ? '✓' : ''}
                </button>

                <div className="list__main">
                  <div className="list__title" data-done={item.status === 'bought'}>
                    {item.name}
                    {item.urgent && <span className="block__badge">urgente</span>}
                  </div>
                  <div className="list__meta">
                    {item.quantity} {item.unit}
                    {item.store && ` · ${item.store}`}
                    {item.estimatedPrice != null && ` · €${item.estimatedPrice.toFixed(2)}`}
                  </div>
                </div>

                {item.url && (
                  <a
                    className="btn"
                    data-variant="quiet"
                    href={item.url}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    Compra
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}

      {showBought && (
        <button
          className="btn"
          onClick={async () => {
            await api.post('/shopping/clear-bought');
            await load();
          }}
        >
          Svuota i comprati
        </button>
      )}
    </>
  );
}
