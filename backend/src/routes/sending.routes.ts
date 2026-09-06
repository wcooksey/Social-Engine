import { Router } from 'express';
import { prisma } from '../config/database';
import { roleMiddleware } from '../middleware/auth.middleware';
import { AppError, asyncHandler } from '../middleware/error.middleware';
import { encrypt, isEncryptionConfigured } from '../utils/encryption';
import {
  adoptLegacyDomain,
  getSendingOverview,
  verifyDomainDns,
} from '../services/sender.service';
import { healthByMailbox } from '../services/sender-health.service';

/**
 * Sending infrastructure: the domains mail leaves from, the addresses on them,
 * and the pools that tie those addresses to playbooks.
 *
 * Reads are open to any member; anything that changes what the platform sends
 * as is owner/admin only.
 */
const router = Router();

const writeAccess = roleMiddleware('OWNER', 'ADMIN');

const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;

function cleanDomain(raw: unknown): string {
  const value = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  if (!DOMAIN_RE.test(value)) throw new AppError('Enter a valid domain, e.g. outreach-acme.com');
  return value;
}

/** Bounded integer field, or undefined when the caller didn't send it. */
function capValue(body: Record<string, unknown>, key: string, min: number, max: number) {
  if (!(key in body)) return undefined;
  const parsed = Number(body[key]);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new AppError(`${key} must be a whole number between ${min} and ${max}`);
  }
  return parsed;
}

async function requireDomain(id: string, organizationId: string) {
  const domain = await prisma.emailDomain.findFirst({ where: { id, organizationId } });
  if (!domain) throw new AppError('Domain not found', 404);
  return domain;
}

async function requireMailbox(id: string, organizationId: string) {
  const mailbox = await prisma.mailbox.findFirst({ where: { id, organizationId } });
  if (!mailbox) throw new AppError('Mailbox not found', 404);
  return mailbox;
}

// --- Overview -------------------------------------------------------------

/**
 * Domains, mailboxes, today's capacity and each mailbox's rolling health.
 *
 * The two are composed here rather than inside the overview so that the sender
 * and health services stay independent of each other.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const overview = await getSendingOverview(req.user!.organizationId);
    const mailboxIds = overview.domains.flatMap((d) => d.mailboxes.map((m) => m.id));
    const health = await healthByMailbox(new Date(), mailboxIds);

    res.json({
      success: true,
      data: {
        ...overview,
        domains: overview.domains.map((domain) => ({
          ...domain,
          mailboxes: domain.mailboxes.map((mailbox) => ({
            ...mailbox,
            health: health.get(mailbox.id) ?? null,
          })),
        })),
      },
    });
  })
);

/**
 * Bring the existing single-domain Mailgun setup into these tables so new
 * domains can be added alongside it without changing what already sends.
 */
router.post(
  '/adopt',
  writeAccess,
  asyncHandler(async (req, res) => {
    const domain = await adoptLegacyDomain(req.user!.organizationId);
    if (!domain) {
      throw new AppError(
        'Nothing to adopt — either Mailgun is not configured, or that domain is already registered.'
      );
    }
    res.json({ success: true, data: { domain } });
  })
);

// --- Domains --------------------------------------------------------------

