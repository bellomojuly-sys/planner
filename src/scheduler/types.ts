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
    | 'pinned_conflict';
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
  busy: Interval[];
  /** Blocks Giulia dragged by hand; treated as busy and re-emitted unchanged. */
  pinnedBlocks: PlacedBlock[];
  /**
   * End instants for prerequisites that are already finished or already
   * pinned. Without these, a dependent whose predecessor is done would be
   * treated as still blocked.
   */
  knownTaskEnds?: Map<string, number>;
}

export interface ScheduleResult {
  blocks: PlacedBlock[];
  unplaced: UnplacedTask[];
  /** Per-task end instants, so dependents can be anchored. */
  taskEnd: Map<string, number>;
  warnings: string[];
}
