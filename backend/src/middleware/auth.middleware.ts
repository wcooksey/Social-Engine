import { NextFunction, Request, Response } from 'express';
import { JwtPayload, verifyAccessToken } from '../utils/jwt';
import { prisma } from '../config/database';
import { isSuperAdmin } from '../services/settings.service';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

/** Read current authorization on every request so role changes apply immediately. */
async function currentUserState(userId: string): Promise<{ tv: number; active: boolean; role: string; organizationId: string } | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { tokenVersion: true, isActive: true, role: true, organizationId: true },
  });
  if (!user) return null;
  return { tv: user.tokenVersion, active: user.isActive, role: user.role, organizationId: user.organizationId };
}

/** Drop a user's cached state so a revocation takes effect immediately. */
export function forgetUserState(userId: string): void {
  // No authorization cache; revocations are checked on every request.
  void userId;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Bearer header, or ?token= for SSE/EventSource-style requests
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ')
    ? header.slice(7)
    : (req.query.token as string | undefined);

  if (!token) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return;
  }

  let payload: JwtPayload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    res.status(401).json({ success: false, error: 'Invalid or expired token' });
    return;
  }

  void currentUserState(payload.userId)
    .then((state) => {
      if (!state || !state.active) {
        res.status(401).json({ success: false, error: 'This account is no longer active' });
        return;
      }
      if ((payload.tv ?? 0) !== state.tv) {
        res.status(401).json({ success: false, error: 'Session ended — please sign in again' });
        return;
      }
      const apiPath = req.originalUrl.split('?')[0];
      if (state.role === 'CALLER' && !apiPath.startsWith('/api/crm/') && apiPath !== '/api/crm' && !apiPath.startsWith('/api/auth/')) {
        res.status(403).json({ success: false, error: 'Caller accounts can only access the calling CRM' });
        return;
      }
      req.user = { ...payload, role: state.role, organizationId: state.organizationId };
      next();
    })
    .catch(() => {
      res.status(503).json({ success: false, error: 'Could not verify the session' });
    });
}

export function roleMiddleware(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ success: false, error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}

export function superAdminMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!isSuperAdmin(req.user?.email)) {
    res.status(403).json({ success: false, error: 'Super admin only' });
    return;
  }
  next();
}
