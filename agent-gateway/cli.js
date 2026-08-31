/**
 * Interactive Amharic CLI client for testing the Agent Gateway
 * Run: node cli.js "የአማርኛ ጥያቄ"
 */

const http = require('http');

const PORT = process.env.PORT || 3000;
const inputPrompt = process.argv.slice(2).join(' ');

if (!inputPrompt) {
  console.log('🇪🇹 Amharic Agent Gateway CLI Client');
  console.log('Usage: node cli.js "<Amharic Text>"');
  console.log('Example: node cli.js "ሰላም፤ ዛሬ አየሩ እንዴት ነው?"');
  process.exit(0);
}

const reqBody = JSON.stringify({
  text: inputPrompt,
  sessionId: 'cli-user-session'
});

console.log(`\n📤 Sending Amharic prompt: "${inputPrompt}"`);
console.log('⏳ Processing request through Addis AI -> Hermes Agent -> Addis AI...\n');

const startTime = Date.now();

const req = http.request({
  hostname: 'localhost',
  port: PORT,
  path: '/api/chat',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(reqBody)
  }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const duration = Date.now() - startTime;
    try {
      const response = JSON.parse(data);

      if (response.requires_confirmation) {
        console.log('⚠️ CONSEQUENTIAL ACTION GATE DETECTED');
        console.log('----------------------------------------------------');
        console.log(response.amharic_prompt);
        console.log(`\nTo confirm, run: node cli.js --confirm ${response.confirmation_token}`);
      } else if (response.status === 'success') {
        console.log('📥 Amharic Response:');
        console.log('----------------------------------------------------');
        console.log(response.amharicResponse);
        console.log('----------------------------------------------------');
        if (response.englishResponse) {
          console.log(`(Hermes English output: "${response.englishResponse}")`);
        }
        if (response.timing) {
          console.log(`\n⏱️ Hop Timings: Translate-In: ${response.timing.translateInMs}ms | Hermes: ${response.timing.hermesMs}ms | Translate-Out: ${response.timing.translateOutMs}ms | Total: ${duration}ms`);
        }
      } else {
        console.log('❌ Error Response:', response);
      }
    } catch (e) {
      console.log('Raw output:', data);
    }
  });
});

req.on('error', (err) => {
  console.error('❌ Connection error. Is the server running? (Run: node server.js)', err.message);
});

req.write(reqBody);
req.end();
