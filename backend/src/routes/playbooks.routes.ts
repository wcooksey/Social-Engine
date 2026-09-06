import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { AppError, asyncHandler } from '../middleware/error.middleware';
import { forgetIcpCache } from '../services/icp.service';

const router = Router();

const includeRelations = {
  group: { select: { id: true, name: true } },
  campaign: { select: { id: true, name: true } },
  senderPool: { select: { id: true, name: true } },
  gmailAccount: { select: { id: true, emailAddress: true, status: true } },
  // How many Engine conversations are filed under this playbook — the count
  // that makes each card a doorway into its own thread history.
  _count: { select: { engineChats: true } },
} as const;

// Sender identity — all optional, blank clears the field back to the org default.
const IDENTITY_FIELDS = [
  'identityName',
  'identityOrgName',
  'identityTitle',
  'identityEmail',
  'identitySignature',
  'identityPostalAddress',
] as const;

/** Trimmed identity values from a request body; empty string means "clear". */
function identityData(body: Record<string, unknown>): Record<string, string | null> {
  const data: Record<string, string | null> = {};
  for (const key of IDENTITY_FIELDS) {
    if (!(key in body)) continue;
    const raw = body[key];
    const value = raw === null || raw === undefined ? '' : String(raw).trim();
    if (key === 'identityEmail' && value && !value.includes('@')) {
      throw new AppError('Reply-to must be a valid email address');
    }
    data[key] = value || null;
  }
  return data;
}

/**
 * Which system carries this playbook's email, and — on the inbox transport —
 * which inbox.
 *
 * The two fields are validated together because half of the pair is a
 * misconfiguration: a playbook set to GMAIL with no inbox connected sends
 * nothing, and one left on MAILGUN while naming an inbox is a setting that
 * looks applied and isn't. Selecting an inbox implies the transport, which is
 * what an operator means by picking one.
 */
async function transportData(
  body: Record<string, unknown>,
  organizationId: string
): Promise<{ emailTransport?: 'MAILGUN' | 'GMAIL'; gmailAccountId?: string | null }> {
  const wantsTransport = 'emailTransport' in body;
  const wantsAccount = 'gmailAccountId' in body;
  if (!wantsTransport && !wantsAccount) return {};

  const accountId = wantsAccount ? String(body.gmailAccountId || '').trim() : '';
  const transport = wantsTransport
    ? String(body.emailTransport || '').toUpperCase()
    : accountId
      ? 'GMAIL'
      : undefined;

  if (transport && transport !== 'MAILGUN' && transport !== 'GMAIL') {
    throw new AppError('emailTransport must be MAILGUN or GMAIL');
  }

  if (transport === 'GMAIL') {
    if (accountId) {
      const account = await prisma.gmailAccount.findFirst({
        where: { id: accountId, organizationId },
      });
      if (!account) throw new AppError('Gmail inbox not found');
      return { emailTransport: 'GMAIL', gmailAccountId: account.id };
    }
    // No inbox named: allowed only while the org has exactly one, since the
    // resolver refuses to guess between several at send time and the playbook
    // would silently stop sending.
    const connected = await prisma.gmailAccount.count({ where: { organizationId } });
    if (connected === 0) {
      throw new AppError(
        'No Gmail inbox is connected — connect one under Settings → Sending before routing a playbook through it.'
      );
    }
    if (connected > 1 && !wantsAccount) {
      throw new AppError('Pick which connected Gmail inbox this playbook sends from.');
    }
    return { emailTransport: 'GMAIL', gmailAccountId: accountId || null };
  }

  // Back to Mailgun: the inbox is cleared with it, so a later switch back can't
  // silently reuse an inbox the operator has since forgotten about.
  return { emailTransport: 'MAILGUN', gmailAccountId: null };
}

/**
 * Resolve the sender pool a playbook sends through. Blank clears it back to
 * "any cold-outreach mailbox". Validated against this org so a foreign pool id
 * can't attach outreach to someone else's mailboxes.
 */
async function senderPoolData(
  body: Record<string, unknown>,
  organizationId: string
): Promise<{ senderPoolId?: string | null }> {
  if (!('senderPoolId' in body)) return {};
  const id = String(body.senderPoolId || '').trim();
  if (!id) return { senderPoolId: null };
  const pool = await prisma.senderPool.findFirst({ where: { id, organizationId } });
  if (!pool) throw new AppError('Sender pool not found');
  return { senderPoolId: pool.id };
}

/**
 * The ICP block, validated into a known shape.
 *
 * Stored as JSON so a vertical's definition is a row rather than a deploy, but
 * validated on the way in so a typo cannot silently switch a list off — an
 * empty decision-maker list would grade every lead as having no decision maker.
 */
const ICP_LIST_FIELDS = [
  'targetTitles',
  'decisionMakerPatterns',
  'forbiddenFormIntents',
  'sourcingHints',
] as const;

type IcpUpdate = { icp?: Prisma.InputJsonValue | typeof Prisma.DbNull };

