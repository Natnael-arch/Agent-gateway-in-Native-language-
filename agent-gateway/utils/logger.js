const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'gateway.jsonl');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Log a structured gateway request transaction
 * @param {Object} logData
 */
function logRequest(logData) {
  const entry = {
    timestamp: new Date().toISOString(),
    requestId: logData.requestId || null,
    sessionId: logData.sessionId || null,
    success: logData.success !== false,
    hops: {
      translateIn: {
        durationMs: logData.hops?.translateIn?.durationMs ?? null,
        success: logData.hops?.translateIn?.success ?? false,
        usage: logData.hops?.translateIn?.usage ?? null,
        error: logData.hops?.translateIn?.error ?? null
      },
      hermesProcessing: {
        durationMs: logData.hops?.hermesProcessing?.durationMs ?? null,
        success: logData.hops?.hermesProcessing?.success ?? false,
        usage: logData.hops?.hermesProcessing?.usage ?? null,
        requiresConfirmation: logData.hops?.hermesProcessing?.requiresConfirmation ?? false,
        error: logData.hops?.hermesProcessing?.error ?? null
      },
      translateOut: {
        durationMs: logData.hops?.translateOut?.durationMs ?? null,
        success: logData.hops?.translateOut?.success ?? false,
        usage: logData.hops?.translateOut?.usage ?? null,
        error: logData.hops?.translateOut?.error ?? null
      }
    },
    totalDurationMs: logData.totalDurationMs ?? null,
    error: logData.error || null
  };

  const jsonLine = JSON.stringify(entry) + '\n';
  fs.appendFileSync(LOG_FILE, jsonLine, 'utf8');

  // Console output for immediate visibility
  console.log(`[LOG] Request ${entry.requestId || 'N/A'} completed in ${entry.totalDurationMs}ms | Success: ${entry.success}`);
}

module.exports = {
  logRequest,
  LOG_FILE
};
