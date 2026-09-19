import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/config/database';
import { outboundBlock } from '../src/services/outbound.service';
import { prepareCampaignEmail } from '../src/services/campaign-email.service';
import { isSupersededDraft, cancelSupersededDraft } from '../src/services/draft-lifecycle.service';

const restores: (() => void)[] = [];
function stub(target: any, key: string, fn: any) { const original = target[key]; const replacement = mock.fn(fn); target[key] = replacement; restores.push(() => { target[key] = original; }); return replacement; }
afterEach(() => { for (const restore of restores.splice(0).reverse()) restore(); mock.restoreAll(); });
const draft = { id: 'draft', conversationId: 'thread', campaignId: 'campaign', sequenceKey: null, direction: 'OUTBOUND', status: 'draft_blocked', subject: 'Hello', body: 'Exact body', createdAt: new Date('2026-09-15'), sentAt: null, isConversationReply: false };
const sent = { ...draft, id: 'sent', status: 'delivered', sentAt: new Date('2026-09-16') };

test('only exact campaign/recipient duplicates with a later successful send match', () => {
  assert.equal(isSupersededDraft(draft, sent), true);
  for (const delta of [{ conversationId: 'other-contact' }, { campaignId: 'other-campaign' }, { subject: 'Other subject' }, { body: 'Different body' }, { status: 'bounced' }, { status: 'scheduled' }, { direction: 'INBOUND' }, { sentAt: null }, { sentAt: new Date('2026-09-14') }]) assert.equal(isSupersededDraft(draft, { ...sent, ...delta }), false);
  for (const delta of [{ campaignId: null }, { isConversationReply: true }, { status: 'sending' }, { sentAt: new Date() }]) assert.equal(isSupersededDraft({ ...draft, ...delta }, sent), false);
  assert.equal(isSupersededDraft({ ...draft, sequenceKey: 'step-1' }, { ...sent, sequenceKey: 'step-2' }), false);
});

test('reconciliation is tenant scoped, conditional, and records cancellation without deleting or sending', async () => {
  const updates: any[] = [];
  const activities: any[] = [];
  const tx = { message: {
    findFirst: async ({ where }: any) => { assert.equal(where.conversation.organizationId, 'org'); return where.id === 'draft' ? { ...draft, conversation: { leadId: 'lead' } } : sent; },
    updateMany: async (args: any) => { updates.push(args); return { count: 1 }; },
  }, activity: { create: async (args: any) => { activities.push(args); } } };
  stub(prisma, '$transaction', async (fn: any) => fn(tx));
  mock.method(globalThis, 'fetch', async () => { assert.fail('Reconciliation must never send'); });
  assert.equal(await cancelSupersededDraft('org', 'draft', 'sent'), true);
  assert.equal(updates[0].where.status, 'draft_blocked');
  assert.equal(updates[0].where.sentAt, null);
  assert.equal(updates[0].data.status, 'cancelled');
  assert.match(updates[0].data.blockedReason, /sent/);
  assert.equal(activities.length, 1);
  tx.message.updateMany = async () => ({ count: 0 });
  assert.equal(await cancelSupersededDraft('org', 'draft', 'sent'), false);
  assert.equal(activities.length, 1);
});

test('quiet hours retry at the next local opening, including the DST transition', async () => {
  stub(prisma.organization, 'findUnique', async () => ({ paused: false, quietHoursStart: 20, quietHoursEnd: 8, dailySendCap: 200 }));
  stub(prisma.activity, 'count', async () => 0);
  const block = await outboundBlock('org', { state: 'MD' }, new Date('2026-11-01T03:30:00Z'));
  assert.equal(block?.retryAt?.toISOString(), '2026-11-01T13:00:00.000Z');
  assert.equal(await outboundBlock('org', { state: 'MD' }, new Date('2026-11-01T13:00:00Z')), null);
});

test('daily cap retries next day but the organization kill switch never auto-retries', async () => {
  let paused = false;
  stub(prisma.organization, 'findUnique', async () => ({ paused, quietHoursStart: 0, quietHoursEnd: 0, dailySendCap: 200 }));
  stub(prisma.activity, 'count', async () => 200);
  const now = new Date('2026-09-19T15:00:00Z');
  const block = await outboundBlock('org', { state: 'MD' }, now);
  assert.ok(block?.retryAt && block.retryAt > now);
  assert.equal(block!.retryAt!.getHours(), 0);
  paused = true;
  assert.equal((await outboundBlock('org', { state: 'MD' }, now))?.retryAt, null);
});

