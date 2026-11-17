import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeVapiCall, toE164 } from '../src/services/channels.service';
import { buildCallVariables } from '../src/engine/prompts';

const baseCreds = { apiKey: 'k', phoneNumberId: 'pn', assistantModel: 'gpt-4o', voiceProvider: '11labs', voiceId: 'burt' };
const opts = {
  toNumber: '(813) 555-0100',
  systemPrompt: 'SYSTEM',
  firstMessage: 'Hi',
  voicemailMessage: 'VM',
  metadata: { organizationId: 'org', leadId: 'lead' },
  server: { url: 'https://app.example/api/webhooks/vapi', secret: 's' },
  tools: [{ type: 'function', function: { name: 'book_meeting' } }],
  variableValues: { companyName: 'Acme Motors' },
};

async function capture(creds: typeof baseCreds & { assistantId?: string }) {
  const original = globalThis.fetch;
  let body: any;
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: 'call_1' }), { status: 200 });
  }) as never;
  try {
    const result = await placeVapiCall(opts, creds);
    return { body, result };
  } finally {
    globalThis.fetch = original;
  }
}

test('a saved assistant is called by id with lead variables, our webhook and appended tools', async () => {
  const { body, result } = await capture({ ...baseCreds, assistantId: 'asst_123' });
  assert.equal(result.sent, true);
  assert.equal(body.customer.number, '+18135550100');
  assert.equal(body.assistantId, 'asst_123');
  assert.equal(body.assistant, undefined, 'must not also send an inline assistant');
  assert.deepEqual(body.assistantOverrides.variableValues, { companyName: 'Acme Motors' });
  assert.deepEqual(body.assistantOverrides.metadata, opts.metadata);
  assert.deepEqual(body.metadata, opts.metadata);
  assert.equal(body.assistantOverrides.server.url, opts.server.url);
  assert.deepEqual(body.assistantOverrides.serverMessages, ['end-of-call-report', 'tool-calls']);
  assert.equal(body.assistantOverrides['tools:append'].length, 1);
  // The dashboard assistant keeps its own script and greeting.
  assert.equal(body.assistantOverrides.firstMessage, undefined);
  assert.equal(body.assistantOverrides.model, undefined);
});

test('without a saved assistant the inline assistant is unchanged', async () => {
  const { body } = await capture(baseCreds);
  assert.equal(body.assistantId, undefined);
  assert.equal(body.assistantOverrides, undefined);
  assert.equal(body.assistant.model.messages[0].content, 'SYSTEM');
  assert.equal(body.assistant.firstMessage, 'Hi');
  assert.equal(body.assistant.voicemailMessage, 'VM');
});

test('call variables always define every key and summarise the lead', () => {
  const vars = buildCallVariables({
    organizationName: 'Dealegent',
    objective: 'Book a demo',
    lead: { companyName: 'Acme Motors', contactName: 'Jane Doe', contactTitle: 'GM', status: 'NEW', aiSummary: 'Used car lot.', recentTimeline: ['EMAIL_SENT: intro'], city: 'Tampa', state: 'FL' },
  });
  assert.equal(vars.contactFirstName, 'Jane');
  assert.equal(vars.website, '');
  assert.match(vars.leadContext, /Acme Motors/);
  assert.match(vars.leadContext, /Jane Doe \(GM\)/);
  assert.match(vars.leadContext, /Tampa, FL/);
  assert.match(vars.leadContext, /Book a demo/);
  const bare = buildCallVariables({ organizationName: 'D', objective: 'o', lead: { companyName: 'X', status: 'NEW', recentTimeline: [] } });
  assert.deepEqual(Object.keys(bare).sort(), Object.keys(vars).sort());
  assert.equal(bare.contactFirstName, '');
});

test('numbers are dialled in E.164, and undialable ones are refused before reaching Vapi', async () => {
  assert.equal(toE164('(813) 555-0100'), '+18135550100');
  assert.equal(toE164('813.555.0100 x12'), '+18135550100');
  assert.equal(toE164('1-813-555-0100'), '+18135550100');
  assert.equal(toE164('+44 20 7946 0958'), '+442079460958');
  assert.equal(toE164('555-0100'), null);
  assert.equal(toE164(''), null);
  const result = await placeVapiCall({ ...opts, toNumber: '555-0100' }, baseCreds);
  assert.equal(result.sent, false);
  assert.match(result.error || '', /not a dialable phone number/);
});
