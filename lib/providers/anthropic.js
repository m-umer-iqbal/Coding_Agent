'use strict';

const { MAX_TOKENS } = require('../config');
const { SYSTEM_PROMPT } = require('../prompt');
const { TOOL_DEFINITIONS } = require('../tools');
const { PROVIDERS } = require('./registry');
const { buildApiError } = require('./errors');

// --------------------------------------------------------------------
// Anthropic (Claude) — Messages API
// --------------------------------------------------------------------

async function callAnthropic(apiKey, model, messages) {
  const response = await fetch(PROVIDERS['1'].apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: TOOL_DEFINITIONS.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      })),
      messages, // Anthropic's wire format already matches our unified shape
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw buildApiError(
      'Anthropic',
      response.status,
      response.statusText,
      errBody,
      response.headers.get('retry-after')
    );
  }

  const data = await response.json();
  return { content: data.content || [], stop_reason: data.stop_reason };
}

module.exports = { callAnthropic };
