import { Router } from 'express';
import { prisma } from '../config/database';
import { AppError, asyncHandler } from '../middleware/error.middleware';
import { roleMiddleware } from '../middleware/auth.middleware';
import { isEncryptionConfigured } from '../utils/encryption';
import { PlatformKey, upsertAccount, validateAccount } from '../services/social-account.service';
import {
  cancelInteractiveLogin,
  completeInteractiveLogin,
  getInteractiveFrame,
  InteractiveInput,
  sendInteractiveInput,
  startInteractiveLogin,
} from '../services/interactive-login.service';

const router = Router();

const PLATFORMS: PlatformKey[] = ['linkedin', 'facebook', 'instagram', 'x'];

/** Never returns encryptedState — only safe metadata. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const accounts = await prisma.socialAccount.findMany({
      where: { organizationId: req.user!.organizationId },
      select: {
        id: true,
        platform: true,
        label: true,
        status: true,
        lastValidatedAt: true,
        lastUsedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({
      success: true,
      data: { accounts, encryptionConfigured: isEncryptionConfigured() },
    });
  })
);

/**
 * Connect (or refresh) an account by uploading a captured browser session.
 * The storageState is a Playwright storageState JSON produced by the
 * login-capture helper — cookies + localStorage, i.e. a live logged-in session.
 */
router.post(
  '/',
  roleMiddleware('OWNER', 'ADMIN'),
  asyncHandler(async (req, res) => {
    if (!isEncryptionConfigured()) {
      throw new AppError('APP_ENCRYPTION_KEY is not configured on the server — cannot store sessions securely.', 400);
    }
    const platform = String(req.body.platform || '').toLowerCase() as PlatformKey;
    if (!PLATFORMS.includes(platform)) throw new AppError('Invalid platform');

    let storageState = req.body.storageState;
    if (typeof storageState === 'string') {
      try {
        storageState = JSON.parse(storageState);
      } catch {
        throw new AppError('storageState must be valid JSON');
      }
    }
    if (!storageState || typeof storageState !== 'object' || !('cookies' in storageState)) {
      throw new AppError('storageState must be a Playwright session object with a "cookies" array');
    }

    const account = await upsertAccount({
      organizationId: req.user!.organizationId,
      platform,
      label: req.body.label,
      storageState,
    });
    res.status(201).json({
      success: true,
      data: {
        id: account.id,
        platform: account.platform,
        label: account.label,
        status: account.status,
      },
    });
  })
);

/**
 * Interactive ("log in through the app") connect flow. The server opens the
 * platform's login page in its own headless browser; the UI streams
 * screenshots and forwards the user's clicks/keystrokes until they're logged
 * in, then /complete saves the session. Logging in on the server's IP and
 * browser fingerprint is what keeps the session from being flagged/expired.
 */
router.post(
  '/interactive',
  roleMiddleware('OWNER', 'ADMIN'),
  asyncHandler(async (req, res) => {
    if (!isEncryptionConfigured()) {
      throw new AppError('APP_ENCRYPTION_KEY is not configured on the server — cannot store sessions securely.', 400);
    }
    const platform = String(req.body.platform || '').toLowerCase() as PlatformKey;
    if (!PLATFORMS.includes(platform)) throw new AppError('Invalid platform');
    const frame = await startInteractiveLogin(
      req.user!.organizationId,
      platform,
      typeof req.body.label === 'string' && req.body.label ? req.body.label : undefined
    );
    res.status(201).json({ success: true, data: frame });
  })
);

router.get(
  '/interactive/:id',
  roleMiddleware('OWNER', 'ADMIN'),
  asyncHandler(async (req, res) => {
    const frame = await getInteractiveFrame(req.params.id, req.user!.organizationId);
    res.json({ success: true, data: frame });
  })
);

router.post(
  '/interactive/:id/input',
  roleMiddleware('OWNER', 'ADMIN'),
  asyncHandler(async (req, res) => {
    const frame = await sendInteractiveInput(
      req.params.id,
      req.user!.organizationId,
      req.body as InteractiveInput
    );
    res.json({ success: true, data: frame });
  })
);

router.post(
  '/interactive/:id/complete',
  roleMiddleware('OWNER', 'ADMIN'),
  asyncHandler(async (req, res) => {
    const result = await completeInteractiveLogin(req.params.id, req.user!.organizationId);
    res.json({ success: true, data: result });
  })
);

router.delete(
  '/interactive/:id',
  roleMiddleware('OWNER', 'ADMIN'),
  asyncHandler(async (req, res) => {
    await cancelInteractiveLogin(req.params.id, req.user!.organizationId);
    res.json({ success: true, data: null });
  })
);

router.post(
  '/:id/validate',
  asyncHandler(async (req, res) => {
    const live = await validateAccount(req.params.id, req.user!.organizationId);
    const account = await prisma.socialAccount.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
      select: { id: true, status: true, lastValidatedAt: true },
    });
    if (!account) throw new AppError('Account not found', 404);
    res.json({ success: true, data: { ...account, live } });
  })
);

router.delete(
  '/:id',
  roleMiddleware('OWNER', 'ADMIN'),
  asyncHandler(async (req, res) => {
    const existing = await prisma.socialAccount.findFirst({
      where: { id: req.params.id, organizationId: req.user!.organizationId },
    });
    if (!existing) throw new AppError('Account not found', 404);
    await prisma.socialAccount.delete({ where: { id: existing.id } });
    res.json({ success: true, data: null });
  })
);

export default router;
