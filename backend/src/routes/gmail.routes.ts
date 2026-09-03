import { Router } from 'express';
import { prisma } from '../config/database';
import { roleMiddleware } from '../middleware/auth.middleware';
import { AppError, asyncHandler } from '../middleware/error.middleware';
import { syncGmailAccount } from '../services/gmail-sync.service';
import {
  buildGmailAuthUrl,
  disconnectGmailAccount,
  gmailRedirectUri,
  googleOAuthConfig,
  listGmailAccounts,
} from '../services/gmail.service';

/**
 * Connected Gmail inboxes — the second way mail leaves this platform.
 *
 * Reads are open to any member; connecting, pausing or disconnecting an inbox
 * changes what the platform sends as, so it is owner/admin only, exactly like
 * the domains and mailboxes next door.
 *
 * The OAuth callback itself is NOT here. Google redirects a browser with no
 * session attached, so it lives on the public router and authenticates the
 * request by its signed `state` instead.
 */
const router = Router();

const writeAccess = roleMiddleware('OWNER', 'ADMIN');

async function requireAccount(id: string, organizationId: string) {
  const account = await prisma.gmailAccount.findFirst({ where: { id, organizationId } });
  if (!account) throw new AppError('Gmail inbox not found', 404);
  return account;
}

/** Connected inboxes, plus whether this deployment can connect any at all. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const organizationId = req.user!.organizationId;
    const [accounts, oauth] = await Promise.all([
      listGmailAccounts(organizationId),
      googleOAuthConfig(organizationId),
    ]);
    res.json({
      success: true,
      data: {
        accounts,
        // The setup facts an operator needs when it doesn't work: whether the
        // client is configured, and the exact redirect URI Google must know.
        oauthConfigured: oauth.configured,
        redirectUri: gmailRedirectUri(),
      },
    });
  })
);

/**
 * The Google consent URL to open.
 *
 * Returned rather than redirected to: the caller is an XHR from the SPA, and a
 * 302 to accounts.google.com would be blocked by CORS and swallowed.
 */
router.post(
  '/auth-url',
  writeAccess,
  asyncHandler(async (req, res) => {
    try {
      const url = await buildGmailAuthUrl(req.user!.organizationId, req.user!.userId);
      res.json({ success: true, data: { url } });
    } catch (err) {
      throw new AppError(err instanceof Error ? err.message : 'Could not build the Google consent URL');
    }
  })
);

/** Pause/resume, rename, or re-cap an inbox. */
router.patch(
  '/:id',
  writeAccess,
  asyncHandler(async (req, res) => {
    const account = await requireAccount(req.params.id, req.user!.organizationId);
    const data: Record<string, unknown> = {};

    if ('displayName' in req.body) {
      const name = String(req.body.displayName ?? '').trim();
      data.displayName = name || null;
    }
    if ('dailySendCap' in req.body) {
      const cap = Number(req.body.dailySendCap);
      // Google's own ceiling is 500/day for a personal account and 2,000 on
      // Workspace; hitting it locks sending for about a day, so the field is
      // bounded well below rather than trusted from the client.
      if (!Number.isInteger(cap) || cap < 1 || cap > 400) {
        throw new AppError('dailySendCap must be a whole number between 1 and 400');
      }
      data.dailySendCap = cap;
    }
    if ('minSpacingSeconds' in req.body) {
      const spacing = Number(req.body.minSpacingSeconds);
      if (!Number.isInteger(spacing) || spacing < 0 || spacing > 3600) {
        throw new AppError('minSpacingSeconds must be a whole number between 0 and 3600');
      }
      data.minSpacingSeconds = spacing;
    }
    if ('paused' in req.body) {
      const paused = !!req.body.paused;
      if (paused) {
        data.status = 'PAUSED';
      } else if (account.status === 'PAUSED' || account.status === 'ERROR') {
        // Resuming an EXPIRED account is not on offer: the credential is gone,
        // and flipping the status would only produce a failure at send time.
        data.status = 'CONNECTED';
        data.lastError = null;
      } else if (account.status === 'EXPIRED') {
        throw new AppError(
          'This inbox needs reconnecting — Google has revoked the connection. Connect it again.'
        );
      }
    }

    if (Object.keys(data).length === 0) throw new AppError('Nothing to update');
    const updated = await prisma.gmailAccount.update({ where: { id: account.id }, data });
    res.json({
      success: true,
      data: { id: updated.id, status: updated.status, dailySendCap: updated.dailySendCap },
    });
  })
);

/** Read this inbox for replies right now, rather than waiting for the sweep. */
router.post(
  '/:id/sync',
  writeAccess,
  asyncHandler(async (req, res) => {
    const account = await requireAccount(req.params.id, req.user!.organizationId);
    if (account.status !== 'CONNECTED') {
      throw new AppError(`This inbox is ${account.status.toLowerCase()} — nothing to read.`);
    }
    try {
      const result = await syncGmailAccount(account);
      res.json({ success: true, data: result });
    } catch (err) {
      throw new AppError(err instanceof Error ? err.message : 'Could not read this inbox', 502);
    }
  })
);

/**
 * Disconnect. Playbooks pointing at it fall back to "the org's only inbox",
 * which is the SetNull on the relation — so a playbook left on the Gmail
 * transport with no inbox drafts its mail rather than quietly sending it from
 * somewhere else.
 */
router.delete(
  '/:id',
  writeAccess,
  asyncHandler(async (req, res) => {
    const account = await requireAccount(req.params.id, req.user!.organizationId);
    const playbooks = await prisma.playbook.count({
      where: { organizationId: req.user!.organizationId, gmailAccountId: account.id },
    });
    await disconnectGmailAccount(account);
    res.json({
      success: true,
      data: {
        disconnected: account.emailAddress,
        playbooksAffected: playbooks,
      },
    });
  })
);

export default router;
