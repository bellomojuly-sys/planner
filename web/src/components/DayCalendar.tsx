import { useEffect, useMemo, useRef, useState } from 'react';
import type { Block, CalendarEventView } from '../lib/api';
import { minutesOfDay, range, time } from '../lib/format';

const PX_PER_MINUTE = 68 / 60;
const SNAP_MINUTES = 15;
const MIN_BLOCK_HEIGHT = 26;

interface Props {
  dayStart: number;
  blocks: Block[];
  events: CalendarEventView[];
  onMove: (blockId: string, start: number, end: number) => void;
  onSelect: (block: Block) => void;
  onSelectEvent: (event: CalendarEventView) => void;
}

interface DragState {
  blockId: string;
  pointerId: number;
  startY: number;
  originalStart: number;
  originalEnd: number;
  offsetMinutes: number;
}

/**
 * A single day as a vertical timeline.
 *
 * Dragging is implemented with raw pointer events rather than a drag-and-drop
 * library: touch is the primary input here, and the browser's HTML5 DnD does
 * not fire on iOS at all. Pointer capture also means the gesture survives the
 * finger leaving the element, which matters on a small screen.
 */
export function DayCalendar({
  dayStart,
  blocks,
  events,
  onMove,
  onSelect,
  onSelectEvent,
}: Props) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dragDelta, setDragDelta] = useState(0);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // The window stretches to fit whatever is actually scheduled, so an early
  // shift or a late gym session is never clipped off the top or bottom.
  const { fromMinute, toMinute } = useMemo(() => {
    const all = [
      ...blocks.map((b) => [minutesOfDay(b.start), minutesOfDay(b.end)]),
      ...events.filter((e) => !e.allDay).map((e) => [minutesOfDay(e.start), minutesOfDay(e.end)]),
    ].flat();

    return {
      fromMinute: Math.min(6 * 60, ...all.map((m) => Math.floor(m / 60) * 60)),
      toMinute: Math.max(23 * 60, ...all.map((m) => Math.ceil(m / 60) * 60)),
    };
  }, [blocks, events]);

  const totalMinutes = Math.max(60, toMinute - fromMinute);
  const yFor = (ts: number) => (minutesOfDay(ts) - fromMinute) * PX_PER_MINUTE;

  function handlePointerDown(e: React.PointerEvent, block: Block) {
    // Derived intervals are not draggable, but a tap still opens them.
    if (block.kind === 'break' || block.kind === 'buffer') {
      onSelect(block);
      return;
    }

    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({
      blockId: block.id,
      pointerId: e.pointerId,
      startY: e.clientY,
      originalStart: block.start,
      originalEnd: block.end,
      offsetMinutes: 0,
    });
    setDragDelta(0);
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const deltaMinutes = (e.clientY - drag.startY) / PX_PER_MINUTE;
    setDragDelta(Math.round(deltaMinutes / SNAP_MINUTES) * SNAP_MINUTES);
  }

  function handlePointerUp(e: React.PointerEvent) {
    if (!drag || e.pointerId !== drag.pointerId) return;

    // A tap (no meaningful movement) opens the block instead of moving it.
    if (dragDelta === 0) {
      const block = blocks.find((b) => b.id === drag.blockId);
      if (block) onSelect(block);
    } else {
      const shift = dragDelta * 60_000;
      onMove(drag.blockId, drag.originalStart + shift, drag.originalEnd + shift);
      navigator.vibrate?.(12);
    }

    setDrag(null);
    setDragDelta(0);
  }

  const hours = Array.from(
    { length: Math.ceil(totalMinutes / 60) + 1 },
    (_, i) => fromMinute + i * 60,
  );

  const showNow = now >= dayStart && now < dayStart + 86_400_000;

  const allDayEvents = events.filter((event) => event.allDay);

  return (
    <>
      {allDayEvents.length > 0 && (
        <div className="all-day-events" aria-label="Eventi per l'intera giornata">
          {allDayEvents.map((event) => (
            <div
              className="all-day-event"
              key={event.id}
              role="button"
              tabIndex={0}
              onClick={() => onSelectEvent(event)}
              onKeyDown={(e) => e.key === 'Enter' && onSelectEvent(event)}
            >
              <span style={{ backgroundColor: event.color }} aria-hidden="true" />
              <strong>{event.title}</strong>
              <small>{event.calendarName} · non blocca</small>
            </div>
          ))}
        </div>
      )}

      <div
        className="grid"
        ref={gridRef}
        style={{ height: totalMinutes * PX_PER_MINUTE + 20 }}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => setDrag(null)}
      >
      {hours.map((minute) => (
        <div
          key={minute}
          className="grid__hour"
          style={{ top: (minute - fromMinute) * PX_PER_MINUTE }}
        >
          <span>{String(Math.floor(minute / 60) % 24).padStart(2, '0')}:00</span>
        </div>
      ))}

      {showNow && (
        <div
          className="grid__now"
          style={{ top: (minutesOfDay(now) - fromMinute) * PX_PER_MINUTE }}
          aria-label={`Adesso, ${time(now)}`}
        />
      )}

      {events
        .filter((e) => !e.allDay)
        .map((event) => (
          <div
            key={event.id}
            className="block"
            data-kind={event.kind}
            role="button"
            tabIndex={0}
            aria-label={`${event.title}, ${range(event.start, event.end)}`}
            onClick={() => onSelectEvent(event)}
            onKeyDown={(e) => e.key === 'Enter' && onSelectEvent(event)}
            style={{
              top: yFor(event.start),
              height: Math.max(
                MIN_BLOCK_HEIGHT,
                (minutesOfDay(event.end) - minutesOfDay(event.start)) * PX_PER_MINUTE - 3,
              ),
              borderLeftColor: event.color,
            }}
          >
            <div className="block__title">
              {event.title}
              {event.isShift && <span className="block__badge">turno</span>}
              {event.kind === 'soft' && <span className="block__badge">non blocca</span>}
              <span className="block__badge">{event.calendarName}</span>
            </div>
            <div className="block__time">{range(event.start, event.end)}</div>
          </div>
        ))}

      {blocks.map((block) => {
        const dragging = drag?.blockId === block.id;
        const offset = dragging ? dragDelta * PX_PER_MINUTE : 0;

        return (
          <div
            key={block.id}
            className="block"
            data-kind={block.kind}
            data-area={block.area ?? 'general'}
            data-dragging={dragging}
            role="button"
            tabIndex={0}
            aria-label={`${block.title}, ${range(block.start, block.end)}`}
            style={{
              top: yFor(block.start) + offset,
              height: Math.max(
                MIN_BLOCK_HEIGHT,
                (minutesOfDay(block.end) - minutesOfDay(block.start)) * PX_PER_MINUTE - 3,
              ),
            }}
            onPointerDown={(e) => handlePointerDown(e, block)}
            onKeyDown={(e) => e.key === 'Enter' && onSelect(block)}
          >
            <div className="block__title">
              {block.title}
              {block.pinned && <span className="block__badge">📌</span>}
              {block.syncState === 'pending' && <span className="block__badge">↻</span>}
            </div>
            <div className="block__time">
              {dragging
                ? range(
                    block.start + dragDelta * 60_000,
                    block.end + dragDelta * 60_000,
                  )
                : range(block.start, block.end)}
            </div>
          </div>
        );
      })}

        {blocks.length === 0 && events.length === 0 && (
          <div className="empty">Niente in programma per questo giorno.</div>
        )}
      </div>

      {events.some((event) => event.kind === 'soft' || event.allDay) && (
        <p className="grid-legend">
          <span className="grid-legend__swatch" aria-hidden="true" />
          <span>
            Tratteggiato = evento che <strong>non blocca</strong> il piano: segnato come
            “libero” in Google, per l’intera giornata, un contesto di lavoro (es. Applied
            GenAI, Zelf Work) o da un calendario di solo contesto. Il piano può
            programmarci attività sopra; un contesto universitario accetta solo lavoro
            universitario.
          </span>
        </p>
      )}
    </>
  );
}
