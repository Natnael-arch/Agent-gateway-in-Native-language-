/**
 * Verification Test Suite for Amharic Agent Gateway
 * Tests end-to-end pipeline, confirmation gate, session handling, logging, and error handling.
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

async function runTests() {
  console.log('🧪 Starting Amharic Agent Gateway Verification Suite...\n');

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
    // Test 2: Standard Amharic Chat Request Pipeline
    // -------------------------------------------------------------
    console.log('Test 2: POST /api/chat (Standard request flow)');
    const chatRes = await makeRequest('/api/chat', 'POST', {
      text: 'ሰላም እንደምን አለህ? 5 + 5 ስንት ነው?',
      sessionId: 'test-session-123'
    });
    console.log('Chat Response:', chatRes.body);

    if (chatRes.statusCode !== 200 || !chatRes.body.amharicResponse) {
      throw new Error(`Chat pipeline failed: ${JSON.stringify(chatRes.body)}`);
    }
    console.log('✅ Test 2 Passed! Amharic response returned cleanly.\n');

    // -------------------------------------------------------------
    // Test 3: Consequential Action Detection & Confirmation Gate
    // -------------------------------------------------------------
    console.log('Test 3: Consequential Action Detection & Confirmation Gate');

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

    // Execute Confirmation via POST /api/confirm
    console.log('Submitting user confirmation for token...');
    const confirmRes = await makeRequest('/api/confirm', 'POST', {
      confirmation_token: token
    });
    console.log('Confirmation Endpoint Response:', confirmRes.body);

    if (confirmRes.statusCode !== 200 || !confirmRes.body.actionExecuted) {
      throw new Error(`Action confirmation execution failed: ${JSON.stringify(confirmRes.body)}`);
    }
    console.log('✅ Test 3 Passed! Consequential action gated & confirmed successfully.\n');

    // -------------------------------------------------------------
    // Test 4: Error Handling & Validation
    // -------------------------------------------------------------
    console.log('Test 4: Input Validation Error Handling');
    const badReqRes = await makeRequest('/api/chat', 'POST', { text: '' });
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

    console.log('🎉 ALL TESTS PASSED SUCCESSFULLY!');

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
