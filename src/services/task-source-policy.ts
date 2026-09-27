/**
 * Local tasks are always active. Imported tasks participate only while their
 * source is enabled, so switching off Notion is reversible and does not delete
 * historical rows or turn an unavailable integration into a planning blocker.
 */
export function isTaskSourceEnabled(
  sourceId: string | null,
  enabledSourceIds: ReadonlySet<string>,
): boolean {
  return sourceId === null || enabledSourceIds.has(sourceId);
}