function campaignFixture(mode = 'AUTONOMOUS', paused = false) {
  const lead = { id: 'lead', status: 'NEW', state: 'MD', doNotContact: false, contactReviewReason: null, coldOutreachHeldAt: null, engagementChannel: null };
  stub(prisma.campaign, 'findFirst', async () => ({ id: 'campaign', mode, sequenceEnabled: false, maxTouches: 3, followUpCadenceDays: 2 }));
  stub(prisma.lead, 'findFirst', async () => lead);
  stub(prisma.campaignLead, 'findFirst', async () => ({ status: 'PENDING', pausedAt: null, campaign: { status: 'ACTIVE' } }));
  stub(prisma.campaignLead, 'findUnique', async () => ({ touchCount: 0, cycle: 0 }));
  stub(prisma.contact, 'findFirst', async () => ({ email: 'person@example.com', emailStatus: null, optedOut: false, emailVerifiedAt: new Date(), emailVerifiedAddress: 'person@example.com' }));
  stub(prisma.suppression, 'findFirst', async () => null);
  stub(prisma.organization, 'findUnique', async () => ({ paused, quietHoursStart: 0, quietHoursEnd: 0, dailySendCap: 0 }));
  stub(prisma.activity, 'count', async () => 0);
  const messages = new Map<string, any>();
  const tx = { message: {
    findUnique: async ({ where }: any) => messages.get(where.sequenceKey),
    create: async ({ data }: any) => { if (messages.has(data.sequenceKey)) throw Object.assign(new Error('duplicate'), { code: 'P2002' }); const row = { id: 'message', ...data }; messages.set(data.sequenceKey, row); return row; },
  }, conversation: { findFirst: async () => ({ id: 'thread' }), update: async () => ({}) }, activity: { create: async () => ({}) } };
  stub(prisma, '$transaction', async (fn: any) => fn(tx));
  stub(prisma.message, 'findUnique', tx.message.findUnique);
  mock.method(globalThis, 'fetch', async () => { assert.fail('Preparation must never send'); });
  return { messages, lead };
}
const input = { organizationId: 'org', campaignId: 'campaign', leadId: 'lead', contactId: 'contact', subject: 'Hello', body: 'Body', senderName: 'Sender', runId: 'run' };

test('concurrent Engine attempts reuse a single queued campaign touch when daily cap blocks', async () => {
  const { messages } = campaignFixture();
  const results = await Promise.all([prepareCampaignEmail(input), prepareCampaignEmail(input)]);
  assert.equal(messages.size, 1);
  assert.ok(results.every(result => result.queued && result.messageId === 'message'));
  const row = [...messages.values()][0];
  assert.equal(row.status, 'scheduled');
  assert.match(row.blockedReason, /Daily send cap/);
  assert.equal(row.retryable, true);
  assert.equal((await prepareCampaignEmail(input)).messageId, 'message');
});

test('approval-required campaigns remain drafts despite temporary blocks', async () => {
  const { messages } = campaignFixture('APPROVAL_REQUIRED');
  await prepareCampaignEmail(input);
  const row = [...messages.values()][0];
  assert.equal(row.status, 'draft_pending_approval');
  assert.equal(row.scheduledAt, null);
  assert.equal(row.retryable, false);
});

test('hard organization blocks remain drafts and opted-out leads are never queued', async () => {
  const { messages, lead } = campaignFixture('AUTONOMOUS', true);
  await prepareCampaignEmail(input);
  assert.equal([...messages.values()][0].status, 'draft_blocked');
  assert.equal([...messages.values()][0].retryable, false);
  lead.doNotContact = true;
  const result = await prepareCampaignEmail(input);
  assert.match(result.reason!, /opted out/);
  assert.equal(messages.size, 1);
});

test('legacy repeat cycles receive different keys without duplicating a touch', async () => {
  const { messages } = campaignFixture();
  await prepareCampaignEmail(input);
  stub(prisma.campaignLead, 'findUnique', async () => ({ touchCount: 0, cycle: 2 }));
  await prepareCampaignEmail(input);
  assert.equal(messages.size, 2);
});

test('explicit sequences cannot be rewritten by the Engine campaign preparation path', async () => {
  const { messages } = campaignFixture();
  stub(prisma.campaign, 'findFirst', async () => ({ id: 'campaign', mode: 'AUTONOMOUS', sequenceEnabled: true }));
  const result = await prepareCampaignEmail(input);
  assert.match(result.reason!, /fixed sequence/);
  assert.equal(messages.size, 0);
});

test('a changed or already approved draft is left alone by reconciliation', async () => {
  const tx = { message: {
    findFirst: async ({ where }: any) => where.id === 'draft' ? { ...draft, status: 'scheduled', conversation: { leadId: 'lead' } } : sent,
    updateMany: async () => { assert.fail('Do not cancel a message whose state changed'); },
  } };
  stub(prisma, '$transaction', async (fn: any) => fn(tx));
  assert.equal(await cancelSupersededDraft('org', 'draft', 'sent'), false);
});


test('a late duplicate Engine attempt cannot become the next touch after the first sends', async () => {
  const { messages } = campaignFixture();
  stub(prisma.campaignLead, 'findUnique', async () => ({ touchCount: 1, cycle: 0, lastTouchAt: new Date() }));
  const result = await prepareCampaignEmail(input);
  assert.match(result.reason!, /not due/);
  assert.equal(messages.size, 0);
});

test('exhausted campaign cycles cannot queue an extra touch', async () => {
  const { messages } = campaignFixture();
  stub(prisma.campaignLead, 'findUnique', async () => ({ touchCount: 3, cycle: 0 }));
  const result = await prepareCampaignEmail(input);
  assert.match(result.reason!, /touch limit/);
  assert.equal(messages.size, 0);
});