function icpData(body: Record<string, unknown>): IcpUpdate {
  if (!('icp' in body)) return {};
  const raw = body.icp;
  // DbNull rather than null: Prisma distinguishes "SQL NULL" from "JSON null".
  if (raw === null || raw === '') return { icp: Prisma.DbNull };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('icp must be an object');
  }

  const input = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ICP_LIST_FIELDS) {
    if (!(key in input)) continue;
    const value = input[key];
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
      throw new AppError(`${key} must be a list of strings`);
    }
    const items = value.map((v) => String(v).trim()).filter(Boolean);
    // An empty list would read as "nothing qualifies" rather than "use the
    // defaults", so it is stored as absent.
    if (items.length) out[key] = items;
  }
  if ('gatekeeperRoleLabel' in input) {
    const label = String(input.gatekeeperRoleLabel ?? '').trim();
    if (label) out.gatekeeperRoleLabel = label;
  }
  return { icp: Object.keys(out).length ? (out as Prisma.InputJsonValue) : Prisma.DbNull };
}

async function validateScopeTarget(
  body: Record<string, unknown>,
  organizationId: string
): Promise<void> {
  const scope = body.scope || 'GLOBAL';
  if (scope === 'GROUP') {
    if (!body.groupId) throw new AppError('groupId is required for GROUP scope');
    const group = await prisma.leadGroup.findFirst({
      where: { id: String(body.groupId), organizationId },
      select: { id: true },
    });
    if (!group) throw new AppError('Lead group not found', 404);
  }
  if (scope === 'CAMPAIGN') {
    if (!body.campaignId) throw new AppError('campaignId is required for CAMPAIGN scope');
    const campaign = await prisma.campaign.findFirst({
      where: { id: String(body.campaignId), organizationId },
      select: { id: true },
    });
    if (!campaign) throw new AppError('Campaign not found', 404);
  }
  if (scope === 'LEAD_STATUS' && !body.leadStatus)
    throw new AppError('leadStatus is required for LEAD_STATUS scope');
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const playbooks = await prisma.playbook.findMany({
      where: { organizationId: req.user!.organizationId },
      include: includeRelations,
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
    });
    res.json({ success: true, data: playbooks });
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    if (!req.body.name?.trim()) throw new AppError('name is required');
    if (!req.body.instructions?.trim()) throw new AppError('instructions are required');
    await validateScopeTarget(req.body, req.user!.organizationId);

    const playbook = await prisma.playbook.create({
      data: {
        organizationId: req.user!.organizationId,
        name: req.body.name.trim(),
        scope: req.body.scope || 'GLOBAL',
        groupId: req.body.scope === 'GROUP' ? req.body.groupId : null,
        campaignId: req.body.scope === 'CAMPAIGN' ? req.body.campaignId : null,
        leadStatus: req.body.scope === 'LEAD_STATUS' ? req.body.leadStatus : null,
        channel: req.body.channel || 'ALL',
        instructions: req.body.instructions,
        isActive: req.body.isActive ?? true,
        priority: req.body.priority ?? 100,
        ...identityData(req.body),
        ...icpData(req.body),
        ...(await senderPoolData(req.body, req.user!.organizationId)),
        ...(await transportData(req.body, req.user!.organizationId)),
      },
      include: includeRelations,
    });
    forgetIcpCache(req.user!.organizationId);
    res.status(201).json({ success: true, data: playbook });
  })
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.playbook.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!existing) throw new AppError('Playbook not found', 404);

    const data: Record<string, unknown> = {
      ...identityData(req.body),
      ...icpData(req.body),
      ...(await senderPoolData(req.body, req.user!.organizationId)),
      ...(await transportData(req.body, req.user!.organizationId)),
    };
    for (const key of ['name', 'instructions', 'channel', 'isActive', 'priority'] as const) {
      if (key in req.body) data[key] = req.body[key];
    }
    if ('scope' in req.body) {
      await validateScopeTarget({ ...req.body }, req.user!.organizationId);
      data.scope = req.body.scope;
      data.groupId = req.body.scope === 'GROUP' ? req.body.groupId : null;
      data.campaignId = req.body.scope === 'CAMPAIGN' ? req.body.campaignId : null;
      data.leadStatus = req.body.scope === 'LEAD_STATUS' ? req.body.leadStatus : null;
    }

    const playbook = await prisma.playbook.update({
      where: { id: existing.id },
      data,
      include: includeRelations,
    });
    forgetIcpCache(req.user!.organizationId);
    res.json({ success: true, data: playbook });
  })
);

/**
 * Delete several playbooks at once — clearing out a whole line of business
 * (every dealership protocol, say) without confirming one card at a time.
 * Scoped by organizationId in the same statement as the ids, so a foreign id in
 * the list simply matches nothing rather than deleting someone else's playbook.
 * Engine conversations filed under these survive: the relation is SetNull, so
 * they come back unfiled rather than disappearing with their instructions.
 */
router.post(
  '/bulk-delete',
  asyncHandler(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean) : [];
    if (ids.length === 0) throw new AppError('ids must be a non-empty array');

    const result = await prisma.playbook.deleteMany({
      where: { id: { in: ids }, organizationId: req.user!.organizationId },
    });
    res.json({ success: true, data: { deleted: result.count, requested: ids.length } });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.playbook.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!existing) throw new AppError('Playbook not found', 404);
    await prisma.playbook.delete({ where: { id: existing.id } });
    res.json({ success: true, data: null });
  })
);

export default router;