router.post(
  '/domains',
  writeAccess,
  asyncHandler(async (req, res) => {
    const organizationId = req.user!.organizationId;
    const domain = cleanDomain(req.body?.domain);
    const purpose = req.body?.purpose === 'TRANSACTIONAL' ? 'TRANSACTIONAL' : 'COLD_OUTREACH';

    // Domains are globally unique so inbound replies route unambiguously; say so
    // rather than leaking whether another tenant holds it.
    const taken = await prisma.emailDomain.findUnique({ where: { domain } });
    if (taken) throw new AppError('That domain is already registered.');

    // Also refuse a domain another organization is already sending from under
    // the legacy single-domain settings. They have no EmailDomain row to collide
    // with, and without this check their domain could be registered out from
    // under them.
    const heldElsewhere = await prisma.orgSetting.findFirst({
      where: { key: 'MAILGUN_DOMAIN', value: domain, organizationId: { not: organizationId } },
      select: { id: true },
    });
    if (heldElsewhere) throw new AppError('That domain is already registered.');

    const apiKey = String(req.body?.apiKey || '').trim();
    if (apiKey && !isEncryptionConfigured()) {
      throw new AppError('APP_ENCRYPTION_KEY is not configured — cannot store a per-domain key.');
    }

    const created = await prisma.emailDomain.create({
      data: {
        organizationId,
        domain,
        purpose,
        ...(apiKey ? { apiKeyEncrypted: encrypt(apiKey) } : {}),
      },
    });
    res.status(201).json({
      success: true,
      data: {
        domain: created,
        // It starts PENDING and cannot send until the provider confirms DNS.
        next: `Add this domain in Mailgun, publish the DNS records it gives you at your registrar, then POST /api/sending/domains/${created.id}/verify.`,
      },
    });
  })
);

router.post(
  '/domains/:id/verify',
  writeAccess,
  asyncHandler(async (req, res) => {
    await requireDomain(req.params.id, req.user!.organizationId);
    try {
      const domain = await verifyDomainDns(req.params.id);
      res.json({ success: true, data: { domain } });
    } catch (err) {
      throw new AppError(
        `Could not verify with Mailgun: ${err instanceof Error ? err.message : 'unknown error'}`
      );
    }
  })
);

router.patch(
  '/domains/:id',
  writeAccess,
  asyncHandler(async (req, res) => {
    const existing = await requireDomain(req.params.id, req.user!.organizationId);
    const body = req.body || {};

    // PENDING is set by verification, not by hand — claiming a domain is ready
    // when its DNS is unverified only produces rejected sends.
    const allowedStatuses = ['WARMING', 'ACTIVE', 'PAUSED', 'RETIRED'] as const;
    const status = body.status
      ? allowedStatuses.find((s) => s === body.status)
      : undefined;
    if (body.status && !status) {
      throw new AppError(`status must be one of ${allowedStatuses.join(', ')}`);
    }
    // Keyed on the verification flags rather than the current status: routing a
    // domain PENDING -> PAUSED -> ACTIVE would otherwise walk an unverified
    // domain into service, where every send is rejected by the provider and
    // surfaces on lead timelines as a delivery error instead of a setup problem.
    const activating = status === 'WARMING' || status === 'ACTIVE';
    // A domain that has already sent successfully has proved its DNS by doing
    // the thing the check exists to predict. Adopted domains carry that history
    // but no verification flags, and would otherwise be impossible to resume
    // once paused without a separate round-trip to the provider.
    const provenBySending = existing.firstSendAt !== null;
    const authenticated = existing.spfOk === true && existing.dkimOk === true;
    if (activating && !authenticated && !provenBySending) {
      throw new AppError('Verify this domain’s DNS before activating it.');
    }

    const domain = await prisma.emailDomain.update({
      where: { id: existing.id },
      data: {
        ...(status ? { status } : {}),
        ...(body.purpose === 'TRANSACTIONAL' || body.purpose === 'COLD_OUTREACH'
          ? { purpose: body.purpose }
          : {}),
        ...('pausedReason' in body
          ? { pausedReason: String(body.pausedReason || '').trim() || null }
          : {}),
        // Bringing a domain back clears why it stopped; leaving the old reason
        // in place would report a live domain as broken.
        ...(status && status !== 'PAUSED' ? { pausedReason: null } : {}),
      },
    });

    // The breaker pulls a domain when its mailboxes are health-paused, and those
    // cooldowns outlive the domain pause. Resuming the domain without clearing
    // them means the next sweep re-reads the same trip and pauses it again
    // minutes later — the operator's action would never appear to take.
    if (activating) {
      await prisma.mailbox.updateMany({
        where: { domainId: existing.id, status: 'PAUSED', pausedUntil: { not: null } },
        data: {
          status: 'WARMING',
          pausedUntil: null,
          pausedReason: null,
          warmupStartedAt: new Date(),
        },
      });
    }
    res.json({ success: true, data: { domain } });
  })
);

