import { Router } from 'express';
import { AppError, asyncHandler } from '../middleware/error.middleware';
import { roleMiddleware } from '../middleware/auth.middleware';
import { prisma } from '../config/database';
import { config } from '../config/environment';
import { getOrgConfig } from '../services/settings.service';
import * as channels from '../services/channels.service';
import { checkInboundEmail } from '../services/inbound-health.service';
import { suppressionReason } from '../services/suppression.service';
import { buildCallSystemPrompt } from '../engine/prompts';
import { runBrowserAgent } from '../engine/browser/browser-agent.service';
import { loadStorageState, PlatformKey, saveStorageState } from '../services/social-account.service';

/**
 * Test bench: fire a REAL message on each channel to yourself, to confirm the
 * providers are wired end-to-end before touching real leads. Bypasses the lead
 * pipeline and outreach guardrails (quiet hours, caps, kill switch) because
 * it's a deliberate manual self-test — but still uses the org's real creds, so
 * it costs real provider money. Owner/Admin only.
 */
const router = Router();

router.use(roleMiddleware('OWNER', 'ADMIN'));

// What's ready to test.
router.get(
  '/status',
  asyncHandler(async (req, res) => {
    const cfg = await getOrgConfig(req.user!.organizationId);
    const social = await prisma.socialAccount.findMany({
      where: { organizationId: req.user!.organizationId, status: 'CONNECTED' },
      select: { platform: true },
    });
    res.json({
      success: true,
      data: {
        email: channels.isEmailConfigured(cfg.mailgun),
        sms: channels.isSmsConfigured(cfg.twilio),
        voice: channels.isVoiceConfigured(cfg.vapi),
        socialPlatforms: social.map((s) => s.platform.toLowerCase()),
      },
    });
  })
);

