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

// Per-session in-memory state keyed like the rest of the session store
// (by sessionId). Currently only carries the conversation language.
// Defaults to 'am' when unset so existing flows are unchanged.
const sessions = new Map();

function getSessionLanguage(sessionId) {
  const existing = sessions.get(sessionId);
  return existing && existing.language === 'en' ? 'en' : 'am';
}

function setSessionLanguage(sessionId, language) {
  const existing = sessions.get(sessionId) || {};
  sessions.set(sessionId, { ...existing, language });
}

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
 * Set/update a session's conversation language.
 * POST /api/session/language
 * Body: { "sessionId": "optional-session-id", "language": "am" | "en" }
 *
 * Same endpoint for both the first choice (new session) and a later change.
 */
router.post('/session/language', (req, res) => {
  const { language, sessionId = 'default-session' } = req.body || {};

  if (language !== 'am' && language !== 'en') {
    return res.status(400).json({
      status: 'error',
      error: "Invalid language. Expected one of: 'am', 'en'."
    });
  }

  setSessionLanguage(sessionId, language);

  return res.json({
    status: 'ok',
    sessionId,
    language
  });
});

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
      error: 'Missing required field: text (prompt text)'
    });
  }

  // Language-driven routing: 'am' keeps the 3-hop translate pipeline; 'en'
  // sends the raw English text straight to Hermes with no Addis AI calls.
  const isAmharic = getSessionLanguage(sessionId) === 'am';

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

  let currentStage = isAmharic ? 'translate_in' : 'hermes';

  try {
    // -------------------------------------------------------------
    // Hop 1 (Amharic only): Translate Amharic -> English via Addis AI
    // -------------------------------------------------------------
    let englishInput;
    if (isAmharic) {
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

      englishInput = translateInResult.translation;
    } else {
      // English mode: the user's input is already in English — no translation.
      englishInput = text.trim();
    }

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
      currentStage = isAmharic ? 'translate_out' : 'hermes';

      // For the gate payload, Amharic users get the proposed action in
      // Amharic (translated); English users see Hermes's raw English text.
      let actionText = hermesResult.responseText;
      let actionMs = 0;
      let transOutError = null;
      if (isAmharic) {
        sendSSE(res, { type: 'stage', stage: 'translate_out', status: 'start' });
        try {
          const transOut = await translateToAmharic(hermesResult.responseText);
          actionText = transOut.translation;
          actionMs = transOut.durationMs;
          logData.hops.translateOut = {
            durationMs: transOut.durationMs,
            success: true,
            usage: transOut.usage
          };
        } catch (err) {
          transOutError = err.message;
          logData.hops.translateOut = { durationMs: 0, success: false, error: err.message };
        }
        sendSSE(res, { type: 'stage', stage: 'translate_out', status: 'done', durationMs: actionMs });
      }

      if (transOutError) {
        logData.success = false;
        logData.error = `Translate Out Failed: ${transOutError}`;
        logData.totalDurationMs = Date.now() - startTime;
        logRequest(logData);
        sendSSE(res, {
          type: 'error',
          stage: 'translate_out',
          message: transOutError || ERROR_MSG_TRANSLATE_OUT_FAILED
        });
        return res.end();
      }

      const gateResult = processConfirmationGate(hermesResult, actionText, sessionId);

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
    // Hop 3 (Amharic only): Translate Hermes's English response -> Amharic
    // -------------------------------------------------------------
    let finalResponseText = hermesResult.responseText;
    if (isAmharic) {
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

      finalResponseText = translateOutResult.translation;
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
      language: isAmharic ? 'am' : 'en',
      amharicResponse: finalResponseText,
      englishResponse: hermesResult.responseText, // Included for debugging/transparency
      timing: {
        translateInMs: logData.hops.translateIn ? logData.hops.translateIn.durationMs : null,
        hermesMs: logData.hops.hermesProcessing.durationMs,
        translateOutMs: logData.hops.translateOut ? logData.hops.translateOut.durationMs : null,
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

  // Same language routing as /api/chat: Amharic re-translates the executed
  // result back to Amharic; English returns Hermes's raw output directly.
  const isAmharic = getSessionLanguage(pendingData.sessionId) === 'am';

  try {
    // Stage 1: Execute confirmed task through Hermes
    currentStage = 'hermes';
    sendSSE(res, { type: 'stage', stage: 'hermes', status: 'start' });

    const confirmationPrompt = `[CONFIRMED BY USER]: Proceed with executing the action: ${pendingData.englishAction}`;
    const hermesResult = await sendTask(confirmationPrompt, { sessionId: pendingData.sessionId });
    sendSSE(res, { type: 'stage', stage: 'hermes', status: 'done', durationMs: hermesResult.durationMs });

    const logHops = {
      hermesProcessing: { durationMs: hermesResult.durationMs, success: true, usage: hermesResult.usage }
    };

    // Stage 2: Translate output to Amharic (Amharic sessions only)
    let finalResponseText = hermesResult.responseText;
    if (isAmharic) {
      currentStage = 'translate_out';
      sendSSE(res, { type: 'stage', stage: 'translate_out', status: 'start' });
      const translateOut = await translateToAmharic(hermesResult.responseText);
      sendSSE(res, { type: 'stage', stage: 'translate_out', status: 'done', durationMs: translateOut.durationMs });
      logHops.translateOut = { durationMs: translateOut.durationMs, success: true, usage: translateOut.usage };
      finalResponseText = translateOut.translation;
    }

    logRequest({
      requestId,
      sessionId: pendingData.sessionId,
      success: true,
      hops: logHops,
      totalDurationMs: Date.now() - startTime
    });

    sendSSE(res, {
      type: 'result',
      status: 'success',
      actionExecuted: true,
      amharicResponse: finalResponseText,
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
