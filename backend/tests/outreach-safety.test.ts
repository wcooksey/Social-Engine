import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { verificationBlock, engagementBlock, automationSafetyReason, emailSafetyReason } from '../src/services/send-safety.service';
import { nextStep, validateStep, runExplicitSequence } from '../src/services/sequence.service';
import { dailyAllowance, isMailboxAvailable, resolveSenderDecision } from '../src/services/sender.service';
import { prisma } from '../src/config/database';

const now = new Date('2026-09-06T12:00:00Z');
const valid = { email: 'person@example.com', optedOut: false, emailStatus: null, emailVerifiedAt: now, emailVerifiedAddress: 'person@example.com' };
const held = { coldOutreachHeldAt: now, engagementChannel: 'EMAIL', status: 'ENGAGED' };
const step = { id: 'one', subject: 'A useful update', body: 'Here is the update.', delayDays: 3, approved: true };
const restores: (() => void)[] = [];
function stub(target: any, key: string, fn: any) { const original = target[key]; target[key] = fn; restores.push(() => { target[key] = original; }); }
afterEach(() => { for (const restore of restores.splice(0).reverse()) restore(); mock.restoreAll(); });

test('unverified, changed, expired and suppressed addresses never become eligible', () => {
  assert.equal(verificationBlock(valid, now), null);
  for (const delta of [{ emailVerifiedAt: null }, { emailVerifiedAddress: null }, { email: 'other@example.com' }, { optedOut: true }, { emailStatus: 'bounced' }, { emailVerifiedAt: new Date('2026-08-01') }, { emailVerifiedAt: new Date('2026-10-01') }]) assert.ok(verificationBlock({ ...valid, ...delta }, now));
});
test('email replies block SMS and all campaign touches, while same-channel replies can continue', () => {
  assert.ok(engagementBlock(held, 'SMS'));
  assert.ok(engagementBlock(held, 'EMAIL', 'campaign'));
  assert.equal(engagementBlock(held, 'EMAIL'), null);
  assert.ok(engagementBlock({ ...held, engagementChannel: 'SMS' }, 'EMAIL'));
  assert.ok(engagementBlock({ ...held, engagementChannel: null }, 'EMAIL'));
});
test('an appended step continues at the existing position and never replays previous steps', () => {
  assert.equal(nextStep([step], 1), null);
  const appended = { ...step, id: 'two' };
  assert.equal(nextStep([step, appended], 1)?.id, 'two');
  assert.equal(nextStep([step, { ...appended, approved: false }, { ...step, id: 'three' }], 1), null);
  assert.equal(nextStep([step], 0)?.id, 'one');
});
test('invalid sequence copy and delays cannot be approved', () => {
  for (const delta of [{ subject: '' }, { body: '' }, { delayDays: 0 }, { delayDays: 1.5 }, { delayDays: 366 }, { body: 'Hello [first_name]' }]) assert.throws(() => validateStep({ ...step, ...delta }));
});
test('idle calendar days cannot graduate a new mailbox', () => {
  const mailbox = { status: 'WARMING' as const, dailyCapStart: 5, dailyCapMax: 40, warmupGrowthPct: 20, warmupStartedAt: new Date('2026-01-01') };
  const load = { activeSendingDays: 0, sentToday: 0, sentLastHour: 0, hourlySlotFreesAt: null, rampHalted: false };
  assert.equal(dailyAllowance(mailbox, load, now), 5);
  assert.equal(dailyAllowance(mailbox, { ...load, activeSendingDays: 2 }, now), 7);
  assert.equal(dailyAllowance(mailbox, { ...load, activeSendingDays: 100, rampHalted: true }, now), 5);
});
test('domain status alone is insufficient without verified SPF and DKIM', () => {
  const m = { status: 'WARMING', pausedUntil: null, emailDomain: { status: 'ACTIVE', spfOk: true, dkimOk: true } } as any;
  assert.equal(isMailboxAvailable(m, now), true);
  assert.equal(isMailboxAvailable({ ...m, emailDomain: { ...m.emailDomain, dkimOk: null } }, now), false);
  assert.equal(isMailboxAvailable({ ...m, status: 'PAUSED' }, now), false);
});
test('a preferred address cannot escape its sender pool or sending purpose', async () => {
  stub(prisma.playbook, 'findFirst', async () => ({ senderPoolId: 'restricted', emailTransport: 'MAILGUN', gmailAccountId: null }));
  stub(prisma.mailbox, 'findFirst', async ({ where }: any) => {
    assert.deepEqual(where, { organizationId: 'org', address: 'outside@example.com', emailDomain: { purpose: 'COLD_OUTREACH' }, pools: { some: { poolId: 'restricted' } } });
    return null;
  });
  stub(prisma.mailbox, 'findMany', async ({ where }: any) => {
    assert.deepEqual(where.pools, { some: { poolId: 'restricted' } });
    return [];
  });
  stub(prisma.mailbox, 'count', async () => 1);
  const result = await resolveSenderDecision('org', { purpose: 'COLD_OUTREACH', playbookId: 'playbook', preferAddress: 'Outside@example.com', legacy: { apiKey: 'fixture', domain: 'example.com', fromEmail: 'outside@example.com' } });
  assert.equal(result.sender, null);
});
test('queued outreach rechecks a newly received reply even on the same channel', async () => {
  stub(prisma.lead, 'findFirst', async () => ({ ...held, id: 'lead', doNotContact: false, contactReviewReason: null }));
  assert.match((await automationSafetyReason('org', 'lead', 'EMAIL', null, true))!, /conversation is active/);
});
test('inactive and replied enrollments cannot send despite an otherwise contactable lead', async () => {
  stub(prisma.lead, 'findFirst', async () => ({ id: 'lead', status: 'CONTACTED', coldOutreachHeldAt: null, engagementChannel: null, doNotContact: false, contactReviewReason: null }));
  stub(prisma.campaignLead, 'findFirst', async () => ({ status: 'REPLIED', pausedAt: null, campaign: { status: 'ACTIVE' } }));
  assert.match((await automationSafetyReason('org', 'lead', 'EMAIL', 'campaign'))!, /already replied/);
});
test('omitting campaign ID cannot bypass an explicit sequence', async () => {
  stub(prisma.lead, 'findFirst', async () => ({ id: 'lead', status: 'NEW', coldOutreachHeldAt: null, engagementChannel: null, doNotContact: false, contactReviewReason: null }));
  stub(prisma.campaignLead, 'findFirst', async () => ({ id: 'enrollment' }));
  assert.match((await automationSafetyReason('org', 'lead', 'EMAIL'))!, /explicit sequence/);
});
test('contact reads are tenant scoped and stale validation fails before any provider request', async () => {
  stub(prisma.contact, 'findFirst', async (args: any) => { assert.deepEqual(args.where, { id: 'contact', organizationId: 'org' }); return { ...valid, emailVerifiedAt: null }; });
  assert.match((await emailSafetyReason('org', 'contact'))!, /verification/);
});
test('sequence exhaustion performs no writes and never invokes a provider', async () => {
  stub(prisma.campaignLead, 'findMany', async () => [{ touchCount: 1, lead: { contacts: [] } }]);
  stub(prisma, '$transaction', async () => { assert.fail('No transaction at sequence end'); });
  mock.method(globalThis, 'fetch', async () => { assert.fail('No provider call'); });
  assert.equal(await runExplicitSequence({ id: 'campaign', organizationId: 'org', sequenceSteps: [step], mode: 'AUTONOMOUS' }), 0);
});
test('concurrent and repeated sequence sweeps persist one message per lead/step, then append continues', async () => {
  const current = { ...valid, id: 'contact', emailVerifiedAt: new Date() };
  const lead = { id: 'lead', status: 'CONTACTED', groupId: null, coldOutreachHeldAt: null, engagementChannel: null, doNotContact: false, contactReviewReason: null, contacts: [current] };
  const row = { leadId: 'lead', touchCount: 0, lastTouchAt: null, nextTouchAt: null, lead };
  stub(prisma.campaignLead, 'findMany', async (args: any) => args.include ? [row] : [{ campaignId: 'campaign' }]);
  stub(prisma.campaignLead, 'findFirst', async () => ({ status: 'IN_SEQUENCE', pausedAt: null, campaign: { status: 'ACTIVE' } }));
  stub(prisma.lead, 'findFirst', async () => lead);
  stub(prisma.contact, 'findFirst', async () => current);
  stub(prisma.suppression, 'findFirst', async () => null);
  stub(prisma.organization, 'findUnique', async () => ({ name: 'Fixture', postalAddress: '1 Test Street' }));
  stub(prisma.playbook, 'findMany', async () => []);
  const messages = new Map<string, any>();
  stub(prisma.message, 'findMany', async () => row.touchCount ? [{ direction: 'OUTBOUND', campaignId: 'campaign', conversationId: 'conversation', conversation: { contactId: 'contact' } }] : []);
  const tx = {
    message: { findUnique: async ({ where }: any) => messages.get(where.sequenceKey) ?? null, create: async ({ data }: any) => { if (messages.has(data.sequenceKey)) throw Object.assign(new Error('duplicate'), { code: 'P2002' }); messages.set(data.sequenceKey, data); return data; } },
    conversation: { findFirst: async () => ({ id: 'conversation' }), findUnique: async () => ({ id: 'conversation' }) },
  };
  stub(prisma, '$transaction', async (fn: any) => fn(tx));
  mock.method(globalThis, 'fetch', async () => { assert.fail('Sequence composition must not send or validate externally'); });
  const campaign = { id: 'campaign', organizationId: 'org', sequenceSteps: [step], mode: 'APPROVAL_REQUIRED' };
  await Promise.all([runExplicitSequence(campaign), runExplicitSequence(campaign)]);
  assert.equal(messages.size, 1);
  assert.equal(messages.get('campaign:lead:one').status, 'draft_pending_approval');
  await runExplicitSequence(campaign);
  assert.equal(messages.size, 1);
  row.touchCount = 1;
  await runExplicitSequence({ ...campaign, sequenceSteps: [step, { ...step, id: 'two' }] });
  assert.equal(messages.size, 2);
  assert.ok(messages.has('campaign:lead:two'));
});
test('verification of a newly changed address cannot authorize sending to the stale address', async () => {
  stub(prisma.contact, 'findFirst', async () => ({ ...valid, email: 'new@example.com', emailVerifiedAddress: 'new@example.com', emailVerifiedAt: new Date() }));
  assert.match((await emailSafetyReason('org', 'contact', 'old@example.com'))!, /email changed/);
});
