import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { checkInboundEmail, routeCoversDomain } from '../src/services/inbound-health.service';
import { config } from '../src/config/environment';

test('reply checks use registered domains, preserve Google-hosted legacy domain, and require correct route scope', async () => {
  const before = { url: config.appPublicUrl, secret: config.inbound.webhookSecret };
  config.appPublicUrl = 'https://app.example.com';
  config.inbound.webhookSecret = 'fixture-only';
  const requested: string[] = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (url: any) => {
    requested.push(String(url));
    const payload = String(url).includes('/routes')
      ? { items: [{ expression: 'catch_all()', actions: ['forward("https://app.example.com/api/webhooks/inbound/email?secret=fixture-only")'] }] }
      : { receiving_dns_records: [{ valid: 'valid', record_type: 'MX', value: 'mxa.mailgun.org' }], domain: {} };
    return new Response(JSON.stringify(payload), { status: 200 });
  });
  try {
    const result = await checkInboundEmail({ apiKey: 'fixture-only', domain: 'google-hosted.example', fromEmail: '' } as any, [], ['outreach-one.example', 'outreach-two.example']);
    assert.equal(result.ok, true);
    assert.equal(result.checks.filter(c => c.key === 'mx').length, 2);
    assert.equal(result.checks.filter(c => c.key === 'secret').length, 1);
    assert.ok(requested.some(url => url.includes('/domains/outreach-one.example')));
    assert.ok(requested.some(url => url.includes('/domains/outreach-two.example')));
    assert.ok(requested.every(url => !url.includes('google-hosted.example')));
    assert.ok(result.checks.find(c => c.key === 'mx')?.label.startsWith('outreach-one.example'));
    assert.equal(routeCoversDomain('match_recipient(".*@other.example")', 'outreach-one.example'), false);
    assert.equal(routeCoversDomain('match_recipient(".*@outreach-one.example")', 'outreach-one.example'), true);
    assert.equal(routeCoversDomain('match_recipient("^.*@outreach-one\\.example$")', 'outreach-one.example'), true);
  } finally {
    fetchMock.mock.restore(); config.appPublicUrl = before.url; config.inbound.webhookSecret = before.secret;
  }
});
