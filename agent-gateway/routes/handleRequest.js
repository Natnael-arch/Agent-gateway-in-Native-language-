/**
 * Gateway Request Pipeline Router
 * Handles request flow: Amharic input -> Addis AI (am->en) -> Hermes -> confirmation gate -> Addis AI (en->am) -> Amharic response
 */

const express = require('express');
const crypto = require('crypto');
const { translateToEnglish, translateToAmharic } = require('../services/translator');
const { sendTask } = require('../services/hermesClient');
const { processConfirmationGate, getAndClearPendingConfirmation } = require('../middleware/confirmationGate');
const { logRequest } = require('../utils/logger');

const router = express.Router();

// Amharic fallback error messages
const ERROR_MSG_TRANSLATE_IN_FAILED = 'ይቅርታ፣ ያስገቡትን መልእክት መተርጎም አልተቻለም። እባክዎን በሌላ አባባል እንደገና ይሞክሩ።';
const ERROR_MSG_HERMES_FAILED = 'ይቅርታ፣ ከአርቴፊሻል ኢንተለጀንስ ወኪሉ ጋር ሲገናኙ ስህተት አጋጥሟል። እባክዎን በኋላ እንደገና ይሞክሩ።';
const ERROR_MSG_TRANSLATE_OUT_FAILED = 'ይቅርታ፣ መልሱን ወደ አማርኛ መተርጎም አልተቻለም።';

/**
 * Helper to write SSE formatted data chunk to client
 */
function sendSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  if (typeof res.flush === 'function') {
    res.flush();
  }
}

/**
 * Main chat request handler
 * POST /api/chat
 * Body: { "text": "የአማርኛ ጽሑፍ", "sessionId": "optional-session-id" }
 */
router.post('/chat', async (req, res) => {
  const requestId = `req_${crypto.randomUUID()}`;
  const startTime = Date.now();

  const { text, sessionId = 'default-session' } = req.body;

  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({
      status: 'error',
      error: 'Missing required field: text (Amharic prompt text)'
    });
  }

  // Set SSE Response Headers
  if (req.socket) req.socket.setNoDelay(true);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  const logData = {
    requestId,
    sessionId,
    success: false,
    hops: {}
  };

  let currentStage = 'translate_in';

  try {
    // -------------------------------------------------------------
    // Hop 1: Translate Amharic -> English via Addis AI
    // -------------------------------------------------------------
    currentStage = 'translate_in';
    sendSSE(res, { type: 'stage', stage: 'translate_in', status: 'start' });

    let translateInResult;
    try {
      translateInResult = await translateToEnglish(text.trim());
      logData.hops.translateIn = {
        durationMs: translateInResult.durationMs,
        success: true,
        usage: translateInResult.usage
      };
      sendSSE(res, { type: 'stage', stage: 'translate_in', status: 'done', durationMs: translateInResult.durationMs });
    } catch (err) {
      logData.hops.translateIn = {
        durationMs: 0,
        success: false,
        error: err.message
      };
      logData.error = `Translate In Failed: ${err.message}`;
      logData.totalDurationMs = Date.now() - startTime;
      logRequest(logData);

      sendSSE(res, {
        type: 'error',
        stage: 'translate_in',
        message: err.message || ERROR_MSG_TRANSLATE_IN_FAILED
      });
      return res.end();
    }

    const englishInput = translateInResult.translation;

    // -------------------------------------------------------------
    // Hop 2: Send English text to local Hermes Agent
    // -------------------------------------------------------------
    currentStage = 'hermes';
    sendSSE(res, { type: 'stage', stage: 'hermes', status: 'start' });

    let hermesResult;
    try {
      hermesResult = await sendTask(englishInput, { sessionId });
      logData.hops.hermesProcessing = {
        durationMs: hermesResult.durationMs,
        success: true,
        usage: hermesResult.usage,
        requiresConfirmation: hermesResult.requiresConfirmation
      };
      sendSSE(res, { type: 'stage', stage: 'hermes', status: 'done', durationMs: hermesResult.durationMs });
    } catch (err) {
      logData.hops.hermesProcessing = {
        durationMs: 0,
        success: false,
        error: err.message
      };
      logData.error = `Hermes Processing Failed: ${err.message}`;
      logData.totalDurationMs = Date.now() - startTime;
      logRequest(logData);

      sendSSE(res, {
        type: 'error',
        stage: 'hermes',
        message: ERROR_MSG_HERMES_FAILED
      });
      return res.end();
    }

    // -------------------------------------------------------------
    // Step 5 Check: Confirmation Gate for consequential actions
    // -------------------------------------------------------------
    if (hermesResult.requiresConfirmation) {
      currentStage = 'translate_out';
      sendSSE(res, { type: 'stage', stage: 'translate_out', status: 'start' });

      // Translate the proposed English response to Amharic for user review
      let amharicActionText = hermesResult.responseText;
      let transOutMs = 0;
      try {
        const transOut = await translateToAmharic(hermesResult.responseText);
        amharicActionText = transOut.translation;
        transOutMs = transOut.durationMs;
        logData.hops.translateOut = {
          durationMs: transOut.durationMs,
          success: true,
          usage: transOut.usage
        };
      } catch (err) {
        logData.hops.translateOut = { durationMs: 0, success: false, error: err.message };
      }

      sendSSE(res, { type: 'stage', stage: 'translate_out', status: 'done', durationMs: transOutMs });

      const gateResult = processConfirmationGate(hermesResult, amharicActionText, sessionId);

      logData.success = true;
      logData.totalDurationMs = Date.now() - startTime;
      logRequest(logData);

      sendSSE(res, {
        type: 'result',
        status: 'confirmation_required',
        requestId,
        sessionId: hermesResult.sessionId,
        ...gateResult.confirmationPayload
      });
      return res.end();
    }

    // -------------------------------------------------------------
    // Hop 3: Translate Hermes's English response -> Amharic via Addis AI
    // -------------------------------------------------------------
    currentStage = 'translate_out';
    sendSSE(res, { type: 'stage', stage: 'translate_out', status: 'start' });

    let translateOutResult;
    try {
      translateOutResult = await translateToAmharic(hermesResult.responseText);
      logData.hops.translateOut = {
        durationMs: translateOutResult.durationMs,
        success: true,
        usage: translateOutResult.usage
      };
      sendSSE(res, { type: 'stage', stage: 'translate_out', status: 'done', durationMs: translateOutResult.durationMs });
    } catch (err) {
      logData.hops.translateOut = {
        durationMs: 0,
        success: false,
        error: err.message
      };
      logData.error = `Translate Out Failed: ${err.message}`;
      logData.totalDurationMs = Date.now() - startTime;
      logRequest(logData);

      sendSSE(res, {
        type: 'error',
        stage: 'translate_out',
        message: err.message || ERROR_MSG_TRANSLATE_OUT_FAILED
      });
      return res.end();
    }

    // -------------------------------------------------------------
    // Final Output & Logging
    // -------------------------------------------------------------
    logData.success = true;
    logData.totalDurationMs = Date.now() - startTime;
    logRequest(logData);

    sendSSE(res, {
      type: 'result',
      status: 'success',
      requestId,
      sessionId: hermesResult.sessionId,
      amharicResponse: translateOutResult.translation,
      englishResponse: hermesResult.responseText, // Included for debugging/transparency
      timing: {
        translateInMs: logData.hops.translateIn.durationMs,
        hermesMs: logData.hops.hermesProcessing.durationMs,
        translateOutMs: logData.hops.translateOut.durationMs,
        totalMs: logData.totalDurationMs
      }
    });
    return res.end();

  } catch (err) {
    logData.error = `Unhandled Pipeline Error: ${err.message}`;
    logData.totalDurationMs = Date.now() - startTime;
    logRequest(logData);

    sendSSE(res, {
      type: 'error',
      stage: currentStage,
      message: err.message || ERROR_MSG_HERMES_FAILED
    });
    return res.end();
  }
});

