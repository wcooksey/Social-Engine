import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';

/**
 * Who a line of business targets, and what it must not do.
 *
 * Job titles, decision-maker patterns and the forbidden-form list used to be
 * constants in code — tuned for one industry and shared by every playbook. That
 * made a second vertical a source edit rather than a configuration change, and
 * the edit silently re-graded the first vertical's leads on the way past.
 *
 * The definition now hangs off the playbook, which already carries scope,
 * priority, tone and sending identity for a line of business. Anything a
 * playbook leaves out falls back to the defaults below, so an organization that
 * never touches this keeps working exactly as before.
 */

export interface Icp {
  /** Titles worth searching for when hunting a decision maker. */
  targetTitles: string[];
  /** Lowercase fragments that mark a title as someone who can say yes. */
  decisionMakerPatterns: string[];
  /** Enquiry types that create an obligation and must never be submitted. */
  forbiddenFormIntents: string[];
  /** What the person answering the phone is usually called. */
  gatekeeperRoleLabel: string;
  /** Vocabulary that helps a sourcing query find the right businesses. */
  sourcingHints: string[];
  /** Playbook this came from, or null when these are the platform defaults. */
  playbookId: string | null;
  playbookName: string | null;
}

/**
 * Platform defaults — deliberately industry-neutral.
 *
 * These are the fallback for an organization that has not described its ICP.
 * The automotive specifics that used to live in code now belong in a playbook.
 */
export const DEFAULT_ICP: Omit<Icp, 'playbookId' | 'playbookName'> = {
  targetTitles: ['Owner', 'President', 'General Manager', 'Managing Director', 'Director'],
  decisionMakerPatterns: [
    'owner', 'founder', 'president', 'chief', 'ceo', 'cfo', 'coo', 'cto', 'cmo',
    'principal', 'partner', 'director', 'manager', 'head of', 'vp', 'vice president',
  ],
  forbiddenFormIntents: [
    'quote', 'pricing request', 'support ticket', 'warranty claim', 'job application',
  ],
  gatekeeperRoleLabel: 'receptionist',
  sourcingHints: [],
};

type IcpJson = Partial<Record<keyof typeof DEFAULT_ICP, unknown>>;

/** Read a string array out of stored JSON, ignoring anything malformed. */
function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean);
  return items.length ? items : null;
}

function merge(raw: unknown, playbookId: string | null, playbookName: string | null): Icp {
  const json = (raw && typeof raw === 'object' ? raw : {}) as IcpJson;
  return {
    targetTitles: stringList(json.targetTitles) ?? DEFAULT_ICP.targetTitles,
    decisionMakerPatterns:
      stringList(json.decisionMakerPatterns)?.map((p) => p.toLowerCase()) ??
      DEFAULT_ICP.decisionMakerPatterns,
    forbiddenFormIntents:
      stringList(json.forbiddenFormIntents) ?? DEFAULT_ICP.forbiddenFormIntents,
    gatekeeperRoleLabel:
      typeof json.gatekeeperRoleLabel === 'string' && json.gatekeeperRoleLabel.trim()
        ? json.gatekeeperRoleLabel.trim()
        : DEFAULT_ICP.gatekeeperRoleLabel,
    sourcingHints: stringList(json.sourcingHints) ?? DEFAULT_ICP.sourcingHints,
    playbookId,
    playbookName,
  };
}

/**
 * Active playbooks that carry an ICP, cached briefly.
 *
 * Enrichment re-scores a lead on every contact write, so this is on a hot path;
 * the window is short enough that an edit takes effect within seconds.
 */
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; rows: IcpPlaybook[] }>();

interface IcpPlaybook {
  id: string;
  name: string;
  scope: string;
  groupId: string | null;
  campaignId: string | null;
  leadStatus: string | null;
  priority: number;
  icp: unknown;
}

async function icpPlaybooks(organizationId: string): Promise<IcpPlaybook[]> {
  const hit = cache.get(organizationId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;

  const rows = await prisma.playbook.findMany({
    where: { organizationId, isActive: true, NOT: { icp: { equals: Prisma.DbNull } } },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true, name: true, scope: true, groupId: true,
      campaignId: true, leadStatus: true, priority: true, icp: true,
    },
  });
  cache.set(organizationId, { at: Date.now(), rows });
  return rows;
}

/** Drop the cache so an edit applies immediately. */
export function forgetIcpCache(organizationId: string): void {
  cache.delete(organizationId);
}

/** The ICP for a specific playbook, or the defaults when it has none. */
export async function resolveIcp(
  organizationId: string,
  playbookId?: string | null
): Promise<Icp> {
  if (!playbookId) return merge(null, null, null);
  const playbook = await prisma.playbook.findFirst({
    where: { id: playbookId, organizationId },
    select: { id: true, name: true, icp: true },
  });
  if (!playbook?.icp) return merge(null, null, null);
  return merge(playbook.icp, playbook.id, playbook.name);
}

/**
 * The ICP that applies to a lead, by the same scope rules as sending identity:
 * a scoped playbook beats a global one, then lowest priority number wins.
 */
export async function resolveIcpForLead(
  organizationId: string,
  lead: { id: string; groupId: string | null; status: string }
): Promise<Icp> {
  const playbooks = await icpPlaybooks(organizationId);
  if (playbooks.length === 0) return merge(null, null, null);

  const matches = playbooks.filter((p) => {
    if (p.scope === 'GLOBAL') return true;
    if (p.scope === 'GROUP') return !!p.groupId && p.groupId === lead.groupId;
    if (p.scope === 'LEAD_STATUS') return !!p.leadStatus && p.leadStatus === lead.status;
    // Campaign scope needs an enrolment lookup the hot path can't afford; a
    // campaign-scoped ICP is resolved from the run's playbook instead.
    return false;
  });
  if (matches.length === 0) return merge(null, null, null);

  const winner = matches.find((p) => p.scope !== 'GLOBAL') ?? matches[0];
  return merge(winner.icp, winner.id, winner.name);
}

/** Regex that matches a decision-maker title under this ICP. */
export function decisionMakerRegex(icp: Icp): RegExp {
  const escaped = icp.decisionMakerPatterns.map((p) =>
    p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  );
  return new RegExp(`(${escaped.join('|')})`, 'i');
}
