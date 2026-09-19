import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/config/database';
import { runSenderHealthSweep } from '../src/services/sender-health.service';
import { suppress } from '../src/services/suppression.service';

const restores: (() => void)[] = [];
function stub(target: any, key: string, fn: any) {
  const original = target[key];
  const replacement = mock.fn(fn);
  target[key] = replacement;
  restores.push(() => { target[key] = original; });
  return replacement;
}
afterEach(() => { for (const restore of restores.splice(0).reverse()) restore(); mock.restoreAll(); });

for (const scenario of [
  { name: 'indefinite health pauses', reason: 'hard bounce rate 10.00% over 7d (3/30) — limit 5.00%', until: null, expected: 1 },
  { name: 'complaint health pauses', reason: 'spam complaint rate 2.00% over 7d (1/50) — limit 0.30%', until: null, expected: 1 },
  { name: 'legacy timed health pauses', reason: null, until: new Date('2026-09-20'), expected: 1 },
  { name: 'manual pauses', reason: 'Operator review', until: null, expected: 0 },
]) {
  test(`domain breaker handles ${scenario.name} even with no live mailboxes`, async () => {
    stub(prisma.mailbox, 'findMany', async () => []);
    stub(prisma.emailDomain, 'findMany', async () => [{
      id: 'domain', organizationId: 'org', domain: 'example.com',
      mailboxes: ['a', 'b'].map(id => ({ id, status: 'PAUSED', pausedUntil: scenario.until, pausedReason: scenario.reason })),
    }] as any);
    const updates = stub(prisma.emailDomain, 'updateMany', async (args: any) => {
      assert.equal(args.where.id, 'domain');
      assert.equal(args.data.status, 'PAUSED');
      return { count: 1 };
    });
    stub(prisma.notification, 'create', async () => { throw new Error('test: skip notification delivery'); });
    const result = await runSenderHealthSweep(new Date('2026-09-19T12:00:00Z'));
    assert.equal(result.domainsPaused, scenario.expected);
    assert.equal(updates.mock.callCount(), scenario.expected);
    assert.equal(result.mailboxesResumed, 0);
  });
}

test('suppression persistence failures propagate instead of reporting success', async () => {
  stub(prisma.suppression, 'upsert', async () => { throw new Error('database unavailable'); });
  await assert.rejects(suppress({ organizationId: 'org', kind: 'EMAIL', value: 'person@example.com', source: 'hard_bounce' }), /database unavailable/);
});

test('successful suppression normalizes the address and preserves the original record', async () => {
  stub(prisma.suppression, 'upsert', async (args: any) => {
    assert.equal(args.create.value, 'person@example.com');
    assert.deepEqual(args.update, {});
    return {} as any;
  });
  assert.equal(await suppress({ organizationId: 'org', kind: 'EMAIL', value: ' Person@Example.com ', source: 'hard_bounce' }), true);
});
