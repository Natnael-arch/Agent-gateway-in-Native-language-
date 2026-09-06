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
 * Safety-net heuristics for detecting Hermes-side failure text masquerading
 * as a legitimate answer. Hermes (as of 0.20.0) exits 0 and prints the error
 * to STDOUT when its LLM call fails after retries, so the exit code is NOT a
 * reliable success signal. The authoritative signal is the --usage-file flags
 * (completed/failed), which this service also reads; these patterns are a
 * backstop for cases where the usage file is missing or unparseable.
 */
const FAILURE_PATTERNS = [
  /^API call failed/i,                 // Hermes's own post-retry failure banner
  /Non-retryable error/i,              // provider-side non-retryable failure
  /HTTP\s+5\d{2}\b/i,                  // upstream 5xx surfaced in output
  /data:\s*\{\s*["']?id["']?\s*:/i,    // raw SSE fragment (chat.completion.chunk)
  /chat\.completion\.chunk/i,          // SSE chunk object leaked to stdout
];

function looksLikeHermesFailure(rawOutput) {
  if (!rawOutput) return true;
  return FAILURE_PATTERNS.some((re) => re.test(rawOutput));
}

function isUsageFileFailed(usage) {
  if (!usage) return false;
  return usage.failed === true || usage.completed === false;
}

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

      // ---- Output validation -------------------------------------------------
      // Treat Hermes output as a failure if EITHER the usage file flags an
      // incomplete/failed run (authoritative) OR the raw output matches known
      // error signatures (safety net for missing/broken usage files).
      if (isUsageFileFailed(usage) || looksLikeHermesFailure(rawOutput)) {
        const detail = (usage && usage.failure) || rawOutput || '(empty stdout)';
        console.error('[HERMES] Detected Hermes failure output; not forwarding to translation. Detail:', detail.slice(0, 500));
        const err = new Error(`Hermes agent returned a failure instead of an answer: ${detail.slice(0, 300)}`);
        err.hermesFailure = true;
        err.rawOutput = rawOutput;
        err.usage = usage;
        return reject(err);
      }

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
