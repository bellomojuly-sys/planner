import type { Area, Energy, Settings } from '../db/schema';
import type { Interval } from '../lib/time';

export type Zone = 'morning' | 'afternoon' | 'evening';

/** A contiguous run of workable time, tagged with the energy zone it sits in. */
export interface Slot extends Interval {
  zone: Zone;
  dayKey: string;
}

export interface SchedulableTask {
  id: string;
  title: string;
  area: Area;
  energy: Energy;
  priority: number;
  plannedMinutes: number;
  dueAt: number | null;
  earliestStartAt: number | null;
  splittable: boolean;
  pinned: boolean;
  isGym: boolean;
  status: string;
  projectKey: string | null;
  phaseOrder: number | null;
}

export interface PlacedBlock {
  taskId: string | null;
  title: string;
  start: number;
  end: number;
  kind: 'task' | 'gym';
  zone: Zone;
  partIndex: number;
  partCount: number;
  /** True when the task could not get its preferred energy zone. */
  zoneCompromised: boolean;
}

export interface UnplacedTask {
  taskId: string;
  title: string;
  reason:
    | 'no_free_time'
    | 'blocked_by_dependency'
    | 'past_due_window'
    | 'cycle'
    | 'pinned_conflict'
    | 'duplicate';
  detail?: string;
}

export interface ScheduleInput {
  now: number;
  horizonEnd: number;
  timezone: string;
  settings: Settings;
  tasks: SchedulableTask[];
  /** taskId → prerequisite task ids. */
  dependencies: Map<string, { dependsOnId: string; lagMinutes: number }[]>;
  /** Immovable commitments: shifts, lessons, exams. */
  busy: Array<Interval & { isShift?: boolean }>;
  /** Blocks Giulia dragged by hand; treated as busy and re-emitted unchanged. */
  pinnedBlocks: PlacedBlock[];
  /**
   * End instants for prerequisites that are already finished or already
   * pinned. Without these, a dependent whose predecessor is done would be
   * treated as still blocked.
   */
  knownTaskEnds?: Map<string, number>;
  /** How much task work a single day may hold. Defaults in `DEFAULT_LOAD`. */
  load?: DailyLoad;
}

/**
 * The daily ceiling that stops the scheduler from front-loading: without it a
 * greedy pass fills the first free day to the brim and leaves the rest empty.
 * Decided in `dl-how-planner-spreads-the-week`.
 */
export interface DailyLoad {
  /** Task minutes on a day without a shift. */
  freeDayMinutes: number;
  /** Task minutes on a day with a shift. */
  shiftDayMinutes: number;
  /** Largest share of a day one area may take, 0–1. */
  areaShare: number;
}

export const DEFAULT_LOAD: DailyLoad = {
  freeDayMinutes: 240,
  shiftDayMinutes: 120,
  areaShare: 0.5,
};

export interface ScheduleResult {
  blocks: PlacedBlock[];
  unplaced: UnplacedTask[];
  /** Per-task end instants, so dependents can be anchored. */
  taskEnd: Map<string, number>;
  warnings: string[];
}