router.delete(
  '/domains/:id',
  writeAccess,
  asyncHandler(async (req, res) => {
    const domain = await requireDomain(req.params.id, req.user!.organizationId);
    await prisma.emailDomain.delete({ where: { id: domain.id } });
    res.json({ success: true, data: { deleted: true } });
  })
);

// --- Mailboxes ------------------------------------------------------------

router.post(
  '/domains/:id/mailboxes',
  writeAccess,
  asyncHandler(async (req, res) => {
    const organizationId = req.user!.organizationId;
    const domain = await requireDomain(req.params.id, organizationId);

    const localPart = String(req.body?.localPart || '')
      .trim()
      .toLowerCase();
    if (!LOCAL_PART_RE.test(localPart)) {
      throw new AppError('localPart must be the part before the @, e.g. "dana"');
    }
    const address = `${localPart}@${domain.domain}`;
    if (await prisma.mailbox.findUnique({ where: { address } })) {
      throw new AppError(`${address} already exists.`);
    }

    const mailbox = await prisma.mailbox.create({
      data: {
        organizationId,
        domainId: domain.id,
        localPart,
        address,
        displayName: String(req.body?.displayName || '').trim() || null,
        replyTo: String(req.body?.replyTo || '').trim() || null,
        dailyCapStart: capValue(req.body || {}, 'dailyCapStart', 1, 200) ?? undefined,
        dailyCapMax: capValue(req.body || {}, 'dailyCapMax', 1, 1000) ?? undefined,
        warmupGrowthPct: capValue(req.body || {}, 'warmupGrowthPct', 0, 200) ?? undefined,
        hourlyCap: capValue(req.body || {}, 'hourlyCap', 1, 500) ?? undefined,
      },
    });
    res.status(201).json({ success: true, data: { mailbox } });
  })
);

router.patch(
  '/mailboxes/:id',
  writeAccess,
  asyncHandler(async (req, res) => {
    const existing = await requireMailbox(req.params.id, req.user!.organizationId);
    const body = req.body || {};

    const allowedStatuses = ['WARMING', 'ACTIVE', 'PAUSED', 'RETIRED'] as const;
    const status = body.status ? allowedStatuses.find((s) => s === body.status) : undefined;
    if (body.status && !status) {
      throw new AppError(`status must be one of ${allowedStatuses.join(', ')}`);
    }

    // A health pause carries a cooldown; a pause a person sets must not. Any
    // explicit status change clears it, so that pausing an already-auto-paused
    // mailbox by hand makes the pause stick instead of being auto-resumed when
    // the machine's cooldown happens to elapse.
    const wasHealthPaused = !!existing.pausedReason || existing.pausedUntil !== null;

    const mailbox = await prisma.mailbox.update({
      where: { id: existing.id },
      data: {
        ...(status ? { status: wasHealthPaused && status === 'ACTIVE' ? 'WARMING' : status, pausedUntil: null, pausedReason: null } : {}),
        // Coming back from a health pause restarts the warm-up window. Without
        // it the next sweep re-reads the very days that caused the pause and
        // pauses the mailbox again within minutes, forever.
        ...(status && status !== 'PAUSED' && wasHealthPaused
          ? { warmupStartedAt: new Date() }
          : {}),
        ...('displayName' in body
          ? { displayName: String(body.displayName || '').trim() || null }
          : {}),
        ...('replyTo' in body ? { replyTo: String(body.replyTo || '').trim() || null } : {}),
        ...('pausedReason' in body
          ? { pausedReason: String(body.pausedReason || '').trim() || null }
          : {}),
        // Resuming by hand clears the reason a health pause recorded.
        ...(status && status !== 'PAUSED' ? { pausedReason: null } : {}),
        dailyCapStart: capValue(body, 'dailyCapStart', 1, 200),
        dailyCapMax: capValue(body, 'dailyCapMax', 1, 1000),
        warmupGrowthPct: capValue(body, 'warmupGrowthPct', 0, 200),
        hourlyCap: capValue(body, 'hourlyCap', 1, 500),
      },
    });
    res.json({ success: true, data: { mailbox } });
  })
);

