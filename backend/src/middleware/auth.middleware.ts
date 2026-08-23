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

/**
 * Access tokens carry a snapshot of the user's tokenVersion, bumped server-side
 * on logout and password change. That was checked when refreshing but not when
 * USING a token, so signing out, changing a password or suspending an account
 * left the already-issued access token working until it expired — a suspended
 * user kept full API access for the remainder of its life.
 *
 * The check costs one indexed lookup per request. Cached briefly so a burst of
 * calls from one client doesn't become a burst of queries; the window is short
 * enough that a revocation still takes effect within seconds.
 */
const REVOCATION_CACHE_MS = 10_000;
const userState = new Map<string, { at: number; tv: number; active: boolean }>();

async function currentUserState(userId: string): Promise<{ tv: number; active: boolean } | null> {
  const cached = userState.get(userId);
  if (cached && Date.now() - cached.at < REVOCATION_CACHE_MS) {
    return { tv: cached.tv, active: cached.active };
  }
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { tokenVersion: true, isActive: true },
  });
  if (!user) return null;
  userState.set(userId, { at: Date.now(), tv: user.tokenVersion, active: user.isActive });
  return { tv: user.tokenVersion, active: user.isActive };
}

/** Drop a user's cached state so a revocation takes effect immediately. */
export function forgetUserState(userId: string): void {
  userState.delete(userId);
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
      req.user = payload;
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
