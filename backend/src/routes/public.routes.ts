import { Router } from 'express';
import { prisma } from '../config/database';
import { AppError, asyncHandler } from '../middleware/error.middleware';
import { book, computeSlots, getActiveLink } from '../services/booking.service';
import { recomputeLeadEnrichment } from '../services/lead-enrichment.service';
import { verifyToken } from '../utils/signing';
import { flagSiblingLocations, suppress } from '../services/suppression.service';

/**
 * Public, unauthenticated endpoints that leads interact with directly:
 * self-serve booking pages and one-click email unsubscribe.
 */
const router = Router();

// --- Booking -------------------------------------------------------------

router.get(
  '/booking/:slug',
  asyncHandler(async (req, res) => {
    const link = await getActiveLink(req.params.slug);
    if (!link) throw new AppError('Booking link not found', 404);
    const org = await prisma.organization.findUnique({
      where: { id: link.organizationId },
      select: { name: true },
    });
    const slots = await computeSlots(link, 14);
    res.json({
      success: true,
      data: {
        title: link.title,
        description: link.description,
        durationMinutes: link.durationMinutes,
        timezone: link.timezone,
        organizationName: org?.name,
        slots,
      },
    });
  })
);

router.post(
  '/booking/:slug',
  asyncHandler(async (req, res) => {
    const { name, email, phone, startIso, notes } = req.body ?? {};
    try {
      const result = await book({ slug: req.params.slug, name, email, phone, startIso, notes });
      res.status(201).json({ success: true, data: result });
    } catch (err) {
      throw new AppError((err as Error).message, 400);
    }
  })
);

// --- Unsubscribe ---------------------------------------------------------

async function applyUnsubscribe(token: string): Promise<boolean> {
  const contactId = verifyToken(token);
  if (!contactId) return false;
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact) return false;
  await prisma.contact.update({ where: { id: contact.id }, data: { optedOut: true } });
  await prisma.lead.update({ where: { id: contact.leadId }, data: { doNotContact: true } });
  await recomputeLeadEnrichment(contact.leadId);
  // The durable record. The row flags above are what the send tools read, but
  // they die with the rows; this survives deletion and re-sourcing.
  if (contact.email) {
    await suppress({
      organizationId: contact.organizationId,
      kind: 'EMAIL',
      value: contact.email,
      reason: 'Unsubscribed via email link',
      source: 'unsubscribe_link',
      originLeadId: contact.leadId,
    });
  }
  await prisma.activity.create({
    data: {
      organizationId: contact.organizationId,
      leadId: contact.leadId,
      type: 'STATUS_CHANGE',
      summary: `${contact.email || 'Contact'} unsubscribed via email link — lead marked do-not-contact.`,
      payload: { optOut: true, via: 'unsubscribe_link' },
    },
  });
  // Sibling locations sharing this website go on hold pending a check that
  // they are separate businesses.
  await flagSiblingLocations(
    contact.organizationId,
    contact.leadId,
    'unsubscribed via email link'
  ).catch(() => 0);
  return true;
}

// One-click unsubscribe (RFC 8058 List-Unsubscribe-Post lands here).
router.post(
  '/unsubscribe',
  asyncHandler(async (req, res) => {
    const token = String(req.query.c || req.body?.c || '');
    await applyUnsubscribe(token);
    res.json({ success: true, data: { unsubscribed: true } });
  })
);

// Human-facing unsubscribe confirmation page.
router.get(
  '/unsubscribe',
  asyncHandler(async (req, res) => {
    const ok = await applyUnsubscribe(String(req.query.c || ''));
    res
      .status(ok ? 200 : 400)
      .set('Content-Type', 'text/html')
      .send(
        `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1a1a1a}h1{font-size:1.4rem}</style></head><body><h1>${ok ? 'You have been unsubscribed' : 'Link expired or invalid'}</h1><p>${ok ? 'You will not receive further messages from us. You can close this page.' : 'This unsubscribe link is not valid. If you continue to receive messages, please reply with STOP.'}</p></body></html>`
      );
  })
);

export default router;