router.delete(
  '/mailboxes/:id',
  writeAccess,
  asyncHandler(async (req, res) => {
    const mailbox = await requireMailbox(req.params.id, req.user!.organizationId);
    await prisma.mailbox.delete({ where: { id: mailbox.id } });
    res.json({ success: true, data: { deleted: true } });
  })
);

// --- Pools ----------------------------------------------------------------

const poolShape = {
  id: true,
  name: true,
  createdAt: true,
  mailboxes: { select: { mailbox: { select: { id: true, address: true, status: true } } } },
  _count: { select: { playbooks: true } },
} as const;

router.get(
  '/pools',
  asyncHandler(async (req, res) => {
    const pools = await prisma.senderPool.findMany({
      where: { organizationId: req.user!.organizationId },
      select: poolShape,
      orderBy: { name: 'asc' },
    });
    res.json({ success: true, data: { pools } });
  })
);

/** Mailbox ids that genuinely belong to this org — silently drops anything else. */
async function ownedMailboxIds(raw: unknown, organizationId: string): Promise<string[]> {
  if (!Array.isArray(raw)) return [];
  const ids = raw.map((id) => String(id));
  const owned = await prisma.mailbox.findMany({
    where: { id: { in: ids }, organizationId },
    select: { id: true },
  });
  return owned.map((m) => m.id);
}

router.post(
  '/pools',
  writeAccess,
  asyncHandler(async (req, res) => {
    const organizationId = req.user!.organizationId;
    const name = String(req.body?.name || '').trim();
    if (!name) throw new AppError('name is required');
    if (await prisma.senderPool.findFirst({ where: { organizationId, name } })) {
      throw new AppError('A pool with that name already exists.');
    }
    const mailboxIds = await ownedMailboxIds(req.body?.mailboxIds, organizationId);
    const pool = await prisma.senderPool.create({
      data: {
        organizationId,
        name,
        mailboxes: { create: mailboxIds.map((mailboxId) => ({ mailboxId })) },
      },
      select: poolShape,
    });
    res.status(201).json({ success: true, data: { pool } });
  })
);

router.patch(
  '/pools/:id',
  writeAccess,
  asyncHandler(async (req, res) => {
    const organizationId = req.user!.organizationId;
    const existing = await prisma.senderPool.findFirst({
      where: { id: req.params.id, organizationId },
    });
    if (!existing) throw new AppError('Pool not found', 404);

    const name = 'name' in (req.body || {}) ? String(req.body.name || '').trim() : undefined;
    if (name === '') throw new AppError('name cannot be blank');

    // Membership is replaced wholesale when the caller sends a list, so the
    // request body is the pool's full contents rather than a delta.
    const replacing = Array.isArray(req.body?.mailboxIds);
    const mailboxIds = replacing
      ? await ownedMailboxIds(req.body.mailboxIds, organizationId)
      : [];

    const pool = await prisma.senderPool.update({
      where: { id: existing.id },
      data: {
        ...(name ? { name } : {}),
        ...(replacing
          ? { mailboxes: { deleteMany: {}, create: mailboxIds.map((mailboxId) => ({ mailboxId })) } }
          : {}),
      },
      select: poolShape,
    });
    res.json({ success: true, data: { pool } });
  })
);

router.delete(
  '/pools/:id',
  writeAccess,
  asyncHandler(async (req, res) => {
    const organizationId = req.user!.organizationId;
    const pool = await prisma.senderPool.findFirst({
      where: { id: req.params.id, organizationId },
    });
    if (!pool) throw new AppError('Pool not found', 404);
    await prisma.senderPool.delete({ where: { id: pool.id } });
    res.json({ success: true, data: { deleted: true } });
  })
);

export default router;
