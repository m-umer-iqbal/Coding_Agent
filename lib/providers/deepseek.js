'use strict';

const { MAX_TOKENS } = require('../config');
const { PROVIDERS } = require('./registry');
const { buildApiError } = require('./errors');
const { unifiedMessagesToOpenAI, openAIToolsSchema } = require('./openai');

// --------------------------------------------------------------------
// DeepSeek — Chat Completions API (tool calling)
//
// DeepSeek speaks the OpenAI wire format, so the message and tool
// translation is shared with ./openai.js verbatim; only the endpoint,
// the key and a couple of response quirks differ.
//
// Models: deepseek-chat (V3, general) and deepseek-reasoner (R1).
// deepseek-reasoner returns an extra `reasoning_content` field which is
// NOT part of the conversation contract, so it is logged as text and
// never fed back as an assistant turn.
// --------------------------------------------------------------------

async function callDeepSeek(apiKey, model, messages) {
  const body = {
    model,
    max_tokens: MAX_TOKENS,
    messages: unifiedMessagesToOpenAI(messages),
    tools: openAIToolsSchema(),
  };

  const response = await fetch(PROVIDERS['4'].apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw buildApiError(
      'DeepSeek',
      response.status,
      response.statusText,
      errBody,
      response.headers.get('retry-after')
    );
  }

  const data = await response.json();
  const choice = data.choices && data.choices[0];
  const message = choice ? choice.message : {};

  const content = [];
  if (message.content) {
    content.push({ type: 'text', text: message.content });
  }
  for (const call of message.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(call.function.arguments || '{}');
    } catch (e) {
      input = {};
    }
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input,
    });
  }

  const stop_reason =
    choice && choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn';

  return { content, stop_reason };
}

module.exports = { callDeepSeek };
