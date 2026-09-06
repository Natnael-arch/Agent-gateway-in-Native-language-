/**
 * Interactive Amharic CLI client for testing the Agent Gateway with live SSE status updates
 * Usage: node cli.js "<Amharic Text>"
 *        node cli.js --confirm <confirmation_token>
 */

const http = require('http');

const PORT = process.env.PORT || 3000;
const args = process.argv.slice(2);

if (args.length === 0) {
  console.log('🇪🇹 Agelgay CLI Client');
  console.log('Usage: node cli.js "<Amharic Text>"');
  console.log('       node cli.js --confirm <confirmation_token>');
  console.log('Example: node cli.js "ሰላም፤ ዛሬ አየሩ እንዴት ነው?"');
  process.exit(0);
}

let isConfirm = false;
let confirmToken = null;
let inputPrompt = null;

if (args[0] === '--confirm') {
  isConfirm = true;
  confirmToken = args[1];
  if (!confirmToken) {
    console.error('❌ Missing confirmation token. Usage: node cli.js --confirm <token>');
    process.exit(1);
  }
} else {
  inputPrompt = args.join(' ');
}

const reqPath = isConfirm ? '/api/confirm' : '/api/chat';
const reqBody = isConfirm
  ? JSON.stringify({ confirmation_token: confirmToken })
  : JSON.stringify({ text: inputPrompt, sessionId: 'cli-user-session' });

if (isConfirm) {
  console.log(`\n📤 Confirming action token: "${confirmToken}"`);
  console.log('⏳ Processing confirmation...\n');
} else {
  console.log(`\n📤 Sending prompt: "${inputPrompt}"`);
  console.log('⏳ Live status progress:\n');
}

const startTime = Date.now();

const req = http.request({
  hostname: 'localhost',
  port: PORT,
  path: reqPath,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(reqBody)
  }
}, (res) => {
  if (res.statusCode >= 400 && res.headers['content-type']?.includes('application/json')) {
    let raw = '';
    res.on('data', c => raw += c);
    res.on('end', () => {
      try {
        const errJson = JSON.parse(raw);
        console.error('❌ Error:', errJson.error || errJson.message);
      } catch (e) {
        console.error(`❌ HTTP ${res.statusCode}: ${raw}`);
      }
    });
    return;
  }

  let buffer = '';

  res.on('data', chunk => {
    buffer += chunk.toString();
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop(); // Retain partial trailing block

    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed) continue;

      const lines = trimmed.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const event = JSON.parse(line.substring(6));
            handleSSEEvent(event);
          } catch (e) {
            // ignore non-JSON
          }
        }
      }
    }
  });

  res.on('end', () => {
    if (buffer.trim().startsWith('data: ')) {
      try {
        const event = JSON.parse(buffer.trim().substring(6));
        handleSSEEvent(event);
      } catch (e) {}
    }
  });
});

const stageLabels = {
  translate_in: '1/3 Analyzing input',
  hermes: '2/3 Processing task',
  translate_out: '3/3 Formatting response'
};

function handleSSEEvent(event) {
  const totalMs = Date.now() - startTime;

  if (event.type === 'stage') {
    const label = stageLabels[event.stage] || event.stage;
    if (event.status === 'start') {
      console.log(`[${new Date().toLocaleTimeString()}] ⏳ Stage ${label}...`);
    } else if (event.status === 'done') {
      console.log(`[${new Date().toLocaleTimeString()}] ✓ Done stage ${event.stage} (${event.durationMs}ms)`);
    }
  } else if (event.type === 'result') {
    console.log('');
    if (event.status === 'confirmation_required' || event.requires_confirmation) {
      console.log('⚠️ CONSEQUENTIAL ACTION GATE DETECTED');
      console.log('----------------------------------------------------');
      console.log(event.amharic_prompt || event.amharic_action_description);
      console.log(`\nTo confirm, run: node cli.js --confirm ${event.confirmation_token}`);
    } else if (event.status === 'success') {
      console.log('📥 Response:');
      console.log('----------------------------------------------------');
      console.log(event.amharicResponse);
      console.log('----------------------------------------------------');
      if (event.englishResponse) {
        console.log(`(Internal English output: "${event.englishResponse}")`);
      }
      if (event.timing) {
        console.log(`\n⏱️ Timings: Input: ${event.timing.translateInMs}ms | Processing: ${event.timing.hermesMs}ms | Output: ${event.timing.translateOutMs}ms | Total: ${totalMs}ms`);
      } else if (event.timingTotalMs) {
        console.log(`\n⏱️ Total Execution Time: ${event.timingTotalMs}ms`);
      }
    } else {
      console.log('❌ Result Event:', event);
    }
  } else if (event.type === 'error') {
    console.error(`\n❌ Error [Stage: ${event.stage}]:`, event.message);
  }
}

req.on('error', (err) => {
  console.error('❌ Connection error. Is the server running? (Run: node server.js)', err.message);
});

req.write(reqBody);
req.end();
