import { Request, Router } from 'express';
import { AppError, asyncHandler } from '../middleware/error.middleware';
import {
  applyToFilter,
  applyToRefs,
  listScheduled,
  parseRef,
  scheduledSummary,
  type ScheduledAction,
  type ScheduledFilter,
  type ScheduledKind,
  type ScheduledState,
} from '../services/scheduled.service';

/**
 * Everything the platform will do on its own, in one place, with a brake on it.
 *
 * Reads are open to any member — being able to see what is about to be sent in
 * your name is not a privileged action. Writes go through the same membership
 * check as the rest of the API; each one is scoped to the caller's org inside
 * the service, so an id from another tenant matches nothing.
 */
const router = Router();

const KINDS: ScheduledKind[] = ['MESSAGE', 'JOB', 'CADENCE', 'GOAL', 'REMINDER'];
const STATES: ScheduledState[] = ['DUE', 'SCHEDULED', 'PAUSED', 'RUNNING', 'NEEDS_APPROVAL'];
const ACTIONS: ScheduledAction[] = ['pause', 'resume', 'cancel'];

/** Accepts `MESSAGE,JOB` or a repeated query param, and rejects unknown values. */
function parseList<T extends string>(raw: unknown, allowed: T[], label: string): T[] | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const values = (Array.isArray(raw) ? raw : String(raw).split(','))
    .map((v) => String(v).trim().toUpperCase())
    .filter(Boolean);
  if (values.length === 0) return undefined;
  const bad = values.filter((v) => !allowed.includes(v as T));
  if (bad.length) throw new AppError(`Unknown ${label}: ${bad.join(', ')}`, 400);
  return values as T[];
}

function filterFromQuery(req: Request): ScheduledFilter {
  const withinRaw = req.query.withinHours;
  const withinHours = withinRaw ? Number(withinRaw) : undefined;
  if (withinHours !== undefined && (!Number.isFinite(withinHours) || withinHours <= 0)) {
    throw new AppError('withinHours must be a positive number', 400);
  }
  const search = String(req.query.q ?? '').trim();

  return {
    organizationId: req.user!.organizationId,
    kinds: parseList(req.query.kind, KINDS, 'kind'),
    states: parseList(req.query.state, STATES, 'state'),
    campaignId: (req.query.campaignId as string) || undefined,
    leadId: (req.query.leadId as string) || undefined,
    search: search || undefined,
    withinHours,
  };
}

/** The feed: one page of everything that will fire, oldest due time first. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const pageSize = Math.min(Math.max(parseInt(String(req.query.pageSize ?? '50'), 10) || 50, 1), 200);
    const data = await listScheduled(filterFromQuery(req), page, pageSize);
    res.json({ success: true, data });
  })
);

/** Counts, plus which layers are actively creating new work. */
router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const data = await scheduledSummary(req.user!.organizationId);
    res.json({ success: true, data });
  })
);

/**
 * Pause, resume or cancel — either an explicit selection (`refs`) or everything
 * matching a filter (`scope`).
 *
 * The scope form exists because a selection cannot express "all 4,000 due
 * touches in this campaign" without the client first paging through all of
 * them, and an operator stopping a runaway campaign should not have to.
 */
router.post(
  '/actions',
  asyncHandler(async (req, res) => {
    const action = String(req.body?.action || '').toLowerCase() as ScheduledAction;
    if (!ACTIONS.includes(action)) {
      throw new AppError(`action must be one of: ${ACTIONS.join(', ')}`, 400);
    }

    const refs = Array.isArray(req.body?.refs) ? (req.body.refs as unknown[]).map(String) : null;
    const scope = req.body?.scope as Record<string, unknown> | undefined;

    if (refs && scope) {
      throw new AppError('Send either refs or scope, not both — they would mean different row sets', 400);
    }

    if (refs) {
      if (refs.length === 0) throw new AppError('refs was empty', 400);
      if (refs.length > 1000) throw new AppError('Select at most 1000 rows, or use scope instead', 400);
      const bad = refs.filter((r) => !parseRef(r));
      if (bad.length) throw new AppError(`Unrecognized reference(s): ${bad.slice(0, 5).join(', ')}`, 400);
      const data = await applyToRefs(req.user!.organizationId, action, refs);
      res.json({ success: true, data });
      return;
    }

    if (!scope) throw new AppError('Send refs (a selection) or scope (a filter)', 400);

    const withinRaw = scope.withinHours;
    const withinHours = withinRaw === undefined || withinRaw === null || withinRaw === '' ? undefined : Number(withinRaw);
    if (withinHours !== undefined && (!Number.isFinite(withinHours) || withinHours <= 0)) {
      throw new AppError('scope.withinHours must be a positive number', 400);
    }

    const filter: ScheduledFilter = {
      organizationId: req.user!.organizationId,
      kinds: parseList(scope.kind ?? scope.kinds, KINDS, 'kind'),
      states: parseList(scope.state ?? scope.states, STATES, 'state'),
      campaignId: (scope.campaignId as string) || undefined,
      leadId: (scope.leadId as string) || undefined,
      search: (String(scope.q ?? scope.search ?? '').trim()) || undefined,
      withinHours,
    };

    // A scope with nothing narrowing it is "stop the whole organization". That
    // is a legitimate thing to want in a hurry, but not by accident — the client
    // has to say so.
    const unbounded =
      !filter.kinds?.length &&
      !filter.states?.length &&
      !filter.campaignId &&
      !filter.leadId &&
      !filter.search &&
      !filter.withinHours;
    if (unbounded && scope.confirmAll !== true) {
      throw new AppError(
        'That scope matches everything scheduled for this organization. Send scope.confirmAll = true if that is what you mean.',
        400
      );
    }

    const data = await applyToFilter(req.user!.organizationId, action, filter);
    res.json({ success: true, data });
  })
);

export default router;
