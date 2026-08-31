/**
 * Addis AI Translation Service
 * Wraps translation calls to https://api.addisassistant.com/api/v1/translate
 *
 * NOTE ON FUTURE OPTIMIZATION:
 * Addis AI's native LLM (Addis-1-Alef) natively understands Amharic instructions.
 * In future iterations, simple user requests could potentially bypass the am -> en
 * translation step entirely by routing directly to Addis-1-Alef.
 */

const ADDIS_TRANSLATE_URL = process.env.ADDIS_TRANSLATE_URL || 'https://api.addisassistant.com/api/v1/translate';

/**
 * Perform translation call to Addis AI
 * @param {string} text - Source text to translate
 * @param {string} sourceLang - 'am' or 'en'
 * @param {string} targetLang - 'en' or 'am'
 * @returns {Promise<{ translation: string, usage: Object, durationMs: number }>}
 */
async function callAddisTranslate(text, sourceLang, targetLang) {
  const apiKey = process.env.ADDIS_API_KEY;

  // Optional mock mode for testing without active API key
  if (process.env.MOCK_TRANSLATION === 'true' || !apiKey) {
    if (!apiKey && process.env.MOCK_TRANSLATION !== 'true') {
      console.warn('[WARNING] ADDIS_API_KEY not set. Falling back to mock translation mode.');
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
  const response = await fetch(ADDIS_TRANSLATE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey
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
    throw new Error(`Addis AI Translation API error (${response.status}): ${errorText}`);
  }

  const result = await response.json();

  if (result.status !== 'success' || !result.data?.translation) {
    throw new Error(`Invalid response from Addis AI Translation API: ${JSON.stringify(result)}`);
  }

  return {
    translation: result.data.translation,
    usage: result.data.usage_metadata || null,
    durationMs
  };
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
