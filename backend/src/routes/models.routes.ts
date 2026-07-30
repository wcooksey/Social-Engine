import { Router } from 'express';
import { prisma } from '../config/database';
import { config } from '../config/environment';
import { asyncHandler } from '../middleware/error.middleware';
import { isProviderConfigured, MODEL_CATALOG, PROVIDERS } from '../engine/llm/catalog';
import { getOrgConfig } from '../services/settings.service';

const router = Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const org = await prisma.organization.findUnique({
      where: { id: req.user!.organizationId },
      select: { engineModel: true, coachModel: true },
    });
    const orgConfig = await getOrgConfig(req.user!.organizationId);
    res.json({
      success: true,
      data: {
        models: MODEL_CATALOG.map((m) => ({
          id: m.id,
          label: m.label,
          provider: m.provider,
          providerLabel: PROVIDERS[m.provider].label,
          configured: isProviderConfigured(m.provider, orgConfig.providerKeys),
          recommended: m.recommended ?? false,
        })),
        current: org?.engineModel || config.engine.model,
        // The Sandbox call coach picks its own model; null here means it
        // inherits the Engine's.
        coachCurrent: org?.coachModel || org?.engineModel || config.engine.model,
        coachIsInherited: !org?.coachModel,
      },
    });
  })
);

export default router;
