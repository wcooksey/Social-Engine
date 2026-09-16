import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { continuationReason, transitionPreview } from '../src/services/sequence-transition.service';
import { prisma } from '../src/config/database';
import { runOutboundQueueSweep } from '../src/services/outbound-queue.service';

const contact = { email: 'dealer@example.com', emailVerifiedAddress: 'dealer@example.com', emailVerifiedAt: new Date(), optedOut: false, emailStatus: null };
const row = { id: 'enrollment', leadId: 'lead', campaignId: 'campaign', status: 'COMPLETED', touchCount: 1, pausedAt: null, lead: { status: 'CONTACTED', companyName: 'Dealer' } };
const sent = { direction: 'OUTBOUND', campaignId: 'campaign', sentAt: new Date(), conversation: { leadId: 'lead', contact } };
const restores: (() => void)[] = [];
function stub(target: any, key: string, fn: any) { const original = target[key]; target[key] = fn; restores.push(() => { target[key] = original; }); }
afterEach(() => { for (const restore of restores.splice(0).reverse()) restore(); mock.restoreAll(); });

test('continuation preserves completed introductions and excludes unsafe history', () => {
  assert.equal(continuationReason(row, [sent], false), null);
  for (const status of ['REMOVED', 'REPLIED']) assert.ok(continuationReason({ ...row, status }, [sent], false));
  assert.ok(continuationReason({ ...row, pausedAt: new Date() }, [sent], false));
  assert.ok(continuationReason(row, [sent], true));
  assert.ok(continuationReason(row, [sent, sent], false));
  assert.ok(continuationReason(row, [{ ...sent, campaignId: 'other' }], false));
  assert.ok(continuationReason({ ...row, touchCount: 0, status: 'PENDING' }, [], false));
  assert.ok(continuationReason(row, [{ ...sent, conversation: { contact: { ...contact, emailStatus: 'bounced' } } }], false));
});

test('preview excludes suppressed recipients without writes', async () => {
  const db = {
    campaign: { findFirst: async () => ({ status: 'PAUSED', maxTouches: 1, channels: ['EMAIL'] }) },
    campaignLead: { findMany: async () => [row] },
    message: { findMany: async () => [sent] },
    suppression: { findMany: async () => [{ kind: 'EMAIL', value: contact.email }] }
  };
  const preview = await transitionPreview(db, 'org', 'campaign');
  assert.deepEqual(preview.eligible, []);
  assert.equal(preview.excluded['Previous recipient is suppressed'], 1);
});

test('queue claims due follow-ups before introductions', async () => {
  const claims: string[] = [];
  stub(prisma.message, 'findMany', async ({ where, take }: any) => {
    if (where.provenance) return [{ id: 'followup' }];
    assert.equal(take, 49);
    assert.deepEqual(where.id.notIn, ['followup']);
    return [{ id: 'introduction' }];
  });
  stub(prisma.message, 'updateMany', async ({ where }: any) => {
    if (where.id) claims.push(where.id);
    return { count: 0 };
  });
  await runOutboundQueueSweep();
  assert.deepEqual(claims, ['followup', 'introduction']);
});
