/**
 * Hermes Client Service
 * Interacts with the local Hermes AI Agent instance via the CLI binary (`hermes -z`).
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const HERMES_BIN = process.env.HERMES_BIN || '/home/nate/.local/bin/hermes';

// In-memory session map: userId/sessionId -> hermesSessionId
const sessionStore = new Map();

/**
 * Send English prompt to local Hermes agent
 * @param {string} englishText - The translated user query
 * @param {Object} options - Options object
 * @param {string} [options.sessionId] - Session/User ID for conversation history
 * @returns {Promise<{ responseText: string, requiresConfirmation: boolean, actionDetails: Object|null, usage: Object, sessionId: string, durationMs: number }>}
 */
async function sendTask(englishText, options = {}) {
  const { sessionId } = options;
  const hermesSessionId = sessionId ? sessionStore.get(sessionId) : null;

  const tempUsageFile = path.join(os.tmpdir(), `hermes_usage_${crypto.randomUUID()}.json`);

  const args = ['-z', englishText];

  if (hermesSessionId) {
    args.push('-r', hermesSessionId);
  }

  args.push('--usage-file', tempUsageFile);

  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    execFile(HERMES_BIN, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      const durationMs = Date.now() - startTime;

      let usage = null;
      let newSessionId = hermesSessionId || null;

      // Read usage file if created
      if (fs.existsSync(tempUsageFile)) {
        try {
          const usageContent = fs.readFileSync(tempUsageFile, 'utf8');
          usage = JSON.parse(usageContent);
          if (usage.session_id) {
            newSessionId = usage.session_id;
            if (sessionId) {
              sessionStore.set(sessionId, newSessionId);
            }
          }
          fs.unlinkSync(tempUsageFile);
        } catch (e) {
          console.warn('[HERMES] Warning: Failed to read usage file:', e.message);
        }
      }

      if (error) {
        console.error('[HERMES] Execution error:', stderr || error.message);
        return reject(new Error(`Hermes agent execution failed: ${stderr || error.message}`));
      }

      const rawOutput = (stdout || '').trim();

      // Check for Consequential Action Flag / JSON structure
      let requiresConfirmation = false;
      let actionDetails = null;
      let responseText = rawOutput;

      // Attempt to parse JSON response if Hermes returned structured JSON
      try {
        if (rawOutput.startsWith('{') && rawOutput.endsWith('}')) {
          const parsed = JSON.parse(rawOutput);
          if (parsed.requires_confirmation || parsed.requiresConfirmation) {
            requiresConfirmation = true;
            actionDetails = parsed;
            responseText = parsed.proposed_response || parsed.action_details || parsed.message || rawOutput;
          }
        }
      } catch (e) {
        // Output is standard text response
      }

      // Secondary check: look for explicit text marker [REQUIRES_CONFIRMATION]
      if (rawOutput.includes('[REQUIRES_CONFIRMATION]') || rawOutput.includes('requires_confirmation: true')) {
        requiresConfirmation = true;
        responseText = rawOutput.replace(/\[REQUIRES_CONFIRMATION\]/g, '').replace(/requires_confirmation:\s*true/g, '').trim();
      }

      resolve({
        responseText,
        rawOutput,
        requiresConfirmation,
        actionDetails,
        usage,
        sessionId: newSessionId || sessionId || 'default',
        durationMs
      });
    });
  });
}

/**
 * Retrieve active session map (for debugging/status)
 */
function getSessionStore() {
  return Object.fromEntries(sessionStore);
}

module.exports = {
  sendTask,
  getSessionStore
};