/**
 * Handle confirmation of consequential actions
 * POST /api/confirm
 * Body: { "confirmation_token": "conf_xyz" }
 */
router.post('/confirm', async (req, res) => {
  const { confirmation_token } = req.body;

  if (!confirmation_token) {
    return res.status(400).json({
      status: 'error',
      error: 'Missing confirmation_token'
    });
  }

  const pendingData = getAndClearPendingConfirmation(confirmation_token);

  if (!pendingData) {
    return res.status(404).json({
      status: 'error',
      message: 'የማረጋገጫ ምልክት (token) አልተገኘም ወይም ጊዜው አልፏል።' // Token not found or expired
    });
  }

  // Set SSE Response Headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  const startTime = Date.now();
  const requestId = `req_conf_${crypto.randomUUID()}`;
  let currentStage = 'hermes';

  try {
    // Stage 1: Execute confirmed task through Hermes
    currentStage = 'hermes';
    sendSSE(res, { type: 'stage', stage: 'hermes', status: 'start' });

    const confirmationPrompt = `[CONFIRMED BY USER]: Proceed with executing the action: ${pendingData.englishAction}`;
    const hermesResult = await sendTask(confirmationPrompt, { sessionId: pendingData.sessionId });
    sendSSE(res, { type: 'stage', stage: 'hermes', status: 'done', durationMs: hermesResult.durationMs });

    // Stage 2: Translate output to Amharic
    currentStage = 'translate_out';
    sendSSE(res, { type: 'stage', stage: 'translate_out', status: 'start' });
    const translateOut = await translateToAmharic(hermesResult.responseText);
    sendSSE(res, { type: 'stage', stage: 'translate_out', status: 'done', durationMs: translateOut.durationMs });

    logRequest({
      requestId,
      sessionId: pendingData.sessionId,
      success: true,
      hops: {
        hermesProcessing: { durationMs: hermesResult.durationMs, success: true, usage: hermesResult.usage },
        translateOut: { durationMs: translateOut.durationMs, success: true, usage: translateOut.usage }
      },
      totalDurationMs: Date.now() - startTime
    });

    sendSSE(res, {
      type: 'result',
      status: 'success',
      actionExecuted: true,
      amharicResponse: translateOut.translation,
      timingTotalMs: Date.now() - startTime
    });
    return res.end();

  } catch (err) {
    sendSSE(res, {
      type: 'error',
      stage: currentStage,
      message: err.message || ERROR_MSG_HERMES_FAILED
    });
    return res.end();
  }
});

module.exports = router;
