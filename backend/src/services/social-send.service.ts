import { prisma } from '../config/database';
import { getOrgConfig } from './settings.service';
import { config } from '../config/environment';
import { loadStorageState, PlatformKey, saveStorageState } from './social-account.service';
import { runBrowserAgent } from '../engine/browser/browser-agent.service';
import { leadService } from './lead.service';

const PLATFORMS: PlatformKey[] = ['linkedin', 'facebook', 'instagram', 'x'];

/**
 * Send a human-approved social DM draft via the browser agent. Runs in the
 * background (the approve endpoint returns immediately with status 'sending')
 * because a browser session can take many seconds. Human approval is the
 * authorization here, so this bypasses the org's autonomy gate by design.
 */
export async function dispatchApprovedSocialDm(messageId: string): Promise<void> {
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    include: { conversation: { include: { lead: true } } },
  });
  if (!message || message.conversation.channel !== 'SOCIAL') return;

  const conversation = message.conversation;
  const lead = conversation.lead;
  const organizationId = conversation.organizationId;

  // Platform is encoded in the conversation subject (e.g. "LINKEDIN DM").
  const platformWord = (conversation.subject || '').split(/\s+/)[0]?.toLowerCase();
  const platform = PLATFORMS.find((p) => p === platformWord);

  const finalize = async (status: string, summary: string, extra?: Record<string, unknown>) => {
    await prisma.message.update({ where: { id: message.id }, data: { status, sentAt: status === 'sent' ? new Date() : null } });
    await leadService.logActivity({
      organizationId,
      leadId: lead.id,
      type: 'SOCIAL_TOUCH' as const,
      summary,
      payload: { messageId: message.id, approvedDraft: true, status, ...extra },
    });
    // An approved draft that actually sent is still a first touch.
    if (status === 'sent') {
      await leadService.advanceStatusOnTouch(lead.id, `${platform ?? 'Social'} DM`);
    }
  };

  if (!platform) {
    await finalize('failed', `Could not determine the social platform for this DM — send it manually.`);
    return;
  }
  const storageState = await loadStorageState(organizationId, platform);
  if (!storageState) {
    await finalize('failed', `No connected ${platform} account — connect one in Settings to auto-send.`);
    return;
  }

  const orgConfig = await getOrgConfig(organizationId);
  const socials = (lead.socials || {}) as Record<string, string>;
  const profileUrl = socials[platform];
  const target = profileUrl ? `their profile at ${profileUrl}` : `${lead.companyName}`;
  const objective = `You are already logged in to ${platform}. Find ${target} and send them this exact direct message (personalize naturally if helpful): "${message.body}". Confirm the message was sent.`;

  try {
    const result = await runBrowserAgent({
      objective,
      startUrl: profileUrl,
      model: (await prisma.organization.findUnique({ where: { id: organizationId } }))?.engineModel || config.engine.model,
      providerKeys: orgConfig.providerKeys,
      allowSend: true,
      storageState,
      persistState: (state) => saveStorageState(organizationId, platform, state),
    });
    const ok = result.status === 'completed';
    await finalize(ok ? 'sent' : 'failed', `${platform} DM ${ok ? 'sent' : 'send failed'} (approved draft): ${result.summary}`.slice(0, 500), {
      browserResult: result.summary,
    });
  } catch (err) {
    await finalize('failed', `${platform} DM send errored: ${err instanceof Error ? err.message : 'unknown'}`);
  }
}
