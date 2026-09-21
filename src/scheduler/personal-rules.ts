import type { Settings } from '../db/schema';
import type { Area } from '../db/schema';
import type { SchedulableTask } from './types';
import { localDateKey } from '../lib/time';

export interface BusyCommitment {
  start: number;
  end: number;
  title?: string;
  isShift?: boolean;
  location?: string | null;
  area?: Area;
  preparationBeforeMinutes?: number;
  travelBeforeMinutes?: number;
  travelAfterMinutes?: number;
  preparationLabel?: string;
  travelBeforeLabel?: string;
  travelAfterLabel?: string;
}

export interface PlanningContext extends BusyCommitment {
  allowedAreas: Area[];
}

const ADULT_LIFE_RE =
  /\bduo\b|assicurazione sanitaria|health insurance|cercare casa|ricerca casa|housing/i;

/** Personal place knowledge confirmed for a real one-off event. */
const DEN_BOSCH_RE = /den\s*bosch|denbosch/i;
const UNIVERSITY_PLACE_RE =
  /universit|lezione|esame|fontys|zelf\s*work|self\s*work|applied\s*genai|campus|scuola/i;

/**
 * Applies persisted Personal Rules only where the task has no explicit value.
 * Voice/API/Notion metadata always wins over a generic place rule.
 */
export function applyTaskPersonalRules(
  task: SchedulableTask,
  settings: Settings,
): SchedulableTask {
  const text = `${task.title} ${task.location ?? ''}`.toLowerCase();

  // Adult-life administration consists of independent atomic tasks. Without
  // a deadline it belongs on Sunday; a real due date may still force a safer
  // fallback before the consequence occurs.
  if (ADULT_LIFE_RE.test(text)) {
    return {
      ...task,
      preferredWeekdays: [0],
      strictPreferredWeekdays: task.dueAt === null,
    };
  }

  const physicalUniversityTask =
    UNIVERSITY_PLACE_RE.test(task.location ?? '') ||
    /lezione|esame\s+in\s+presenza/.test(text);
  if (physicalUniversityTask) {
    return {
      ...task,
      travelMinutes:
        task.travelMinutes && task.travelMinutes > 0
          ? task.travelMinutes
          : Math.max(20, settings.universityTravelMinutes),
      preparationMinutes:
        task.preparationMinutes && task.preparationMinutes > 0
          ? task.preparationMinutes
          : settings.universityPreparationMinutes,
    };
  }

  if (task.isGym || /palestra|gym|allenamento/.test(text)) {
    return {
      ...task,
      travelMinutes:
        task.travelMinutes && task.travelMinutes > 0
          ? task.travelMinutes
          : settings.gymTravelMinutes,
      preparationMinutes:
        task.preparationMinutes && task.preparationMinutes > 0
          ? task.preparationMinutes
          : settings.gymPreparationMinutes,
      recoveryMinutes:
        task.recoveryMinutes && task.recoveryMinutes > 0
          ? task.recoveryMinutes
          : settings.gymReturnMinutes,
    };
  }

  if (/ristorante|restaurant/.test(text)) {
    return {
      ...task,
      travelMinutes:
        task.travelMinutes && task.travelMinutes > 0
          ? task.travelMinutes
          : settings.restaurantTravelMinutes,
      recoveryMinutes:
        task.recoveryMinutes && task.recoveryMinutes > 0
          ? task.recoveryMinutes
          : settings.restaurantReturnMinutes,
    };
  }

  return task;
}

/** A location that is a link or a meeting app, not a place to travel to. */
const ONLINE_RE =
  /https?:\/\/|www\.|\bzoom\b|teams|google meet|meet\.google|webex|skype|whereby|\bonline\b|\bvirtual\b|\bremote\b|\bda remoto\b|\bcall\b|videochiamata/i;

export function isOnlineEvent(title: string | undefined, location: string | null | undefined): boolean {
  return ONLINE_RE.test(location ?? '') || /\bonline\b|\bwebinar\b|da remoto/i.test(title ?? '');
}

/** True when the event has a place Giulia physically has to get to. */
export function hasPhysicalLocation(
  title: string | undefined,
  location: string | null | undefined,
): boolean {
  return Boolean(location?.trim()) && !isOnlineEvent(title, location);
}

/**
 * Identity of a venue, so two events at the same place can share one journey.
 * Every university location collapses to one campus (rooms differ, the trip
 * does not); anything else compares its first address segment.
 */
