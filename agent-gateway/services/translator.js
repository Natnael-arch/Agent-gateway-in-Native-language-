/**
 * Addis AI Translation Service
 * Wraps translation calls to https://api.addisassistant.com/api/v1/translate
 *
 * NOTE ON FUTURE OPTIMIZATION:
 * Addis AI's native LLM (Addis-1-Alef) natively understands Amharic instructions.
 * In future iterations, simple user requests could potentially bypass the am -> en
 * translation step entirely by routing directly to Addis-1-Alef.
 */

function getProxyTranslateUrl() {
  let rawUrl = (process.env.PROXY_BASE_URL || 'http://localhost:8787').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(rawUrl)) {
    rawUrl = `https://${rawUrl}`;
  }
  return `${rawUrl}/v1/translate`;
}

/**
 * Perform translation call to usage-proxy with retry logic
 * @param {string} text - Source text to translate
 * @param {string} sourceLang - 'am' or 'en'
 * @param {string} targetLang - 'en' or 'am'
 * @param {number} retries - Number of retries on network error
 * @returns {Promise<{ translation: string, usage: Object, durationMs: number }>}
 */
async function callAddisTranslate(text, sourceLang, targetLang, retries = 2) {
  const token = process.env.PROXY_TOKEN;

  // Optional mock mode for testing without active proxy token
  if (process.env.MOCK_TRANSLATION === 'true' || !token) {
    if (!token && process.env.MOCK_TRANSLATION !== 'true') {
      console.warn('[WARNING] PROXY_TOKEN not set. Falling back to mock translation mode.');
    }
    const startTime = Date.now();
    let mockTranslation = text;
    if (sourceLang === 'am' && targetLang === 'en') {
      mockTranslation = `[Translated to English]: ${text}`;
    } else if (sourceLang === 'en' && targetLang === 'am') {
      mockTranslation = `[በአማርኛ የተቀየረ]: ${text}`;
    }
    return {
      translation: mockTranslation,
      usage: {
        prompt_token_count: Math.ceil(text.length / 4),
        candidates_token_count: Math.ceil(mockTranslation.length / 4),
        total_token_count: Math.ceil((text.length + mockTranslation.length) / 4)
      },
      durationMs: Date.now() - startTime
    };
  }

  const startTime = Date.now();

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(getProxyTranslateUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          text: text,
          source_language: sourceLang,
          target_language: targetLang
        })
      });

      const durationMs = Date.now() - startTime;

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Usage Proxy Translation error (${response.status}): ${errorText}`);
      }

      const result = await response.json();
      const translation = result.translation || result.data?.translation;

      if (!translation) {
        throw new Error(`Invalid response from Usage Proxy Translation API: ${JSON.stringify(result)}`);
      }

      return {
        translation,
        usage: result.usage_metadata || result.data?.usage_metadata || null,
        durationMs
      };
    } catch (err) {
      console.warn(`[TRANSLATOR] Attempt ${attempt + 1} failed for ${sourceLang}->${targetLang}:`, err.message);
      if (attempt === retries) {
        throw err;
      }
      // Wait before retrying (1s delay)
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

/**
 * Translate Amharic text to English
 * @param {string} text - Amharic text
 */
async function translateToEnglish(text) {
  return await callAddisTranslate(text, 'am', 'en');
}

/**
 * Translate English text to Amharic
 * @param {string} text - English text
 */
async function translateToAmharic(text) {
  return await callAddisTranslate(text, 'en', 'am');
}

module.exports = {
  translateToEnglish,
  translateToAmharic
};
