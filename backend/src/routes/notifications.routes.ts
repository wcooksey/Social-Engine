import { Router } from 'express';
import { asyncHandler } from '../middleware/error.middleware';
import { listNotifications, markRead, unreadCount } from '../services/notification.service';

const router = Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const unreadOnly = req.query.unread === 'true';
    const [notifications, unread] = await Promise.all([
      listNotifications(req.user!.organizationId, unreadOnly),
      unreadCount(req.user!.organizationId),
    ]);
    res.json({ success: true, data: { notifications, unread } });
  })
);

router.post(
  '/read',
  asyncHandler(async (req, res) => {
    const ids: string[] | undefined = Array.isArray(req.body?.ids) ? req.body.ids : undefined;
    const count = await markRead(req.user!.organizationId, ids);
    const unread = await unreadCount(req.user!.organizationId);
    res.json({ success: true, data: { marked: count, unread } });
  })
);

export default router;
