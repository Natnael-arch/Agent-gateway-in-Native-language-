const fs = require('fs');
const path = require('path');
const os = require('os');

// Determine a safe, writable log directory
function getLogDir() {
  if (process.env.AGELGAY_LOG_DIR) {
    return process.env.AGELGAY_LOG_DIR;
  }
  // Try local logs folder first if writable
  const localDir = path.join(__dirname, '..', 'logs');
  try {
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    // Test write access
    const testFile = path.join(localDir, '.write-test');
    fs.writeFileSync(testFile, '');
    fs.unlinkSync(testFile);
    return localDir;
  } catch (e) {
    // Read-only or unwritable filesystem (e.g. AppImage mount, /opt/Agelgay)
    const userLogDir = path.join(os.homedir() || '/tmp', '.agelgay', 'logs');
    try {
      if (!fs.existsSync(userLogDir)) {
        fs.mkdirSync(userLogDir, { recursive: true });
      }
      return userLogDir;
    } catch (err) {
      return os.tmpdir();
    }
  }
}

const LOG_DIR = getLogDir();
const LOG_FILE = path.join(LOG_DIR, 'gateway.jsonl');

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

  try {
    const jsonLine = JSON.stringify(entry) + '\n';
    fs.appendFileSync(LOG_FILE, jsonLine, 'utf8');
  } catch (e) {
    console.error('[LOG] Failed to write to log file:', e.message);
  }

  // Console output for immediate visibility
  console.log(`[LOG] Request ${entry.requestId || 'N/A'} completed in ${entry.totalDurationMs}ms | Success: ${entry.success}`);
}

module.exports = {
  logRequest,
  LOG_FILE
};
