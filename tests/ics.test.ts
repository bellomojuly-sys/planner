import { describe, expect, it } from 'vitest';
import { parseIcs, parseProperty, unfoldLines } from '../src/integrations/ics';

/**
 * Shapes taken from the two feeds Planner actually subscribes to, with the
 * personal details replaced: eitje publishes timed shifts in a named zone,
 * Canvas publishes deadlines either as all-day dates or as instants whose end
 * equals their start.
 */

const EITJE = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:icalendar-ruby
CALSCALE:GREGORIAN
BEGIN:VTIMEZONE
TZID:Europe/Amsterdam
BEGIN:DAYLIGHT
DTSTART:19810329T020000
RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
DTSTAMP:20260917T222303Z
UID:shift-29914496
DTSTART;TZID=Europe/Amsterdam:20260804T170000
DTEND;TZID=Europe/Amsterdam:20260804T223000
DESCRIPTION:type: standaard \\n\\nnote:
LAST-MODIFIED:20260804T201456
SUMMARY:Werken bij Ristorante: sala
END:VEVENT
BEGIN:VEVENT
UID:shift-29914497
DTSTART;TZID=Europe/Amsterdam:20261115T170000
DTEND;TZID=Europe/Amsterdam:20261115T223000
SUMMARY:Werken bij Ristorante: sala
END:VEVENT
END:VCALENDAR`;

const CANVAS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:icalendar-ruby
BEGIN:VEVENT
DTSTAMP:20260911T115800Z
UID:event-assignment-280317
DTSTART:20260914T070000Z
DTEND:20260914T070000Z
CLASS:PUBLIC
SUMMARY:Industry Project Choice [MA-AAI]
URL;VALUE=URI:https://fhict.instructure.com/calendar?include_contexts=
 e_15850&month=09&year=2026#assignment_280317
END:VEVENT
BEGIN:VEVENT
UID:event-assignment-280318
DTSTART;VALUE=DATE;VALUE=DATE:20261002
SUMMARY:Portfolio checkpoint
END:VEVENT
END:VCALENDAR`;

describe('ICS line folding', () => {
  it('rejoins a continuation line without losing characters', () => {
    const lines = unfoldLines('URL;VALUE=URI:https://example.com/a\n b&c=d\nUID:1');
    expect(lines[0]).toBe('URL;VALUE=URI:https://example.com/ab&c=d');
    expect(lines[1]).toBe('UID:1');
  });

  it('keeps a colon inside a quoted parameter out of the split', () => {
    const prop = parseProperty('DTSTART;TZID="Europe/Amsterdam:x":20260804T170000');
    expect(prop).toEqual({
      name: 'DTSTART',
      params: { TZID: 'Europe/Amsterdam:x' },
      value: '20260804T170000',
    });
  });

  it('lets the last of a repeated parameter win', () => {
    expect(parseProperty('DTSTART;VALUE=DATE;VALUE=DATE:20261002')?.params).toEqual({
      VALUE: 'DATE',
    });
  });
});

describe('eitje shifts', () => {
  const parsed = parseIcs(EITJE);
  const [first, second] = parsed.events;

  it('reads both shifts and no event from the timezone block', () => {
    expect(parsed.events).toHaveLength(2);
    expect(parsed.skippedRecurring).toBe(0);
  });

  it('resolves a summer wall-clock time in Amsterdam, not in UTC', () => {
    // 17:00 CEST on 4 August 2026 is 15:00Z.
    expect(first!.startAt).toBe(Date.UTC(2026, 7, 4, 15, 0, 0));
    expect(first!.endAt).toBe(Date.UTC(2026, 7, 4, 20, 30, 0));
  });

  it('resolves a winter wall-clock time one hour later in UTC', () => {
    // 17:00 CET on 15 November 2026 is 16:00Z: the DST bug this test exists for.
    expect(second!.startAt).toBe(Date.UTC(2026, 10, 15, 16, 0, 0));
  });

  it('marks a shift as busy time, not as a marker', () => {
    expect(first!.allDay).toBe(false);
    expect(first!.transparent).toBe(false);
  });
});

describe('Canvas deadlines', () => {
  const parsed = parseIcs(CANVAS);

  it('keeps a zero-length deadline out of the busy mask', () => {
    const due = parsed.events.find((e) => e.externalId === 'event-assignment-280317')!;
    expect(due.startAt).toBe(Date.UTC(2026, 8, 14, 7, 0, 0));
    expect(due.endAt).toBe(due.startAt);
    expect(due.transparent).toBe(true);
  });

  it('treats a bare date as an all-day marker in the planning zone', () => {
    const marker = parsed.events.find((e) => e.externalId === 'event-assignment-280318')!;
    expect(marker.allDay).toBe(true);
    // Midnight in Rome on 2 October 2026 is 22:00Z the day before.
    expect(marker.startAt).toBe(Date.UTC(2026, 9, 1, 22, 0, 0));
  });

  it('rejoins the folded URL so the title stays intact', () => {
    expect(parsed.events[0]!.title).toBe('Industry Project Choice [MA-AAI]');
  });
});
