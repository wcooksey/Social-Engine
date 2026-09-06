import { healthByMailbox } from './sender-health.service';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { config } from '../config/environment';
import { getSendingOverview, resolveSenderDecision } from './sender.service';
import { getOrgConfig } from './settings.service';
import { verificationBlock } from './send-safety.service';
import { resolveSenderIdentity } from './identity.service';

export async function getPlaybookReadiness(organizationId: string, playbookId: string) {
  const playbook = await prisma.playbook.findFirst({ where: { id: playbookId, organizationId }, include: { campaign: true, group: true, senderPool: { include: { mailboxes: true } } } });
  if (!playbook) throw new Error('Playbook not found');
  const where: Prisma.LeadWhereInput = { organizationId,
    ...(playbook.scope === 'GROUP' ? { groupId: playbook.groupId } : {}),
    ...(playbook.scope === 'CAMPAIGN' ? { campaignLeads: { some: { campaignId: playbook.campaignId! } } } : {}),
    ...(playbook.scope === 'LEAD_STATUS' ? { status: playbook.leadStatus! } : {}),
  };
  const [org, leads, total, overview, cfg, events, lastOutbound, queued, drafts] = await Promise.all([
    prisma.organization.findUnique({ where: { id: organizationId } }),
    prisma.lead.findMany({ where, include: { contacts: true }, take: 500, orderBy: { id: 'asc' } }),
    prisma.lead.count({ where }), getSendingOverview(organizationId), getOrgConfig(organizationId),
    prisma.emailEventReceipt.findMany({ where: { organizationId }, orderBy: { receivedAt: 'desc' }, take: 100 }),
    prisma.message.findFirst({ where: { conversation: { lead: where }, direction: 'OUTBOUND', sentAt: { not: null } }, orderBy: { sentAt: 'desc' }, select: { sentAt: true } }),
    prisma.message.count({ where: { conversation: { lead: where }, status: 'scheduled' } }),
    prisma.message.count({ where: { conversation: { lead: where }, status: 'draft_pending_approval' } }),
  ]);
  const checks: { key: string; state: 'pass' | 'blocked' | 'unknown' | 'info'; detail: string; href: string }[] = [];
  const add = (key: string, state: 'pass' | 'blocked' | 'unknown' | 'info', detail: string, href = '/settings') => checks.push({ key, state, detail, href });
  add('Playbook', playbook.isActive ? 'pass' : 'blocked', playbook.isActive ? 'Active instructions. This does not activate a campaign.' : 'Playbook is inactive.', '/playbooks');
  add('Organization', org?.paused ? 'blocked' : 'pass', org?.paused ? 'Outbound is paused.' : `Daily cap ${org?.dailySendCap}; quiet hours ${org?.quietHoursStart}:00–${org?.quietHoursEnd}:00 in the lead’s timezone.`);
  const verifiedLeads = leads.filter(l => !l.doNotContact && !l.contactReviewReason && !l.coldOutreachHeldAt && !['ENGAGED','INTERESTED','CUSTOMER'].includes(l.status) && l.contacts.some(c => !verificationBlock(c))).length;
  add('Recipients', verifiedLeads ? 'pass' : 'blocked', `${verifiedLeads} of ${leads.length} assessed leads have a current verified address and no lead-level hold. ${total} total in scope. Suppressions, campaign state and sender routing are checked again before sending.`, '/leads');
  add('Verification', cfg.mailgun.apiKey ? 'info' : 'blocked', cfg.mailgun.apiKey ? 'A validation key is configured; API access is not tested by this report. Every send requires a successful result for the exact address within 30 days.' : 'No validation key configured. Existing unverified addresses cannot send.');
  const decision = await resolveSenderDecision(organizationId, { playbookId, purpose: 'COLD_OUTREACH', legacy: cfg.mailgun });
  add('Sender now', decision.sender ? 'pass' : decision.retryAt ? 'info' : 'blocked', decision.sender ? `Candidate: ${decision.sender.fromEmail} via ${decision.sender.transport}. Lead-specific routing and existing threads can select another sender.` : `${decision.reason || 'No sender available.'}${decision.retryAt ? ' Next capacity: ' + decision.retryAt.toISOString() : ''}`, '/sending');
  const sample = leads[0];
  const identity = await resolveSenderIdentity(organizationId, { lead: sample, channel: 'EMAIL', mailgunDomain: cfg.mailgun.domain });
  add('Routing and footer', sample && identity.postalAddress ? 'pass' : 'unknown', sample ? `Example lead ${sample.companyName}: routing ${identity.routingPlaybookId === playbook.id ? 'through this playbook' : identity.routingPlaybookId ? 'through another matching playbook (scope or priority override)' : 'through organization defaults'}; postal footer ${identity.postalAddress ? 'present' : 'missing'}. Scope overlaps can change routing for other leads.` : 'No lead is available to check actual routing.', '/playbooks');
  const campaigns = await prisma.campaign.findMany({ where: { organizationId, OR: [ ...(playbook.campaignId ? [{ id: playbook.campaignId }] : []), ...(playbook.groupId ? [{ autoEnrollGroupId: playbook.groupId }] : []), { campaignLeads: { some: { lead: where } } } ] }, take: 25, orderBy: { createdAt: 'desc' } });
  if (!campaigns.length) add('Campaign', 'unknown', 'No campaign found for the scoped leads or linked group. Create the intended campaign before launching.', '/campaigns');
  for (const c of campaigns) add('Campaign: ' + c.name, c.status === 'ACTIVE' ? 'pass' : 'info', `${c.status}, ${c.mode}. ${c.sequenceEnabled ? 'Explicit sequence; waits when approved steps run out.' : 'AI cadence; no fixed message sequence.'} Paused/draft campaigns do not send.`, '/campaigns/' + c.id);
  if (campaigns.length && campaigns.every(c => c.status !== 'ACTIVE')) add('Campaign sending', 'blocked', 'All matched campaigns are inactive. Preview and test preparation remain available.', '/campaigns');
  add('Reply handling', 'info', 'Human replies hold cold outreach across channels and cancel pending prospecting. Automated replies defer cadence. Continue on the active conversation channel.', '/conversations');
  add('Reply and unsubscribe wiring', config.inbound.webhookSecret && !config.appPublicUrlIsUnreachable ? 'unknown' : 'blocked', 'Configuration alone does not prove the reply route or unsubscribe link works. Use Settings → Check reply tracking, then a controlled round-trip test.');
  for (const event of ['delivered','failed','complained']) {
    const receipt = events.find(e => e.event === event);
    add(event + ' reporting', receipt ? 'info' : 'unknown', receipt ? `Organization-wide matched event last received ${receipt.receivedAt.toISOString()}. This is ingestion evidence, not a complete per-domain wiring check.` : 'No matched event receipt observed. A zero rate is not proof that reporting works.');
  }
  add('Open tracking', 'info', 'Disabled by the sending code. Open rate is unavailable, not zero. Delivery does not prove inbox placement.', '/sending');
  add('Provider and DNS review', 'unknown', 'Confirm provider permission for this audience, DMARC/alignment and a controlled delivery/reply/unsubscribe test. Mailgun remains available; validation success does not establish recipient consent.');
  if (overview.usingLegacySettings && playbook.emailTransport === 'MAILGUN') add('Legacy sender', 'blocked', 'Legacy Mailgun settings do not provide managed mailbox warm-up. Register and verify the sender on Sending before cold outreach.', '/sending');
  const ids = playbook.senderPool ? new Set(playbook.senderPool.mailboxes.map(m => m.mailboxId)) : null;
  const domains = playbook.emailTransport === 'GMAIL' ? [] : overview.domains.map(d => ({ ...d, mailboxes: d.mailboxes.filter(m => !ids || ids.has(m.id)) })).filter(d => d.mailboxes.length);
  const health = await healthByMailbox(new Date(), domains.flatMap(d => d.mailboxes.map(m => m.id)));
  const mailboxHealth = domains.flatMap(d => d.mailboxes.map(m => ({ address: m.address, health: health.get(m.id) ?? null, feedbackObserved: events.some(e => e.mailboxId === m.id), lastEventAt: events.find(e => e.mailboxId === m.id)?.receivedAt ?? null })));
  return { mailboxHealth, playbookId, name: playbook.name, checkedAt: new Date().toISOString(), status: checks.some(c => c.state === 'blocked') ? 'blocked' : checks.some(c => c.state === 'unknown') ? 'needs_checks' : 'ready_for_controlled_test', checks, audience: { total, assessed: leads.length, verifiedLeads }, activity: { lastSentAt: lastOutbound?.sentAt ?? null, queued, drafts }, domains, nextEligibleAt: decision.retryAt ?? null, warmup: 'Warm-up is reduced-volume real outreach, not a separate preparation service or proof of reputation. Mailbox allowances grow with elapsed days and observed sending days, subject to health and pacing. Health pauses require explicit review and resume. Gmail uses its own limits.' };
}
