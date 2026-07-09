import { Router } from 'express';
import { AppError, asyncHandler } from '../middleware/error.middleware';
import { roleMiddleware, superAdminMiddleware } from '../middleware/auth.middleware';
import {
  listOrgSettings,
  setOrgSetting,
  listPlatformSettings,
  setPlatformSetting,
} from '../services/settings.service';

const router = Router();

// --- Per-organization integration settings --------------------------------

// Masked view: never returns secret values, only whether each is set + source.
router.get(
  '/org',
  asyncHandler(async (req, res) => {
    const settings = await listOrgSettings(req.user!.organizationId);
    res.json({ success: true, data: { settings } });
  })
);

// Set (or clear, when value is empty) a single org setting. Owner/Admin only.
router.put(
  '/org',
  roleMiddleware('OWNER', 'ADMIN'),
  asyncHandler(async (req, res) => {
    const { key, value } = req.body ?? {};
    if (typeof key !== 'string' || !key) throw new AppError('key is required');
    if (typeof value !== 'string') throw new AppError('value must be a string');
    try {
      await setOrgSetting(req.user!.organizationId, key, value);
    } catch (err) {
      throw new AppError((err as Error).message);
    }
    const settings = await listOrgSettings(req.user!.organizationId);
    res.json({ success: true, data: { settings } });
  })
);

// --- Platform (super-admin) settings --------------------------------------

router.get(
  '/platform',
  superAdminMiddleware,
  asyncHandler(async (_req, res) => {
    const settings = await listPlatformSettings();
    res.json({ success: true, data: { settings } });
  })
);

router.put(
  '/platform',
  superAdminMiddleware,
  asyncHandler(async (req, res) => {
    const { key, value } = req.body ?? {};
    if (typeof key !== 'string' || !key) throw new AppError('key is required');
    if (value === undefined || value === null) throw new AppError('value is required');
    try {
      await setPlatformSetting(key, String(value));
    } catch (err) {
      throw new AppError((err as Error).message);
    }
    const settings = await listPlatformSettings();
    res.json({ success: true, data: { settings } });
  })
);

export default router;