router.post(
  '/email',
  asyncHandler(async (req, res) => {
    const to = String(req.body?.to || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new AppError('A valid email is required');
    const cfg = await getOrgConfig(req.user!.organizationId);
    if (!channels.isEmailConfigured(cfg.mailgun)) throw new AppError('Email (Mailgun) is not configured in Settings', 400);
    const org = await prisma.organization.findUnique({ where: { id: req.user!.organizationId } });

    const result = await channels.sendEmail(
      {
        to,
        subject: req.body?.subject?.trim() || `Test email from ${org?.name || 'Neuralnetics'}`,
        body:
          req.body?.body?.trim() ||
          `This is a test email from your Neuralnetics workspace. If you're reading this, your Mailgun email channel is working. 🎉`,
        fromName: org?.name,
      },
      cfg.mailgun
    );
    if (!result.sent) throw new AppError(`Email failed: ${result.error}`, 502);
    res.json({ success: true, data: { sent: true, to, externalId: result.externalId } });
  })
);

/**
 * Why a lead's reply never appeared in the inbox. Sending works long before
 * receiving does, so this checks the receiving side end to end.
 */
router.get(
  '/inbound-email',
  asyncHandler(async (req, res) => {
    const cfg = await getOrgConfig(req.user!.organizationId);
    res.json({ success: true, data: await checkInboundEmail(cfg.mailgun) });
  })
);

router.post(
  '/sms',
  asyncHandler(async (req, res) => {
    const to = String(req.body?.to || '').trim();
    if (!/^\+?[0-9().\-\s]{7,}$/.test(to)) throw new AppError('A valid phone number is required (e.g. +15551234567)');
    const cfg = await getOrgConfig(req.user!.organizationId);
    if (!channels.isSmsConfigured(cfg.twilio)) throw new AppError('SMS (Twilio) is not configured in Settings', 400);

    // An opt-out is absolute — it does not have an exception for "we were only
    // testing". The kill switch and quiet hours deliberately do NOT apply here:
    // this is a human verifying their own wiring, usually to their own phone,
    // and being unable to test while paused is exactly when you need to.
    const suppressed = await suppressionReason(req.user!.organizationId, { phone: to });
    if (suppressed) throw new AppError(`Cannot text ${to} — ${suppressed}`, 400);

    const result = await channels.sendSms(
      {
        to,
        body:
          req.body?.body?.trim() ||
          `Test SMS from your Neuralnetics workspace — your Twilio channel works. Reply STOP to test opt-out.`,
      },
      cfg.twilio
    );
    if (!result.sent) throw new AppError(`SMS failed: ${result.error}`, 502);
    res.json({ success: true, data: { sent: true, to, externalId: result.externalId } });
  })
);

router.post(
  '/call',
  asyncHandler(async (req, res) => {
    const to = String(req.body?.to || '').trim();
    if (!/^\+?[0-9().\-\s]{7,}$/.test(to)) throw new AppError('A valid phone number is required (e.g. +15551234567)');
    const cfg = await getOrgConfig(req.user!.organizationId);
    if (!channels.isVoiceConfigured(cfg.vapi)) throw new AppError('Voice (Vapi) is not configured in Settings', 400);
    const org = await prisma.organization.findUnique({ where: { id: req.user!.organizationId } });

    const objective =
      req.body?.objective?.trim() ||
      'This is a test call to confirm the voice channel works. Greet the person, tell them this is a test of their Neuralnetics voice setup, ask how their day is going, and end the call politely after a short exchange.';
    const systemPrompt = buildCallSystemPrompt({
      organizationName: org?.name || 'our company',
      objective,
      lead: {
        companyName: 'Test Call',
        contactName: `${req.user!.email}`,
        status: 'NEW',
        aiSummary: 'This is a self-test call initiated from the test bench.',
        recentTimeline: [],
      },
      voicePlaybooks: '',
    });

    const result = await channels.placeVapiCall(
      {
        toNumber: to,
        systemPrompt,
        firstMessage: `Hi! This is a test call from ${org?.name || 'your Neuralnetics workspace'}. I'm just confirming the voice setup works — do you have a quick second?`,
        voicemailMessage: `Hi, this is a test call from ${org?.name || 'your Neuralnetics workspace'} confirming the voice channel works. No action needed — have a great day!`,
        metadata: { organizationId: req.user!.organizationId, test: 'true' },
        ...(cfg.vapi.webhookSecret
          ? { server: { url: `${config.appPublicUrl}/api/webhooks/vapi`, secret: cfg.vapi.webhookSecret } }
          : {}),
      },
      cfg.vapi
    );
    if (!result.sent) throw new AppError(`Call failed: ${result.error}`, 502);
    res.json({ success: true, data: { placed: true, to, vapiCallId: result.externalId } });
  })
);

const PLATFORMS: PlatformKey[] = ['linkedin', 'facebook', 'instagram', 'x'];

router.post(
  '/dm',
  asyncHandler(async (req, res) => {
    const platform = String(req.body?.platform || '').toLowerCase() as PlatformKey;
    if (!PLATFORMS.includes(platform)) throw new AppError('platform must be linkedin, facebook, instagram, or x');
    const profileUrl = String(req.body?.profileUrl || '').trim();
    if (!/^https?:\/\//i.test(profileUrl)) throw new AppError('A full profile URL is required (https://...)');

    const storageState = await loadStorageState(req.user!.organizationId, platform);
    if (!storageState) {
      throw new AppError(`No connected ${platform} account. Connect one in Settings → Connected social accounts first.`, 400);
    }
    const cfg = await getOrgConfig(req.user!.organizationId);
    const org = await prisma.organization.findUnique({ where: { id: req.user!.organizationId } });
    const message =
      req.body?.message?.trim() ||
      `Hey! This is a test DM from my Neuralnetics setup — just confirming the ${platform} channel works. 🤖`;

    // Fire the browser agent in the background; the test bench polls the Live
    // page / returns immediately. Human-initiated, so it bypasses autonomy gate.
    void (async () => {
      try {
        await runBrowserAgent({
          objective: `You are already logged in to ${platform}. Go to ${profileUrl} and send them this exact direct message: "${message}". Confirm the message was sent.`,
          startUrl: profileUrl,
          model: org?.engineModel || 'claude-sonnet-5',
          providerKeys: cfg.providerKeys,
          allowSend: true,
          storageState,
          persistState: (s) => saveStorageState(req.user!.organizationId, platform, s),
        });
      } catch {
        /* best-effort test */
      }
    })();

    res.json({
      success: true,
      data: {
        dispatched: true,
        note: `Sending a test ${platform} DM to ${profileUrl} in the background. Watch it work on the Live page, and check your ${platform} DMs in a minute.`,
      },
    });
  })
);

export default router;
