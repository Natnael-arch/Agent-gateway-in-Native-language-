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

  const logData = {
    requestId,
    sessionId,
    success: false,
    hops: {}
  };

  try {
    // -------------------------------------------------------------
    // Hop 1: Translate Amharic -> English via Addis AI
    // -------------------------------------------------------------
    let translateInResult;
    try {
      translateInResult = await translateToEnglish(text.trim());
      logData.hops.translateIn = {
        durationMs: translateInResult.durationMs,
        success: true,
        usage: translateInResult.usage
      };
    } catch (err) {
      logData.hops.translateIn = {
        durationMs: 0,
        success: false,
        error: err.message
      };
      logData.error = `Translate In Failed: ${err.message}`;
      logData.totalDurationMs = Date.now() - startTime;
      logRequest(logData);

      return res.status(500).json({
        status: 'error',
        message: ERROR_MSG_TRANSLATE_IN_FAILED,
        detail: 'Amharic to English translation failed'
      });
    }

    const englishInput = translateInResult.translation;

    // -------------------------------------------------------------
    // Hop 2: Send English text to local Hermes Agent
    // -------------------------------------------------------------
    let hermesResult;
    try {
      hermesResult = await sendTask(englishInput, { sessionId });
      logData.hops.hermesProcessing = {
        durationMs: hermesResult.durationMs,
        success: true,
        usage: hermesResult.usage,
        requiresConfirmation: hermesResult.requiresConfirmation
      };
    } catch (err) {
      logData.hops.hermesProcessing = {
        durationMs: 0,
        success: false,
        error: err.message
      };
      logData.error = `Hermes Processing Failed: ${err.message}`;
      logData.totalDurationMs = Date.now() - startTime;
      logRequest(logData);

      return res.status(500).json({
        status: 'error',
        message: ERROR_MSG_HERMES_FAILED,
        detail: 'Hermes execution error'
      });
    }

    // -------------------------------------------------------------
    // Step 5 Check: Confirmation Gate for consequential actions
    // -------------------------------------------------------------
    if (hermesResult.requiresConfirmation) {
      // Translate the proposed English response to Amharic for user review
      let amharicActionText = hermesResult.responseText;
      try {
        const transOut = await translateToAmharic(hermesResult.responseText);
        amharicActionText = transOut.translation;
        logData.hops.translateOut = {
          durationMs: transOut.durationMs,
          success: true,
          usage: transOut.usage
        };
      } catch (err) {
        logData.hops.translateOut = { durationMs: 0, success: false, error: err.message };
      }

      const gateResult = processConfirmationGate(hermesResult, amharicActionText, sessionId);

      logData.success = true;
      logData.totalDurationMs = Date.now() - startTime;
      logRequest(logData);

      return res.json({
        requestId,
        sessionId: hermesResult.sessionId,
        ...gateResult.confirmationPayload
      });
    }

    // -------------------------------------------------------------
    // Hop 3: Translate Hermes's English response -> Amharic via Addis AI
    // -------------------------------------------------------------
    let translateOutResult;
    try {
      translateOutResult = await translateToAmharic(hermesResult.responseText);
      logData.hops.translateOut = {
        durationMs: translateOutResult.durationMs,
        success: true,
        usage: translateOutResult.usage
      };
    } catch (err) {
      logData.hops.translateOut = {
        durationMs: 0,
        success: false,
        error: err.message
      };
      logData.error = `Translate Out Failed: ${err.message}`;
      logData.totalDurationMs = Date.now() - startTime;
      logRequest(logData);

      return res.status(500).json({
        status: 'error',
        message: ERROR_MSG_TRANSLATE_OUT_FAILED,
        detail: 'English to Amharic translation failed'
      });
    }

    // -------------------------------------------------------------
    // Final Output & Logging
    // -------------------------------------------------------------
    logData.success = true;
    logData.totalDurationMs = Date.now() - startTime;
    logRequest(logData);

    return res.json({
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

  } catch (err) {
    logData.error = `Unhandled Pipeline Error: ${err.message}`;
    logData.totalDurationMs = Date.now() - startTime;
    logRequest(logData);

    return res.status(500).json({
      status: 'error',
      message: ERROR_MSG_HERMES_FAILED
    });
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

  const startTime = Date.now();
  const requestId = `req_conf_${crypto.randomUUID()}`;

  try {
    // Execute confirmed task through Hermes
    const confirmationPrompt = `[CONFIRMED BY USER]: Proceed with executing the action: ${pendingData.englishAction}`;
    const hermesResult = await sendTask(confirmationPrompt, { sessionId: pendingData.sessionId });

    // Translate output to Amharic
    const translateOut = await translateToAmharic(hermesResult.responseText);

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

    return res.json({
      status: 'success',
      actionExecuted: true,
      amharicResponse: translateOut.translation,
      timingTotalMs: Date.now() - startTime
    });

  } catch (err) {
    return res.status(500).json({
      status: 'error',
      message: ERROR_MSG_HERMES_FAILED,
      error: err.message
    });
  }
});

module.exports = router;
