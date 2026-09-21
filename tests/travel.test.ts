import { describe, expect, it } from 'vitest';
import { schedule } from '../src/scheduler/engine';
import {
  applyBusyPersonalRules,
  applyCalendarPersonalRules,
  hasPhysicalLocation,
  parsePlaceTravelMinutes,
} from '../src/scheduler/personal-rules';
import type { SchedulableTask } from '../src/scheduler/types';
import type { Settings } from '../src/db/schema';
import { baseSettings } from './support/settings';

const TZ = 'Europe/Rome';
/** Monday 12 January 2026, 07:00 in Rome. */
const MONDAY = Date.parse('2026-01-12T06:00:00Z');
const HOUR = 60 * 60_000;
const at = (hoursAfterSeven: number) => MONDAY + hoursAfterSeven * HOUR;
const settings: Settings = { ...baseSettings };

describe('which events need a journey', () => {
  it('treats a street address as physical and meeting links as online', () => {
    expect(hasPhysicalLocation('Dentista', 'Stratumseind 10, Eindhoven')).toBe(true);
    expect(hasPhysicalLocation('Standup', 'https://teams.microsoft.com/l/meetup')).toBe(false);
    expect(hasPhysicalLocation('Sync', 'Zoom')).toBe(false);
    expect(hasPhysicalLocation('Webinar online', 'Eindhoven')).toBe(false);
    expect(hasPhysicalLocation('Studio', null)).toBe(false);
    expect(hasPhysicalLocation('Studio', '   ')).toBe(false);
  });

  it('parses per-place overrides', () => {
    expect(parsePlaceTravelMinutes('Tandarts=10, ristorante da Mario = 15;bad')).toEqual([
      { place: 'tandarts', minutes: 10 },
      { place: 'ristorante da mario', minutes: 15 },
    ]);
  });
});

describe('travel around located events', () => {
  it('reserves travel both ways for Applied GenAI at Fontys', () => {
    const lesson = applyBusyPersonalRules(
      {
        start: at(3),
        end: at(5),
        title: 'Applied GenAI',
        location: 'Fontys ICT, Rachelsmolen 1, Eindhoven',
      },
      settings,
    );
    expect(lesson.travelBeforeMinutes).toBe(20);
    expect(lesson.travelAfterMinutes).toBe(20);
    expect(lesson.travelBeforeLabel).toBe('Viaggio casa → università');
  });

  it('uses the configured default plus buffer for any other place', () => {
    const dentist = applyBusyPersonalRules(
      { start: at(3), end: at(4), title: 'Dentista', location: 'Stratumseind 10, Eindhoven' },
      settings,
    );
    expect(dentist.travelBeforeMinutes).toBe(25);
    expect(dentist.travelAfterMinutes).toBe(25);
    expect(dentist.travelBeforeLabel).toBe('Viaggio in bici → Stratumseind 10');
    expect(dentist.travelAfterLabel).toBe('Rientro in bici da Stratumseind 10');
  });

  it('prefers a per-place override and follows the configured mode', () => {
    const dentist = applyBusyPersonalRules(
      { start: at(3), end: at(4), title: 'Controllo', location: 'Tandarts Centrum, Eindhoven' },
      { ...settings, placeTravelMinutes: 'tandarts=10', travelMode: 'public_transport' },
    );
    expect(dentist.travelBeforeMinutes).toBe(15);
    expect(dentist.travelBeforeLabel).toBe('Viaggio coi mezzi → Tandarts Centrum');
  });

  it('adds nothing for online events or events without a location', () => {
    for (const event of [
      { title: 'Call cliente', location: 'https://meet.google.com/abc-defg-hij' },
      { title: 'Revisione', location: null },
    ]) {
      const result = applyBusyPersonalRules({ start: at(3), end: at(4), ...event }, settings);
      expect(result.travelBeforeMinutes).toBeUndefined();
      expect(result.travelAfterMinutes).toBeUndefined();
    }
  });

  it('keeps one journey for back-to-back events at the same place', () => {
    const { busy } = applyCalendarPersonalRules(
      [
        { start: at(3), end: at(5), title: 'Applied GenAI', location: 'Rachelsmolen 1, R1' },
        { start: at(5.5), end: at(7), title: 'Applied GenAI lab', location: 'Rachelsmolen 1, R10' },
        { start: at(12), end: at(13), title: 'Dentista', location: 'Stratumseind 10' },
      ],
      [],
      settings,
      TZ,
    );

    expect(busy[0]!.travelBeforeMinutes).toBe(20);
    expect(busy[0]!.travelAfterMinutes).toBe(0);
    expect(busy[1]!.travelBeforeMinutes).toBe(0);
    expect(busy[1]!.preparationBeforeMinutes).toBe(0);
    expect(busy[1]!.travelAfterMinutes).toBe(20);
    // A different place later the same day still gets its own round trip.
    expect(busy[2]!.travelBeforeMinutes).toBe(25);
  });

  it('also covers Applied GenAI when it arrives as a university context', () => {
    const { contexts } = applyCalendarPersonalRules(
      [],
      [
        {
          start: at(3),
          end: at(5),
          title: 'Applied GenAI',
          location: 'Rachelsmolen 1, Eindhoven',
          allowedAreas: ['university'],
        },
      ],
      settings,
      TZ,
    );
    expect(contexts[0]!.travelBeforeMinutes).toBe(20);
    expect(contexts[0]!.travelAfterMinutes).toBe(20);
  });
});

describe('travel blocks are busy time', () => {
  it('emits the journey as blocks and never schedules work inside it', () => {
    const event = { start: at(4), end: at(5), title: 'Dentista', location: 'Stratumseind 10' };
    const work: SchedulableTask = {
      id: 'report',
      title: 'Report',
      area: 'general',
      energy: 'low',
      priority: 1,
      plannedMinutes: 90,
      dueAt: at(8),
      earliestStartAt: at(3),
      splittable: false,
      pinned: false,
      isGym: false,
      status: 'todo',
      projectKey: null,
      phaseOrder: null,
    };
    const { busy } = applyCalendarPersonalRules([event], [], settings, TZ);

    const result = schedule({
      now: MONDAY,
      horizonEnd: MONDAY + 2 * 24 * HOUR,
      timezone: TZ,
      settings,
      tasks: [work],
      dependencies: new Map(),
      busy,
      pinnedBlocks: [],
    });

    const outward = result.blocks.find((b) => b.title === 'Viaggio in bici → Stratumseind 10');
    const back = result.blocks.find((b) => b.title === 'Rientro in bici da Stratumseind 10');
    expect(outward).toMatchObject({ start: at(4) - 25 * 60_000, end: at(4), kind: 'buffer' });
    expect(back).toMatchObject({ start: at(5), end: at(5) + 25 * 60_000, kind: 'buffer' });

    const placed = result.blocks.filter((b) => b.taskId === 'report');
    expect(placed.length).toBeGreaterThan(0);
    for (const block of placed) {
      for (const travel of [outward!, back!]) {
        expect(block.start < travel.end && travel.start < block.end).toBe(false);
      }
    }
  });
});
