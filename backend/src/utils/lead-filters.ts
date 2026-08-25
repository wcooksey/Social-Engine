/**
 * Sentinel `groupId` meaning "leads that belong to no group at all".
 *
 * Deleting a lead group does not delete its leads — `Lead.group` is `SetNull`,
 * so they survive the group and become orphans. That is deliberate (a list is
 * a view over leads, not their owner), but until there was a way to ASK for
 * them they were invisible: absent from every group view, yet still counted in
 * every total, still enriched, still enrollable. The reported symptom is always
 * the same — "I deleted the group and the numbers didn't move."
 *
 * Lives in its own module because both the lead search and the enrichment stats
 * need it, and those two already import in one direction.
 */
export const UNGROUPED = 'none';

/** Translate a caller's groupId into a Prisma filter value. */
export function groupIdFilter(groupId: string | undefined): string | null | undefined {
  if (!groupId) return undefined;
  return groupId === UNGROUPED ? null : groupId;
}
