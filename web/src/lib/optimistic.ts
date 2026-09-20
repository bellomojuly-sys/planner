/** Remove every split block belonging to a task as soon as it is completed. */
export function withoutTaskBlocks<T extends { taskId: string | null }>(
  blocks: T[],
  taskId: string,
): T[] {
  return blocks.filter((block) => block.taskId !== taskId);
}

/** Apply a checkbox change immediately while the server confirms it. */
export function withTaskStatus<T extends { id: string; status: string }>(
  tasks: T[],
  taskId: string,
  status: string,
): T[] {
  return tasks.map((task) => (task.id === taskId ? { ...task, status } : task));
}
