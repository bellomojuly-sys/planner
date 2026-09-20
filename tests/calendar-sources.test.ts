import { describe, expect, it } from 'vitest';
import { cleanSecret } from '../src/integrations/google-calendar';
import type {
  GoogleCalendar,
  GoogleEvent,
} from '../src/integrations/google-calendar';
import {
  canWriteCalendar,
  suggestCalendarRole,
} from '../src/services/calendar-sources';
import { shouldBackfillCalendarId } from '../src/services/planner';
import { classifyEvent } from '../src/services/sync';

function calendar(overrides: Partial<GoogleCalendar> = {}): GoogleCalendar {
  return {
    id: 'calendar@example.com',
    summary: 'Personale',
    primary: false,
    accessRole: 'reader',
    color: '#9aa3b8',
    ...overrides,
  };
}

function event(overrides: Partial<GoogleEvent> = {}): GoogleEvent {
  return {
    externalId: 'event-1',
    title: 'Appuntamento',
    location: null,
    startAt: Date.parse('2026-08-13T08:00:00Z'),
    endAt: Date.parse('2026-08-13T09:00:00Z'),
    allDay: false,
    transparent: false,
    cancelled: false,
    etag: null,
    isPlannerBlock: false,
    plannerBlockId: null,
    ...overrides,
  };
}

describe('Google calendar discovery', () => {
  it('backfills a legacy null route only when the target is the fallback calendar', () => {
    expect(shouldBackfillCalendarId(null, 'planner', 'planner')).toBe(true);
    expect(shouldBackfillCalendarId(null, 'university', 'planner')).toBe(false);
    expect(shouldBackfillCalendarId('planner', 'planner', 'planner')).toBe(false);
  });

  it('uses the writable primary calendar as the planner destination', () => {
    expect(
      suggestCalendarRole(
        calendar({ primary: true, accessRole: 'owner' }),
        false,
      ),
    ).toBe('planner');
  });

  it('keeps every other discovered calendar busy by default', () => {
    expect(
      suggestCalendarRole(
        calendar({ summary: 'eitje', accessRole: 'reader' }),
        false,
      ),
    ).toBe('busy');
    expect(
      suggestCalendarRole(
        calendar({ primary: true, accessRole: 'owner' }),
        true,
      ),
    ).toBe('busy');
  });

  it('only treats writer and owner calendars as writable', () => {
    expect(canWriteCalendar('freeBusyReader')).toBe(false);
    expect(canWriteCalendar('reader')).toBe(false);
    expect(canWriteCalendar('writer')).toBe(true);
    expect(canWriteCalendar('owner')).toBe(true);
  });
});

describe('calendar event classification', () => {
  it('blocks timed opaque events from busy and planner calendars', () => {
    expect(classifyEvent(event(), [], 'busy')).toEqual({
      kind: 'fixed',
      isShift: false,
    });
    expect(classifyEvent(event(), [], 'planner').kind).toBe('fixed');
  });

  it('shows context, transparent and all-day events without blocking time', () => {
    expect(classifyEvent(event({ title: 'Zelf Work' }), [], 'context').kind).toBe(
      'soft',
    );
    expect(classifyEvent(event({ transparent: true }), [], 'busy').kind).toBe(
      'soft',
    );
    expect(classifyEvent(event({ allDay: true }), [], 'busy').kind).toBe('soft');
  });

  it('recognises restaurant shifts from defaults and configured keywords', () => {
    expect(classifyEvent(event({ title: 'Turno ristorante' }), [], 'busy').isShift).toBe(
      true,
    );
    expect(
      classifyEvent(event({ title: '18:00–23:00' }), [], 'busy', 'eitje').isShift,
    ).toBe(true);
    expect(
      classifyEvent(event({ title: 'Lezione università' }), ['lezione'], 'busy')
        .isShift,
    ).toBe(false);
  });
});

describe('pasted Google secrets', () => {
  it.each([
    ['123-abc.apps.googleusercontent.com\n', '123-abc.apps.googleusercontent.com'],
    ['  "123-abc.apps.googleusercontent.com"  ', '123-abc.apps.googleusercontent.com'],
    ["'GOCSPX-secret'", 'GOCSPX-secret'],
    ['1//0g-token', '1//0g-token'],
  ])('cleans %j', (raw, clean) => {
    expect(cleanSecret(raw)).toBe(clean);
  });
});
