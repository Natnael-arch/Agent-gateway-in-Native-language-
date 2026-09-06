// Unit tests for services/hermesClient.js failure detection.
//
// hermesClient runs the Hermes CLI via execFile and treats the output as a
// failure when EITHER the --usage-file flags a failed/incomplete run OR the
// raw stdout matches known error signatures (safety net). Both paths must
// reject with err.hermesFailure = true instead of forwarding error text to
// translation.
//
// Uses a committed fake_hermes.sh fixture whose behavior is selected via
// FAKE_HERMES_MODE. Note: hermesClient reads HERMES_BIN at module load, so env
// must be set before the require below.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

process.env.HERMES_BIN = path.join(__dirname, 'fixtures', 'fake_hermes.sh');

const { sendTask } = require('../services/hermesClient');

async function run(mode, sessionId = 'u1') {
  process.env.FAKE_HERMES_MODE = mode;
  return sendTask('Some prompt', { sessionId });
}

test('success: resolves with a response when usage-file completed', async () => {
  const result = await run('success');
  assert.match(result.responseText, /Paris/);
  assert.strictEqual(result.requiresConfirmation, false);
  assert.strictEqual(result.usage.completed, true);
  assert.strictEqual(result.usage.failed, false);
});

test('safety net: rejects when usage-file marks failed:true even on exit 0', async () => {
  await assert.rejects(
    run('fail_sse_stdout'),
    (err) => {
      assert.strictEqual(err.hermesFailure, true);
      assert.match(err.message, /failure/);
      assert.match(err.rawOutput, /API call failed/);
      return true;
    }
  );
});

test('safety net: rejects via stdout patterns when usage-file is absent', async () => {
  await assert.rejects(
    run('fail_empty_usage'),
    (err) => {
      assert.strictEqual(err.hermesFailure, true);
      assert.strictEqual(err.usage, null);
      assert.match(err.rawOutput, /API call failed/);
      return true;
    }
  );
});

test('non-failure fallback mode also resolves cleanly', async () => {
  const result = await run('other');
  assert.match(result.responseText, /meaning of life/);
  assert.strictEqual(result.usage.completed, true);
});