export function venueKey(title: string | undefined, location: string | null | undefined): string | null {
  const text = `${title ?? ''} ${location ?? ''}`;
  if (UNIVERSITY_PLACE_RE.test(text) && !isOnlineEvent(title, location)) return 'university';
  if (!hasPhysicalLocation(title, location)) return null;
  return location!
    .split(',')[0]!
    .toLocaleLowerCase('it-IT')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Parses "fontys=20, ristorante da mario=15" into lowercase place → minutes. */
export function parsePlaceTravelMinutes(raw: string): Array<{ place: string; minutes: number }> {
  return raw
    .split(/[,;\n]/)
    .map((entry) => entry.split('='))
    .filter((parts) => parts.length === 2)
    .map(([place, minutes]) => ({
      place: place!.trim().toLocaleLowerCase('it-IT'),
      minutes: Number(minutes!.trim()),
    }))
    .filter((entry) => entry.place.length > 0 && Number.isFinite(entry.minutes) && entry.minutes >= 0);
}

const MODE_LABEL: Record<Settings['travelMode'], string> = {
  bike: 'in bici',
  public_transport: 'coi mezzi',
  car: 'in auto',
  walk: 'a piedi',
};

/** One-way journey for a generic located event: place override or default, plus buffer. */
export function genericTravelMinutes(location: string, settings: Settings): number {
  const text = location.toLocaleLowerCase('it-IT');
  const known = parsePlaceTravelMinutes(settings.placeTravelMinutes).find((entry) =>
    text.includes(entry.place),
  );
  return (known?.minutes ?? settings.defaultTravelMinutes) + settings.travelBufferMinutes;
}

/** Adds asymmetric travel/preparation around fixed commitments. */
export function applyBusyPersonalRules(
  commitment: BusyCommitment,
  settings: Settings,
): BusyCommitment {
  if (
    commitment.preparationBeforeMinutes !== undefined ||
    commitment.travelBeforeMinutes !== undefined ||
    commitment.travelAfterMinutes !== undefined
  ) {
    return commitment;
  }

  if (commitment.isShift) {
    return {
      ...commitment,
      area: 'general',
      travelBeforeMinutes: settings.restaurantTravelMinutes,
      travelAfterMinutes: settings.restaurantReturnMinutes,
    };
  }

  const text = `${commitment.title ?? ''} ${commitment.location ?? ''}`.toLowerCase();

  // First confirmed visit: leave home, 40 minutes body-shower/preparation,
  // 90 minutes each way. This is kept as place knowledge, not a fake generic
  // university commute and not a recurring habit inferred from one visit.
  if (DEN_BOSCH_RE.test(text)) {
    return {
      ...commitment,
      area: 'university',
      preparationBeforeMinutes: 40,
      travelBeforeMinutes: 90,
      travelAfterMinutes: 90,
      preparationLabel: `Preparazione — ${commitment.title ?? 'Den Bosch'}`,
      travelBeforeLabel: 'Viaggio casa → Den Bosch',
      travelAfterLabel: 'Viaggio Den Bosch → casa',
    };
  }

  if (UNIVERSITY_PLACE_RE.test(text)) {
    const travel = Math.max(20, settings.universityTravelMinutes);
    return {
      ...commitment,
      area: 'university',
      preparationBeforeMinutes: settings.universityPreparationMinutes,
      travelBeforeMinutes: travel,
      travelAfterMinutes: travel,
      preparationLabel: 'Preparazione università',
      travelBeforeLabel: 'Viaggio casa → università',
      travelAfterLabel: 'Viaggio università → casa',
    };
  }

  // Any other event with a real place: a dentist, a dinner, a workshop. The
  // journey is reserved both ways; online meetings and events without a
  // location keep only the generic margin.
  if (hasPhysicalLocation(commitment.title, commitment.location)) {
    const minutes = genericTravelMinutes(commitment.location!, settings);
    const place = commitment.location!.split(',')[0]!.trim();
    const mode = MODE_LABEL[settings.travelMode] ?? '';
    return {
      ...commitment,
      travelBeforeMinutes: minutes,
      travelAfterMinutes: minutes,
      travelBeforeLabel: `Viaggio ${mode} → ${place}`.replace(/\s+/g, ' '),
      travelAfterLabel: `Rientro ${mode} da ${place}`.replace(/\s+/g, ' '),
    };
  }

  return commitment;
}

/** Two events closer than this at the same venue are one outing. */
const SAME_VENUE_GAP_MS = 60 * 60_000;

/**
 * Back-to-back events at the same place need one journey there and one back,
 * not a round trip each: the first loses its return, the second its outward
 * trip and its preparation.
 */
export function mergeSameVenueJourneys(commitments: BusyCommitment[]): void {
  const located = commitments
    .map((item) => ({ item, venue: venueKey(item.title, item.location) }))
    .filter((entry): entry is { item: BusyCommitment; venue: string } => entry.venue !== null)
    .sort((a, b) => a.item.start - b.item.start);

  for (let i = 1; i < located.length; i++) {
    const previous = located[i - 1]!;
    const current = located[i]!;
    const gap = current.item.start - previous.item.end;
    if (previous.venue !== current.venue || gap < 0 || gap > SAME_VENUE_GAP_MS) continue;

    previous.item.travelAfterMinutes = 0;
    previous.item.travelAfterLabel = undefined;
    current.item.travelBeforeMinutes = 0;
    current.item.travelBeforeLabel = undefined;
    current.item.preparationBeforeMinutes = 0;
    current.item.preparationLabel = undefined;
  }
}

/**
 * Resolves journeys that depend on the next real destination. A university
 * context remains usable for project work, but its boundary buffers still
 * represent getting ready and physically travelling there and back.
 */
export function applyCalendarPersonalRules(
  commitments: BusyCommitment[],
  contexts: PlanningContext[],
  settings: Settings,
  timezone: string,
): { busy: BusyCommitment[]; contexts: PlanningContext[] } {
  const busy = commitments.map((item) => applyBusyPersonalRules(item, settings));
  const normalizedContexts = contexts.map((context) => ({
    ...context,
    ...applyBusyPersonalRules(context, settings),
  }));

  const universityWindows: BusyCommitment[] = [
    ...busy.filter((item) => item.area === 'university'),
    ...normalizedContexts.filter((item) => item.area === 'university'),
  ];

  for (const university of universityWindows) {
    const nextShift = busy
      .filter(
        (item) =>
          item.isShift &&
          item.start >= university.end &&
          item.start - university.end <= 2 * 60 * 60_000 &&
          localDateKey(item.start, timezone) ===
            localDateKey(university.end, timezone),
      )
      .sort((a, b) => a.start - b.start)[0];

    if (!nextShift) continue;
    university.travelAfterMinutes = settings.universityToWorkTravelMinutes;
    university.travelAfterLabel = 'Viaggio università → lavoro';
    nextShift.travelBeforeMinutes = 0;
    nextShift.travelBeforeLabel = undefined;
  }

  mergeSameVenueJourneys([...busy, ...normalizedContexts]);

  return { busy, contexts: normalizedContexts };
}

export function reservationExplanation(task: SchedulableTask): string {
  const activity = task.plannedMinutes;
  const travel = task.travelMinutes ?? 0;
  const preparation = task.preparationMinutes ?? 0;
  const recovery = task.recoveryMinutes ?? 0;
  const total = activity + travel + preparation + recovery;
  return `${total} min riservati: ${activity} attività + ${travel} viaggio + ${preparation} preparazione + ${recovery} rientro/recupero.`;
}

/** The names generated travel/preparation blocks carry; shared with the engine. */
export function commitmentBufferLabels(commitment: BusyCommitment): {
  preparation: string;
  travelBefore: string;
  travelAfter: string;
} {
  const title = commitment.title ?? 'Impegno';
  return {
    preparation: commitment.preparationLabel ?? `Preparazione — ${title}`,
    travelBefore: commitment.travelBeforeLabel ?? `Viaggio verso — ${title}`,
    travelAfter: commitment.travelAfterLabel ?? `Rientro — ${title}`,
  };
}

function bufferKey(ts: number, title: string, timezone: string): string {
  const normalized = title.trim().toLocaleLowerCase('it-IT').replace(/\s+/g, ' ');
  return `buffer:${localDateKey(ts, timezone)}:${normalized}`;
}

/**
 * Drops the travel/preparation components Giulia deleted by hand. The minutes
 * go to zero rather than back to the generic event buffer: deleting "Viaggio
 * verso — Call" says there is no journey, so the time is genuinely free.
 */
export function withoutSuppressedBuffers<T extends BusyCommitment>(
  commitments: T[],
  suppressed: Set<string>,
  timezone: string,
): T[] {
  if (suppressed.size === 0) return commitments;
  return commitments.map((commitment) => {
    const labels = commitmentBufferLabels(commitment);
    const outwardMs = (commitment.travelBeforeMinutes ?? 0) * 60_000;
    const preparationMs = (commitment.preparationBeforeMinutes ?? 0) * 60_000;
    const next = { ...commitment };
    if (
      preparationMs > 0 &&
      suppressed.has(
        bufferKey(commitment.start - outwardMs - preparationMs, labels.preparation, timezone),
      )
    ) {
      next.preparationBeforeMinutes = 0;
    }
    if (
      outwardMs > 0 &&
      suppressed.has(bufferKey(commitment.start - outwardMs, labels.travelBefore, timezone))
    ) {
      next.travelBeforeMinutes = 0;
    }
    if (
      (commitment.travelAfterMinutes ?? 0) > 0 &&
      suppressed.has(bufferKey(commitment.end, labels.travelAfter, timezone))
    ) {
      next.travelAfterMinutes = 0;
    }
    return next;
  });
}
