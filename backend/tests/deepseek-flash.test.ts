import assert from 'node:assert/strict';
import test from 'node:test';
import { llmService, LlmChatRequest } from '../src/engine/llm/llm.service';
import { MODEL_CATALOG, estimateCostUsd } from '../src/engine/llm/catalog';

test('V4.1 Flash reuses DeepSeek credentials and supports a tool round trip', async (t) => {
  const requests: any[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(String(url), 'https://api.deepseek.com/chat/completions');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer test-deepseek-key');
    const body = JSON.parse(String(init.body));
    requests.push(body);
    assert.equal(body.model, 'deepseek-flash');
    assert.deepEqual(body.thinking, { type: 'disabled' });
    return new Response(JSON.stringify({
      choices: [{ message: requests.length === 1
        ? { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"id":42}' } }] }
        : { content: 'Found the record.' } }],
      usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 800 },
    }), { headers: { 'Content-Type': 'application/json' } });
  });

  const option = MODEL_CATALOG.find(m => m.id === 'deepseek-flash')!;
  assert.equal(option.label, 'DeepSeek V4.1 Flash');
  const request: LlmChatRequest = {
    model: option.id,
    system: 'Look up records.',
    messages: [{ role: 'user', content: 'Find record 42.' }],
    tools: [{ name: 'lookup', description: 'Look up a record', inputSchema: { type: 'object' } }],
  };
  const keys = { deepseek: 'test-deepseek-key' };
  const first = await llmService.chat(request, keys);
  assert.equal(first.provider, 'deepseek');
  assert.deepEqual(first.toolCalls[0].input, { id: 42 });
  assert.equal(first.usage.cachedInputTokens, 800);
  assert.ok(Math.abs(estimateCostUsd(option.id, 1000, 100, 800) - 0.0001848) < 1e-12);

  const second = await llmService.chat({ ...request, messages: [
    ...request.messages,
    { role: 'assistant', content: first.text, toolCalls: first.toolCalls },
    { role: 'tool', results: [{ toolCallId: 'call_1', name: 'lookup', content: 'Record 42' }] },
  ] }, keys);
  assert.equal(second.text, 'Found the record.');
  assert.deepEqual(requests[1].messages.at(-1), {
    role: 'tool', tool_call_id: 'call_1', content: 'Record 42',
  });
});
