import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { verifyEmail } from '../src/services/enrichment.service';

afterEach(() => mock.restoreAll());

test('Mailgun risk cannot be overridden by a deliverable mailbox result', async () => {
  for (const risk of ['medium', 'high']) {
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ result: 'deliverable', risk })));
    assert.equal((await verifyEmail('person@example.com', 'fixture')).verdict, 'risky');
    mock.restoreAll();
  }
});

test('validation accepts deliverable low risk and rejects ambiguous or prohibited results', async () => {
  for (const [result, risk, expected] of [
    ['deliverable', 'low', 'deliverable'],
    ['catch_all', 'low', 'risky'],
    ['unknown', 'unknown', 'unknown'],
    ['undeliverable', 'high', 'undeliverable'],
    ['do_not_send', 'high', 'undeliverable'],
  ]) {
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ result, risk })));
    assert.equal((await verifyEmail('person@example.com', 'fixture')).verdict, expected);
    mock.restoreAll();
  }
});

test('validation service failure never counts as successful verification', async () => {
  mock.method(globalThis, 'fetch', async () => new Response('Unavailable', { status: 503 }));
  assert.equal((await verifyEmail('person@example.com', 'fixture')).verdict, 'unavailable');
});
