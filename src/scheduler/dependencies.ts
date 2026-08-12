import type { SchedulableTask } from './types';

export interface DepEdge {
  dependsOnId: string;
  lagMinutes: number;
}

export type DepMap = Map<string, DepEdge[]>;

/**
 * Kahn's algorithm with a priority tiebreak. Prerequisites always come out
 * before dependents; among tasks that are simultaneously ready, the most
 * urgent wins. This is what makes "Fase 15 → 16 → 17 → 18" fall out naturally
 * instead of needing special-case code.
 *
 * Edges pointing at tasks outside `tasks` (already finished, or in a database
 * we did not sync) are dropped rather than treated as unsatisfiable — a
 * completed prerequisite must not strand its dependents forever.
 */
export function topologicalOrder(
  tasks: SchedulableTask[],
  deps: DepMap,
  score: (t: SchedulableTask) => number,
): { order: SchedulableTask[]; cycles: string[][] } {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const t of tasks) {
    indegree.set(t.id, 0);
    dependents.set(t.id, []);
  }

  for (const t of tasks) {
    for (const edge of deps.get(t.id) ?? []) {
      if (!byId.has(edge.dependsOnId)) continue;
      indegree.set(t.id, (indegree.get(t.id) ?? 0) + 1);
      dependents.get(edge.dependsOnId)!.push(t.id);
    }
  }

  // Re-sorted on each pop rather than using a real heap: task counts here are
  // in the hundreds, and this keeps the ordering trivially inspectable.
  const ready = tasks.filter((t) => (indegree.get(t.id) ?? 0) === 0);
  const order: SchedulableTask[] = [];

  while (ready.length > 0) {
    ready.sort((a, b) => score(b) - score(a));
    const next = ready.shift()!;
    order.push(next);

    for (const depId of dependents.get(next.id) ?? []) {
      const remaining = (indegree.get(depId) ?? 0) - 1;
      indegree.set(depId, remaining);
      if (remaining === 0) ready.push(byId.get(depId)!);
    }
  }

  // Anything left has indegree > 0: a cycle. Report it and let the caller
  // decide — refusing to schedule everything because of one bad edge would be
  // worse than scheduling the rest.
  const cycles: string[][] = [];
  if (order.length < tasks.length) {
    const stuck = tasks.filter((t) => !order.includes(t));
    cycles.push(stuck.map((t) => t.id));
  }

  return { order, cycles };
}

/**
 * Every task transitively downstream of `rootIds`. When Fase 15 moves, this is
 * the set that has to move with it.
 */
export function collectDescendants(
  rootIds: string[],
  deps: DepMap,
): Set<string> {
  const reverse = new Map<string, string[]>();
  for (const [taskId, edges] of deps) {
    for (const e of edges) {
      const list = reverse.get(e.dependsOnId) ?? [];
      list.push(taskId);
      reverse.set(e.dependsOnId, list);
    }
  }

  const seen = new Set<string>();
  const queue = [...rootIds];

  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const child of reverse.get(cur) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }

  return seen;
}

/**
 * Infers "Fase 15 → Fase 16" chains from titles so Giulia does not have to
 * wire them by hand in Notion. Only consecutive phases within the same project
 * are linked, and only when no explicit edge already exists.
 */
const PHASE_RE =
  /\b(?:fase|phase|step|tappa|milestone)\s*[.:#-]?\s*(\d{1,3})\b/i;

export function parsePhase(
  title: string,
): { order: number; projectKey: string } | null {
  const match = PHASE_RE.exec(title);
  if (!match?.[1]) return null;

  const order = Number(match[1]);
  if (!Number.isFinite(order)) return null;

  // Whatever remains once the phase marker is stripped identifies the project,
  // so "MG Fase 15" and "MG Fase 16" group together.
  const projectKey = title
    .replace(PHASE_RE, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { order, projectKey: projectKey || 'progetto' };
}

export interface InferredEdge {
  taskId: string;
  dependsOnId: string;
}

export function inferPhaseEdges(
  tasks: Array<{ id: string; title: string; status: string }>,
  existing: DepMap,
): InferredEdge[] {
  const groups = new Map<string, Array<{ id: string; order: number }>>();

  for (const t of tasks) {
    if (t.status === 'done' || t.status === 'cancelled') continue;
    const parsed = parsePhase(t.title);
    if (!parsed) continue;
    const list = groups.get(parsed.projectKey) ?? [];
    list.push({ id: t.id, order: parsed.order });
    groups.set(parsed.projectKey, list);
  }

  const edges: InferredEdge[] = [];

  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.order - b.order);

    for (let i = 1; i < list.length; i++) {
      const cur = list[i]!;
      const prev = list[i - 1]!;
      const already = (existing.get(cur.id) ?? []).some(
        (e) => e.dependsOnId === prev.id,
      );
      if (!already) edges.push({ taskId: cur.id, dependsOnId: prev.id });
    }
  }

  return edges;
}
