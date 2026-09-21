import type { Area, Energy, Settings } from '../db/schema';
import type { Interval } from '../lib/time';

export type Zone = 'morning' | 'afternoon' | 'evening';
export type PlanningClass = 'constraint' | 'objective' | 'preference';
export type ExecutionClass = 'you_do' | 'jarvis_does' | 'hybrid';
export type DecisionOutcome =
  | 'keep'
  | 'move'
  | 'postpone'
  | 'delegation_candidate'
  | 'needs_decision';

export interface PlanDecision {
  taskId: string;
  title: string;
  planningClass: PlanningClass;
  executionClass: ExecutionClass;
  outcome: DecisionOutcome;
  reason: string;
  /** Complete reservation: preparation + travel + activity + recovery. */
  reservedMinutes: number;
}

/** A contiguous run of workable time, tagged with the energy zone it sits in. */
export interface Slot extends Interval {
  zone: Zone;
  dayKey: string;
  /** When present, only these task areas may consume this contextual window. */
  allowedAreas?: Area[];
}

export interface SchedulableTask {
  id: string;
  title: string;
  area: Area;
  energy: Energy;
  location?: string | null;
  travelMinutes?: number;
  preparationMinutes?: number;
  recoveryMinutes?: number;
  flexibility?: 'fixed' | 'low' | 'medium' | 'high';
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
  /** 0 = now, 1 = next, 2 = later; null when the source has no horizon. */
  horizon?: number | null;
  /** JS weekdays (0 = Sunday) on which this kind of work belongs. */
  preferredWeekdays?: number[];
  /** When true, an undated task waits for a preferred day instead of leaking elsewhere. */
  strictPreferredWeekdays?: boolean;
}

export interface PlacedBlock {
  taskId: string | null;
  title: string;
  start: number;
  end: number;
  kind: 'task' | 'gym' | 'buffer';
  zone: Zone;
  partIndex: number;
  partCount: number;
  /** True when the task could not get its preferred energy zone. */
  zoneCompromised: boolean;
  /** Category is data, independent from the Google Calendar colour. */
  area?: Area;
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
  busy: Array<
    Interval & {
      title?: string;
      isShift?: boolean;
      location?: string | null;
      area?: Area;
      /** Explicit asymmetric padding beats the generic event buffer. */
      preparationBeforeMinutes?: number;
      travelBeforeMinutes?: number;
      travelAfterMinutes?: number;
      preparationLabel?: string;
      travelBeforeLabel?: string;
      travelAfterLabel?: string;
    }
  >;
  /** Productive context windows, such as Zelf Work, with an area boundary. */
  contexts?: Array<
    Interval & {
      allowedAreas: Area[];
      title?: string;
      location?: string | null;
      area?: Area;
      preparationBeforeMinutes?: number;
      travelBeforeMinutes?: number;
      travelAfterMinutes?: number;
      preparationLabel?: string;
      travelBeforeLabel?: string;
      travelAfterLabel?: string;
    }
  >;
  /** Blocks Giulia dragged by hand; treated as busy and re-emitted unchanged. */
  pinnedBlocks: PlacedBlock[];
  /**
   * End instants for prerequisites that are already finished or already
   * pinned. Without these, a dependent whose predecessor is done would be
   * treated as still blocked.
   */
  knownTaskEnds?: Map<string, number>;
  /** Completed workouts in the recent week still count toward the target. */
  completedGymAt?: number[];
  /**
   * Generated blocks Giulia deleted by hand (`gym:<day>`, `buffer:<day>:<title>`).
   * A suppressed gym day gets no session but still counts toward that week's
   * target: she chose to skip it, the scheduler must not compensate elsewhere.
   */
  suppressedKeys?: Set<string>;
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
  decisions: PlanDecision[];
  /** Deterministic five-line explanation generated from `decisions`. */
  briefing: string[];
  fixedCommitments: number;
  /** Per-task end instants, so dependents can be anchored. */
  taskEnd: Map<string, number>;
  warnings: string[];
}
