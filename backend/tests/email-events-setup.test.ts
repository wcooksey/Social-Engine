import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config/environment';
import { setupDomainEvents } from '../src/services/email-events-setup.service';

test('event setup preserves destinations, verifies writes, is idempotent, and never sends', async () => {
  const oldFetch = globalThis.fetch, oldUrl = config.appPublicUrl, oldSecret = config.inbound.webhookSecret;
  config.appPublicUrl = 'https://fixture.example'; config.inbound.webhookSecret = 'fixture-secret';
  const webhooks: Record<string, { urls: string[] }> = { delivered: { urls: ['https://other.example/events'] } };
  let writes = 0;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    assert.ok(url.startsWith('https://api.mailgun.net/v3/domains/example.com/webhooks'));
    assert.ok(!url.includes('/messages'));
    const event = url.split('/webhooks/')[1];
    if (init.method) {
      writes++;
      const body = init.body as FormData;
      const id = event || String(body.get('id'));
      webhooks[id] = { urls: body.getAll('url').map(String) };
    }
    return new Response(JSON.stringify(event ? { webhook: webhooks[event] } : { webhooks }), { status: 200 });
  }) as typeof fetch;
  try {
    assert.ok((await setupDomainEvents('example.com', 'fixture')).every(c => !c.ok));
    assert.equal(writes, 0);
    assert.ok((await setupDomainEvents('example.com', 'fixture', true)).every(c => c.ok));
    assert.equal(writes, 4);
    assert.ok(webhooks.delivered.urls.includes('https://other.example/events'));
    assert.ok((await setupDomainEvents('example.com', 'fixture', true)).every(c => c.ok));
    assert.equal(writes, 4);
    assert.ok(!JSON.stringify(await setupDomainEvents('example.com', 'fixture')).includes('fixture-secret'));
    webhooks.delivered.urls = ['https://one.example', 'https://two.example', 'https://three.example'];
    assert.equal((await setupDomainEvents('example.com', 'fixture', true))[0].ok, false);
    assert.equal(writes, 4);
  } finally { globalThis.fetch = oldFetch; config.appPublicUrl = oldUrl; config.inbound.webhookSecret = oldSecret; }
});
