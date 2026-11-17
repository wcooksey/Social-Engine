import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { prisma } from '../src/config/database';
import { findEnrichmentTargets, recordEnrichmentAttempt, ENRICHMENT_CAPABILITY_VERSION } from '../src/services/lead-enrichment.service';

test('provider-blocked leads remain recoverable; cooldown does not delay other leads', { skip: process.env.ENRICHMENT_TEST_DB !== '1' }, async () => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55439');
  const org = await prisma.organization.create({ data: { name: 'Enrichment recovery fixture', slug: randomUUID(), paused: true } });
  try {
    const blocked = await prisma.lead.create({ data: { organizationId: org.id, companyName: 'Provider blocked fixture', phone: '555-0100', enrichmentVersion: ENRICHMENT_CAPABILITY_VERSION } });
    const fresh = await prisma.lead.create({ data: { organizationId: org.id, companyName: 'Untouched fixture' } });
    await prisma.lead.update({ where: { id: blocked.id }, data: { domain: 'example.test' } });
    const siteOnly = await findEnrichmentTargets(org.id, { requireWebsite: true, skipCurrentCapability: false });
    assert.deepEqual(siteOnly.targets.map(t => t.leadId), [blocked.id]);
    assert.equal((await findEnrichmentTargets(org.id, { requireWebsite: true, skipCurrentCapability: false, excludeLeadIds: [blocked.id] })).total, 0);
    await recordEnrichmentAttempt(org.id, blocked.id, 'blocked');
    const stored = await prisma.lead.findUniqueOrThrow({ where: { id: blocked.id } });
    assert.equal(stored.enrichmentVersion, 0);
    assert.equal(stored.enrichmentAttempts, 1);
    assert.ok(stored.lastEnrichmentAttemptAt);
    const normal = await findEnrichmentTargets(org.id);
    assert.ok(normal.targets.some(t => t.leadId === fresh.id));
    assert.ok(!normal.targets.some(t => t.leadId === blocked.id));
    const recovery = await findEnrichmentTargets(org.id, { cooldownHours: 0 });
    assert.ok(recovery.targets.some(t => t.leadId === blocked.id));
    await recordEnrichmentAttempt(org.id, blocked.id, 'no_new_data');
    const exhausted = await findEnrichmentTargets(org.id, { cooldownHours: 0 });
    assert.ok(!exhausted.targets.some(t => t.leadId === blocked.id));
    const forced = await findEnrichmentTargets(org.id, { cooldownHours: 0, skipCurrentCapability: false });
    assert.ok(forced.targets.some(t => t.leadId === blocked.id));
    await prisma.lead.update({ where: { id: blocked.id }, data: { doNotContact: true } });
    assert.ok(!(await findEnrichmentTargets(org.id, { cooldownHours: 0, skipCurrentCapability: false })).targets.some(t => t.leadId === blocked.id));
  } finally {
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.$disconnect();
  }
});
