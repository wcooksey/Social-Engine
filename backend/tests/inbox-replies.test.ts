import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { isHumanReply } from '../src/services/reply-classification';
import router from '../src/routes/conversations.routes';
import { prisma } from '../src/config/database';
import { warmupProgress } from '../src/services/sender.service';

const restores: (() => void)[] = [];
function stub(target: any, key: string, fn: any) { const original = target[key]; target[key] = fn; restores.push(() => { target[key] = original; }); }
afterEach(() => { for (const restore of restores.splice(0).reverse()) restore(); mock.restoreAll(); });

test('human replies include opt-outs, exclude automatic replies and outbound messages', () => {
  const incoming = { direction: 'INBOUND', body: 'Sure, send the video.' };
  assert.equal(isHumanReply(incoming), true);
  assert.equal(isHumanReply({ ...incoming, body: 'Please unsubscribe me.' }), true);
  assert.equal(isHumanReply({ ...incoming, body: 'I am out of office until Monday.' }), false);
  assert.equal(isHumanReply({ ...incoming, subject: 'Automatic reply' }), false);
  assert.equal(isHumanReply({ ...incoming, direction: 'OUTBOUND' }), false);
  assert.equal(isHumanReply({ ...incoming, provenance: { replyKind: 'automated' } }), false);
  assert.equal(isHumanReply({ ...incoming, provenance: { replyKind: 'human' } }, 'Automatic reply'), true);
});

test('human reply filtering happens before pagination and preserves group and organization scope', async () => {
  stub(prisma.leadGroup, 'findFirst', async () => ({ id: 'group' }) as any);
  stub(prisma.message, 'findMany', async ({ where }: any) => {
    assert.equal(where.direction, 'INBOUND');
    assert.equal(where.conversation.organizationId, 'org');
    assert.equal(where.conversation.lead.groupId, 'group');
    assert.equal(where.conversation.channel, 'EMAIL');
    return Array.from({ length: 27 }, (_, i) => ({ conversationId: `c${i}`, direction: 'INBOUND', subject: null, body: i === 26 ? 'This is an automated reply.' : 'Please send the video.', provenance: null, conversation: { subject: 'Quick question' } })) as any;
  });
  let countWhere: unknown;
  stub(prisma.conversation, 'count', async ({ where }: any) => { countWhere = where; return where.id.in.length; });
  stub(prisma.conversation, 'findMany', async ({ where, skip, take }: any) => {
    assert.equal(where.id.in.length, 26);
    assert.equal(skip, 25);
    assert.equal(take, 25);
    return [{ id: 'c25', channel: 'EMAIL', lead: {}, contact: null, _count: { messages: 3 }, messages: [{ direction: 'OUTBOUND', body: 'Here is the video.', status: 'sent' }] }] as any;
  });
  const handler = (router as any).stack.find((layer: any) => layer.route?.path === '/' && layer.route.methods.get).route.stack[0].handle;
  const result: any = await new Promise((resolve, reject) => handler({ user: { organizationId: 'org' }, query: { groupId: 'group', channel: 'EMAIL', replies: 'human', page: '2' } }, { json: resolve }, reject));
  assert.equal(result.data.total, 26);
  assert.equal(result.data.conversations[0].lastMessage.direction, 'OUTBOUND');
  assert.equal((countWhere as any).id.in.includes('c26'), false);
});

test('warmup progress counts sending days rather than idle calendar days and respects health holds', () => {
  const mailbox = { status: 'WARMING' as const, dailyCapStart: 5, dailyCapMax: 40, warmupGrowthPct: 20, warmupStartedAt: new Date('2026-08-01') };
  const load = { activeSendingDays: 2, sentToday: 7, sentLastHour: 0, hourlySlotFreesAt: null, rampHalted: false };
  const now = new Date('2026-09-15T12:00:00Z');
  assert.deepEqual(warmupProgress(mailbox, load, now), { activeSendingDays: 2, remainingSendingDays: 10 });
  assert.equal(warmupProgress(mailbox, { ...load, rampHalted: true }, now).remainingSendingDays, null);
  assert.equal(warmupProgress({ ...mailbox, status: 'ACTIVE' }, load, now).remainingSendingDays, 0);
});
