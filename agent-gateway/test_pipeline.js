/**
 * Verification Test Suite for Amharic Agent Gateway (SSE Streaming enabled)
 * Tests end-to-end SSE pipeline stage events, result payloads, confirmation gate, session handling, logging, and error handling.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const app = require('./server');
const { processConfirmationGate } = require('./middleware/confirmationGate');

const PORT = 3099;
let server;

function makeRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: 'localhost',
      port: PORT,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {})
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ statusCode: res.statusCode, rawBody: data });
        }
      });
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function makeSSERequest(path, method = 'POST', body = null) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: 'localhost',
      port: PORT,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {})
      }
    }, (res) => {
      if (res.statusCode >= 400 && res.headers['content-type']?.includes('application/json')) {
        let rawData = '';
        res.on('data', chunk => rawData += chunk);
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode, body: JSON.parse(rawData), events: [] });
          } catch (e) {
            resolve({ statusCode: res.statusCode, rawBody: rawData, events: [] });
          }
        });
        return;
      }

      const events = [];
      let buffer = '';

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop();

        for (const block of blocks) {
          const trimmed = block.trim();
          if (!trimmed) continue;

          for (const line of trimmed.split('\n')) {
            if (line.startsWith('data: ')) {
              try {
                events.push(JSON.parse(line.substring(6)));
              } catch (e) {
                // ignore non-json line
              }
            }
          }
        }
      });

      res.on('end', () => {
        if (buffer.trim().startsWith('data: ')) {
          try {
            events.push(JSON.parse(buffer.trim().substring(6)));
          } catch (e) {}
        }
        resolve({ statusCode: res.statusCode, events });
      });
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function runTests() {
  console.log('🧪 Starting Amharic Agent Gateway Verification Suite (SSE Stream mode)...\n');

  // Start test server instance
  await new Promise((resolve) => {
    server = app.listen(PORT, resolve);
  });

  try {
    // -------------------------------------------------------------
    // Test 1: Health Endpoint Check
    // -------------------------------------------------------------
    console.log('Test 1: GET /health');
    const healthRes = await makeRequest('/health');
    console.log('Health Response:', healthRes.body);
    if (healthRes.statusCode !== 200 || healthRes.body.status !== 'online') {
      throw new Error('Health check failed');
    }
    console.log('✅ Test 1 Passed!\n');

    // -------------------------------------------------------------
    // Test 2: Standard Amharic Chat Request Pipeline via SSE
    // -------------------------------------------------------------
    console.log('Test 2: POST /api/chat (SSE streaming flow)');
    const chatSseRes = await makeSSERequest('/api/chat', 'POST', {
      text: 'ሰላም እንደምን አለህ? 5 + 5 ስንት ነው?',
      sessionId: 'test-session-123'
    });

    if (chatSseRes.statusCode !== 200) {
      throw new Error(`Chat request returned HTTP status ${chatSseRes.statusCode}`);
    }

    const stageEvents = chatSseRes.events.filter(e => e.type === 'stage');
    const resultEvents = chatSseRes.events.filter(e => e.type === 'result');
    const errorEvents = chatSseRes.events.filter(e => e.type === 'error');

    console.log(`Received ${stageEvents.length} stage event(s), ${resultEvents.length} result event(s).`);

    // Verify stage event order and start/done pairs
    const expectedStages = ['translate_in', 'hermes', 'translate_out'];
    for (const stageName of expectedStages) {
      const startEv = stageEvents.find(e => e.stage === stageName && e.status === 'start');
      const doneEv = stageEvents.find(e => e.stage === stageName && e.status === 'done');

      if (!startEv || !doneEv) {
        throw new Error(`Missing start or done event for stage "${stageName}"`);
      }

      const startIdx = stageEvents.indexOf(startEv);
      const doneIdx = stageEvents.indexOf(doneEv);

      if (startIdx >= doneIdx) {
        throw new Error(`Stage "${stageName}" start event (index ${startIdx}) must precede done event (index ${doneIdx})`);
      }

      if (typeof doneEv.durationMs !== 'number') {
        throw new Error(`Stage "${stageName}" done event missing valid durationMs`);
      }
    }

    // Verify correct stage sequence order
    const stageSequence = stageEvents.filter(e => e.status === 'start').map(e => e.stage);
    if (JSON.stringify(stageSequence) !== JSON.stringify(expectedStages)) {
      throw new Error(`Invalid stage order: expected ${JSON.stringify(expectedStages)}, got ${JSON.stringify(stageSequence)}`);
    }

    // Verify exactly one final result event
    if (resultEvents.length !== 1 || errorEvents.length !== 0) {
      throw new Error(`Expected exactly 1 result event and 0 error events. Got ${resultEvents.length} results, ${errorEvents.length} errors.`);
    }

    const finalResult = resultEvents[0];
    if (finalResult.status !== 'success' || !finalResult.amharicResponse) {
      throw new Error(`Invalid final result payload: ${JSON.stringify(finalResult)}`);
    }

    console.log('Final Result Event Payload:', finalResult);
    console.log('✅ Test 2 Passed! Stage events & final result verified.\n');

    // -------------------------------------------------------------
    // Test 3: Consequential Action Detection & Confirmation Gate via SSE
    // -------------------------------------------------------------
    console.log('Test 3: Consequential Action Detection & Confirmation Gate (SSE)');

    const fakeHermesConsequential = {
      responseText: 'Transfer 500 ETB to account 987654',
      requiresConfirmation: true,
      actionDetails: { action: 'transfer', amount: 500 }
    };

    const gateResult = processConfirmationGate(
      fakeHermesConsequential,
      '500 የኢትዮጵያ ብር ወደ አካውንት 987654 መላክ',
      'test-session-123'
    );

    const token = gateResult.confirmationPayload.confirmation_token;
    console.log('Generated Confirmation Token:', token);

    // Execute Confirmation via POST /api/confirm SSE
    console.log('Submitting user confirmation for token via SSE...');
    const confirmSseRes = await makeSSERequest('/api/confirm', 'POST', {
      confirmation_token: token
    });

    if (confirmSseRes.statusCode !== 200) {
      throw new Error(`Confirmation endpoint failed with HTTP ${confirmSseRes.statusCode}`);
    }

    const confirmResultEvents = confirmSseRes.events.filter(e => e.type === 'result');
    if (confirmResultEvents.length !== 1 || !confirmResultEvents[0].actionExecuted) {
      throw new Error(`Action confirmation execution failed: ${JSON.stringify(confirmSseRes.events)}`);
    }
    console.log('Confirmation Result Event Payload:', confirmResultEvents[0]);
    console.log('✅ Test 3 Passed! Consequential action gated & confirmed successfully over SSE.\n');

    // -------------------------------------------------------------
    // Test 4: Error Handling & Validation
    // -------------------------------------------------------------
    console.log('Test 4: Input Validation Error Handling');
    const badReqRes = await makeSSERequest('/api/chat', 'POST', { text: '' });
    console.log('Bad Request Response:', badReqRes.body);

    if (badReqRes.statusCode !== 400) {
      throw new Error('Expected status 400 for empty text');
    }
    console.log('✅ Test 4 Passed!\n');

    // -------------------------------------------------------------
    // Test 5: Verify Structured JSON Log File
    // -------------------------------------------------------------
    console.log('Test 5: Checking structured log output');
    const logFilePath = path.join(__dirname, 'logs', 'gateway.jsonl');
    if (!fs.existsSync(logFilePath)) {
      throw new Error('Log file was not generated');
    }
    const logLines = fs.readFileSync(logFilePath, 'utf8').trim().split('\n');
    console.log(`Log File contains ${logLines.length} line(s). Sample entry:`);
    console.log(JSON.parse(logLines[logLines.length - 1]));
    console.log('✅ Test 5 Passed!\n');

    console.log('🎉 ALL SSE PIPELINE TESTS PASSED SUCCESSFULLY!');

  } catch (err) {
    console.error('❌ Test failed:', err);
    process.exitCode = 1;
  } finally {
    if (server) {
      server.close();
    }
  }
}

runTests();
