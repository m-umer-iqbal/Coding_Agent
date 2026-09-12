'use strict';

const { MAX_TOKENS } = require('../config');
const { SYSTEM_PROMPT } = require('../prompt');
const { TOOL_DEFINITIONS } = require('../tools');
const { PROVIDERS } = require('./registry');
const { buildApiError } = require('./errors');

// --------------------------------------------------------------------
// OpenAI — Chat Completions API (tool calling)
// --------------------------------------------------------------------

function normalizeToolInput(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input;
  }
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (e) {
      // Invalid tool arguments are replaced with an empty object below.
    }
  }
  return {};
}

function unifiedMessagesToOpenAI(messages) {
  const openaiMessages = [{ role: 'system', content: SYSTEM_PROMPT }];

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const textParts = blocks
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');
      const toolCalls = blocks
        .filter((b) => b && b.type === 'tool_use' && b.id && b.name)
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: {
            name: b.name,
            arguments: JSON.stringify(normalizeToolInput(b.input)),
          },
        }));

      // DeepSeek can return an empty/object-shaped content value alongside
      // tool calls. Omit content when there is no text because DeepSeek
      // rejects an empty-string assistant content value in this position.
      // A completely empty assistant turn has no request meaning, so omit it.
      if (textParts || toolCalls.length > 0) {
        const entry = { role: 'assistant' };
        if (textParts) entry.content = textParts;
        if (toolCalls.length > 0) entry.tool_calls = toolCalls;
        openaiMessages.push(entry);
      }
    } else {
      // role === 'user' — may contain plain text (the initial brief)
      // or tool_result blocks (fed back after tool execution).
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const toolResults = blocks.filter
        ? blocks.filter((b) => b && b.type === 'tool_result' && b.tool_use_id)
        : [];

      if (typeof msg.content === 'string') {
        openaiMessages.push({ role: 'user', content: msg.content });
      } else if (toolResults.length > 0) {
        for (const tr of toolResults) {
          openaiMessages.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content:
              typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
          });
        }
      } else {
        // Fallback: array of text blocks
        const text = blocks
          .filter((b) => b && typeof b.text === 'string')
          .map((b) => b.text)
          .join('\n');
        openaiMessages.push({ role: 'user', content: text });
      }
    }
  }

  return openaiMessages;
}

function openAIToolsSchema() {
  return TOOL_DEFINITIONS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

async function callOpenAI(apiKey, model, messages) {
  const body = {
    model,
    max_tokens: MAX_TOKENS,
    messages: unifiedMessagesToOpenAI(messages),
    tools: openAIToolsSchema(),
  };

  const response = await fetch(PROVIDERS['2'].apiUrl, {
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
      'OpenAI',
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
  if (typeof message.content === 'string' && message.content) {
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

module.exports = { callOpenAI, unifiedMessagesToOpenAI, openAIToolsSchema };
