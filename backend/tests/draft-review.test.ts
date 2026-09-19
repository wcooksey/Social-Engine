import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftReviewReasons } from '../src/services/draft-lifecycle.service';

const now = new Date('2026-09-19T18:00:00Z');
const input = {
  createdAt: now, sequenceKey: 'campaign:lead:step', campaignStatus: 'ACTIVE', sequenceEnabled: true,
  enrollment: { status: 'IN_SEQUENCE', pausedAt: null },
  lead: { status: 'NEW', doNotContact: false, contactReviewReason: null, coldOutreachHeldAt: null },
  contact: { email: 'owner@example.com', emailStatus: null, optedOut: false, emailVerifiedAt: now, emailVerifiedAddress: 'owner@example.com' },
  sentCount: 0, hasInbound: false, hasOtherPending: false, sharedRecipient: false, suppressed: false,
};
test('review reports overlapping stale, removed, legacy and shared-recipient reasons', () => {
  const reasons = draftReviewReasons({ ...input, createdAt: new Date('2026-09-14'), sequenceKey: null, enrollment: { status: 'REMOVED', pausedAt: null }, sharedRecipient: true }, now);
  assert.equal(reasons.length, 4);
  assert.ok(reasons.some(r => r.includes('three-day')));
  assert.ok(reasons.some(r => r.includes('Enrollment')));
  assert.ok(reasons.some(r => r.includes('Legacy')));
  assert.ok(reasons.some(r => r.includes('shared')));
});
test('review does not treat verified addresses as overriding suppression or history', () => {
  const reasons = draftReviewReasons({ ...input, suppressed: true, sentCount: 1, hasInbound: true, hasOtherPending: true }, now);
  assert.equal(reasons.length, 4);
  assert.ok(reasons.some(r => r.includes('suppressed')));
  assert.ok(reasons.some(r => r.includes('Prior outbound')));
});
test('fresh reviewed draft has no listed blockers; missing and stale verification remain blockers', () => {
  assert.deepEqual(draftReviewReasons(input, now), []);
  assert.ok(draftReviewReasons({ ...input, contact: null }, now).includes('No recipient contact'));
  assert.ok(draftReviewReasons({ ...input, contact: { ...input.contact, emailVerifiedAt: new Date('2026-08-01') } }, now).some(r => r.includes('stale')));
});
