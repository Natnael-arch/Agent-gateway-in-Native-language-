/**
 * Confirmation Gate Middleware / Utility
 * Flags consequential actions (payments, bookings, destructive operations)
 * and holds execution until explicit user confirmation in Amharic.
 */

const crypto = require('crypto');

// In-memory store for pending confirmations: confirmationToken -> pendingActionData
const pendingConfirmations = new Map();

/**
 * Check if the Hermes result requires user confirmation.
 * If so, stores the pending action context and returns a confirmation payload.
 *
 * @param {Object} hermesResult - Result object from hermesClient.sendTask
 * @param {string} amharicProposedAction - Translated proposed action text in Amharic
 * @param {string} sessionId - Active session ID
 * @returns {{ requiresConfirmation: boolean, confirmationPayload?: Object }}
 */
function processConfirmationGate(hermesResult, amharicProposedAction, sessionId) {
  if (!hermesResult.requiresConfirmation) {
    return { requiresConfirmation: false };
  }

  const confirmationToken = `conf_${crypto.randomUUID()}`;
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes TTL

  const pendingData = {
    confirmationToken,
    sessionId,
    actionDetails: hermesResult.actionDetails || { text: hermesResult.responseText },
    englishAction: hermesResult.responseText,
    amharicAction: amharicProposedAction,
    createdAt: Date.now(),
    expiresAt
  };

  pendingConfirmations.set(confirmationToken, pendingData);

  const amharicConfirmationNotice =
    `⚠️ **እርምጃ ማረጋገጫ ያስፈልገዋል** ⚠️\n\n` +
    `የታቀደው ተግባር፡ ${amharicProposedAction}\n\n` +
    `እባክዎን ይህን እርምጃ ለማረጋገጥ 'አረጋግጣለሁ' (Confirm) ይበሉ ወይም የ confirmation_token በመጠቀም ያረጋግጡ።\n` +
    `[Token: ${confirmationToken}]`;

  return {
    requiresConfirmation: true,
    confirmationPayload: {
      status: 'confirmation_required',
      requires_confirmation: true,
      confirmation_token: confirmationToken,
      amharic_action_description: amharicProposedAction,
      amharic_prompt: amharicConfirmationNotice,
      expires_at: new Date(expiresAt).toISOString()
    }
  };
}

/**
 * Verify and consume a confirmation token
 * @param {string} token
 * @returns {Object|null} Pending action data if valid, null if invalid or expired
 */
function getAndClearPendingConfirmation(token) {
  const data = pendingConfirmations.get(token);
  if (!data) return null;

  if (Date.now() > data.expiresAt) {
    pendingConfirmations.delete(token);
    return null;
  }

  pendingConfirmations.delete(token);
  return data;
}

module.exports = {
  processConfirmationGate,
  getAndClearPendingConfirmation,
  pendingConfirmations
};
