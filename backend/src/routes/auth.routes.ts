import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/error.middleware';
import { authService } from '../services/auth.service';

const router = Router();

router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const data = await authService.register(req.body);
    res.status(201).json({ success: true, data });
  })
);

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const data = await authService.login(req.body.email, req.body.password);
    res.json({ success: true, data });
  })
);

router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const data = await authService.refresh(req.body.refreshToken);
    res.json({ success: true, data });
  })
);

router.get(
  '/me',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const data = await authService.me(req.user!.userId);
    res.json({ success: true, data });
  })
);

// Logout-everywhere: bumps the token version so all issued tokens stop
// refreshing (access tokens die at their short expiry).
router.post(
  '/logout',
  authMiddleware,
  asyncHandler(async (req, res) => {
    await authService.revokeTokens(req.user!.userId);
    res.json({ success: true, data: null });
  })
);

// Toggle whether this user receives notification/digest emails.
router.patch(
  '/me/notifications',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const data = await authService.setNotifyByEmail(req.user!.userId, !!req.body?.notifyByEmail);
    res.json({ success: true, data });
  })
);

export default router;
