import { Router } from 'express';
import { prisma } from '../config/database';
import { AppError, asyncHandler } from '../middleware/error.middleware';
import { recomputeLeadEnrichment } from '../services/lead-enrichment.service';

const router = Router();

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.contact.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!existing) throw new AppError('Contact not found', 404);

    const allowed = ['firstName', 'lastName', 'title', 'email', 'phone', 'socials', 'isPrimary', 'optedOut'] as const;
    const data: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key in req.body) data[key] = req.body[key];
    }
    const contact = await prisma.contact.update({ where: { id: existing.id }, data });
    // Editing a person changes what the lead has on file — re-grade it.
    await recomputeLeadEnrichment(existing.leadId);
    res.json({ success: true, data: contact });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.contact.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!existing) throw new AppError('Contact not found', 404);
    await prisma.contact.delete({ where: { id: existing.id } });
    await recomputeLeadEnrichment(existing.leadId);
    res.json({ success: true, data: null });
  })
);

export default router;
