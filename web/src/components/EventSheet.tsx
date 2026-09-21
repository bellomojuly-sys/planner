import { useEffect, useState } from 'react';
import type { Block, CalendarEventView } from '../lib/api';
import {
  dateInputValue,
  dayLong,
  fromDateAndTime,
  range,
  timeInputValue,
} from '../lib/format';

/** What the sheet is showing: a planner block or a real calendar event. */
export type SheetTarget =
  | { type: 'block'; block: Block }
  | { type: 'event'; event: CalendarEventView };

interface Props {
  target: SheetTarget;
  onClose: () => void;
  onSave: (target: SheetTarget, patch: { title: string; start: number; end: number }) => Promise<void>;
  onDelete: (target: SheetTarget) => Promise<void>;
  onComplete: (block: Block) => Promise<void>;
}

/**
 * Tap target for everything on the day grid. Replaces the old behaviour where
 * tapping a block immediately asked to complete it: completing is now one of
 * three explicit actions, next to editing and deleting.
 */
export function EventSheet({ target, onClose, onSave, onDelete, onComplete }: Props) {
  const item = target.type === 'block' ? target.block : target.event;
  const allDay = target.type === 'event' && target.event.allDay;
  const editable = target.type === 'block' ? target.block.editable : target.event.editable;
  const deletable = target.type === 'block' ? target.block.deletable : target.event.editable;
  const reason = target.type === 'block' ? target.block.reason : target.event.readOnlyReason;

  const [title, setTitle] = useState(item.title);
  const [date, setDate] = useState(dateInputValue(item.start));
  const [start, setStart] = useState(timeInputValue(item.start));
  const [end, setEnd] = useState(timeInputValue(item.end));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const startTs = allDay ? item.start : fromDateAndTime(date, start);
  let endTs = allDay ? item.end : fromDateAndTime(date, end);
  // An end earlier than the start means the event runs past midnight.
  if (!allDay && endTs <= startTs) endTs += 24 * 60 * 60_000;
  const invalid = title.trim().length === 0 || endTs - startTs > 24 * 60 * 60_000;

  const deleteWarning =
    target.type === 'event'
      ? 'L’evento verrà eliminato anche da Google Calendar.'
      : target.block.taskId
        ? 'Il blocco sparisce dal piano e l’attività resta aperta ma fuori dal piano, finché non la rimetti dalla lista Attività.'
        : target.block.kind === 'gym'
          ? 'La palestra di questo giorno sparisce e non verrà ripianificata in un altro giorno della settimana.'
          : 'Questo tratto sparisce e il piano non lo ricrea.';

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`Modifica ${item.title}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet__header">
          <h2>{target.type === 'event' ? target.event.calendarName : 'Blocco del piano'}</h2>
          <button className="btn" data-variant="quiet" onClick={onClose}>
            Chiudi
          </button>
        </div>

        {!editable && reason && <p className="sheet__note">{reason}</p>}
        {target.type === 'block' && target.block.pinned && (
          <p className="sheet__note">📌 Bloccato: il ripiano non lo sposta.</p>
        )}

        {editable ? (
          <>
            <label className="field">
              <span>Titolo</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            {allDay ? (
              <p className="sheet__note">
                Evento per l’intera giornata · {dayLong(item.start)}. Qui puoi cambiare solo il titolo.
              </p>
            ) : (
              <>
                <label className="field">
                  <span>Giorno</span>
                  <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </label>
                <div className="row">
                  <label className="field">
                    <span>Inizio</span>
                    <input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
                  </label>
                  <label className="field">
                    <span>Fine</span>
                    <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
                  </label>
                </div>
              </>
            )}
            {target.type === 'block' && (
              <p className="sheet__note">
                Salvando, il blocco resta fisso a questo orario: il ripiano non lo sovrascrive.
              </p>
            )}
          </>
        ) : (
          <p>
            <strong>{item.title}</strong>
            <br />
            {allDay ? dayLong(item.start) : `${dayLong(item.start)} · ${range(item.start, item.end)}`}
          </p>
        )}

        <div className="sheet__actions">
          {target.type === 'block' && target.block.taskId && target.block.kind === 'task' && (
            <button
              className="btn"
              disabled={busy}
              onClick={() => void run(() => onComplete(target.block))}
            >
              Completata
            </button>
          )}
          {deletable && (
            <button
              className="btn"
              data-variant="danger"
              disabled={busy}
              onClick={() => {
                if (confirm(`Eliminare "${item.title}"? ${deleteWarning}`)) {
                  void run(() => onDelete(target));
                }
              }}
            >
              Elimina
            </button>
          )}
          {editable && (
            <button
              className="btn"
              data-variant="primary"
              disabled={busy || invalid}
              onClick={() =>
                void run(() => onSave(target, { title: title.trim(), start: startTs, end: endTs }))
              }
            >
              Salva
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
