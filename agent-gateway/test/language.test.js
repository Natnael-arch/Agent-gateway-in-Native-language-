const { test, before, after } = require('node:test');
const assert = require('node:assert');

const express = require('express');

// ---------------------------------------------------------------------------
// Stub the two service modules BEFORE loading the router so that we can
// deterministically exercise every branch (including the confirmation gate)
// without spinning up a real Hermes agent or real Addis AI calls.
// ---------------------------------------------------------------------------
const calls = { translateIn: 0, translateOut: 0, hermes: [] };

const translatorStub = {
  translateToEnglish: async (text) => {
    calls.translateIn += 1;
    return { translation: `[EN] ${text}`, durationMs: 111, usage: { prompt_token_count: 1 } };
  },
  translateToAmharic: async (text) => {
    calls.translateOut += 1;
    return { translation: `[AM] ${text}`, durationMs: 222, usage: { prompt_token_count: 2 } };
  }
};

let confirmMode = false;
let hermesResult = {
  responseText: 'Send 500 birr to account 987654',
  requiresConfirmation: false,
  actionDetails: null,
  usage: { provider: 'deepseek' },
  sessionId: 'hermes-session-123',
  durationMs: 55
};

const hermesClientStub = {
  sendTask: async (text, opts) => {
    calls.hermes.push({ text, opts });
    if (confirmMode) {
      return {
        ...hermesResult,
        requiresConfirmation: true,
        actionDetails: { text: hermesResult.responseText }
      };
    }
    return { ...hermesResult };
  }
};

require.cache[require.resolve('../services/translator')] = {
  id: require.resolve('../services/translator'),
  filename: require.resolve('../services/translator'),
  loaded: true,
  exports: translatorStub
};
require.cache[require.resolve('../services/hermesClient')] = {
  id: require.resolve('../services/hermesClient'),
  filename: require.resolve('../services/hermesClient'),
  loaded: true,
  exports: hermesClientStub
};

const handleRequestRouter = require('../routes/handleRequest');

let server;
let base;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', handleRequestRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
});

async function postSSE(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  const events = text
    .split('\n\n')
    .filter((b) => b.trim())
    .map((b) => JSON.parse(b.split('\n').filter((l) => l.startsWith('data: '))[0].substring(6)));
  return events;
}

test('POST /api/session/language validates input', async () => {
  const ok = await fetch(`${base}/api/session/language`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', language: 'en' })
  });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(await ok.json(), { status: 'ok', sessionId: 's1', language: 'en' });

  const bad = await fetch(`${base}/api/session/language`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', language: 'fr' })
  });
  assert.strictEqual(bad.status, 400);

  const empty = await fetch(`${base}/api/session/language`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1' })
  });
  assert.strictEqual(empty.status, 400);
});

test('English session: Hermes-only pipeline (no translation hops, null timings)', async () => {
  calls.translateIn = 0;
  calls.translateOut = 0;

  await fetch(`${base}/api/session/language`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 's-en', language: 'en' })
  });

  const events = await postSSE('/api/chat', { sessionId: 's-en', text: 'Tell me a joke' });
  const stages = events.filter((e) => e.type === 'stage' && e.status === 'start').map((e) => e.stage);
  const result = events.find((e) => e.type === 'result');

  assert.deepStrictEqual(stages, ['hermes']);
  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.language, 'en');
  assert.strictEqual(result.amharicResponse, 'Send 500 birr to account 987654');
  assert.strictEqual(result.timing.translateInMs, null);
  assert.strictEqual(result.timing.translateOutMs, null);
  assert.strictEqual(calls.translateIn, 0);
  assert.strictEqual(calls.translateOut, 0);
});

test('Amharic session: 3-hop pipeline (both translation hops called)', async () => {
  calls.translateIn = 0;
  calls.translateOut = 0;

  await fetch(`${base}/api/session/language`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 's-am', language: 'am' })
  });

  const events = await postSSE('/api/chat', { sessionId: 's-am', text: '5 + 5 ስንት ነው?' });
  const stages = events.filter((e) => e.type === 'stage' && e.status === 'start').map((e) => e.stage);
  const result = events.find((e) => e.type === 'result');

  assert.deepStrictEqual(stages, ['translate_in', 'hermes', 'translate_out']);
  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.language, 'am');
  assert.strictEqual(result.amharicResponse, '[AM] Send 500 birr to account 987654');
  assert.strictEqual(result.timing.translateInMs, 111);
  assert.strictEqual(result.timing.translateOutMs, 222);
  assert.strictEqual(calls.translateIn, 1);
  assert.strictEqual(calls.translateOut, 1);
});

test("Amharic session defaults to 'am' when unset", async () => {
  calls.translateIn = 0;
  const events = await postSSE('/api/chat', { sessionId: 's-default', text: 'hello' });
  const stages = events.filter((e) => e.type === 'stage' && e.status === 'start').map((e) => e.stage);
  assert.deepStrictEqual(stages, ['translate_in', 'hermes', 'translate_out']);
});

test('Confirmation gate fires in English mode without translation calls', async () => {
  confirmMode = true;
  calls.translateIn = 0;
  calls.translateOut = 0;

  await fetch(`${base}/api/session/language`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 's-gate-en', language: 'en' })
  });

  const events = await postSSE('/api/chat', { sessionId: 's-gate-en', text: 'Send 500 birr' });
  const result = events.find((e) => e.type === 'result');

  assert.strictEqual(result.status, 'confirmation_required');
  assert.strictEqual(result.requires_confirmation, true);
  assert.ok(result.confirmation_token && result.confirmation_token.startsWith('conf_'));
  // English users see the raw Hermes action text, untranslated.
  assert.strictEqual(result.amharic_action_description, 'Send 500 birr to account 987654');
  assert.strictEqual(calls.translateIn, 0);
  assert.strictEqual(calls.translateOut, 0);

  confirmMode = false;
});

test('Confirmation gate fires in Amharic mode with translated action text', async () => {
  confirmMode = true;
  calls.translateIn = 0;
  calls.translateOut = 0;

  const events = await postSSE('/api/chat', { sessionId: 's-gate-am', text: '500 ብር ላክ' });
  const result = events.find((e) => e.type === 'result');

  assert.strictEqual(result.status, 'confirmation_required');
  assert.strictEqual(result.requires_confirmation, true);
  assert.ok(result.confirmation_token && result.confirmation_token.startsWith('conf_'));
  // Amharic users see the translated (out) action text.
  assert.strictEqual(result.amharic_action_description, '[AM] Send 500 birr to account 987654');
  assert.strictEqual(calls.translateOut, 1);

  confirmMode = false;
});