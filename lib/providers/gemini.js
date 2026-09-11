'use strict';

const { SYSTEM_PROMPT } = require('../prompt');
const { TOOL_DEFINITIONS } = require('../tools');
const { PROVIDERS } = require('./registry');
const { buildApiError } = require('./errors');

// --------------------------------------------------------------------
// Google Gemini — generateContent API (function calling)
// --------------------------------------------------------------------

function unifiedMessagesToGemini(messages) {
  const contents = [];

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const parts = [];
      for (const b of msg.content) {
        if (b.type === 'text' && b.text) {
          // Gemini 3 requires thought signatures echoed back verbatim.
          const part = { text: b.text };
          if (b.thoughtSignature) part.thoughtSignature = b.thoughtSignature;
          parts.push(part);
        } else if (b.type === 'tool_use') {
          // Without the original signature Gemini 3 returns 400.
          const part = { functionCall: { name: b.name, args: b.input || {} } };
          if (b.thoughtSignature) part.thoughtSignature = b.thoughtSignature;
          parts.push(part);
        }
      }
      contents.push({ role: 'model', parts });
    } else {
      // role === 'user'
      if (typeof msg.content === 'string') {
        contents.push({ role: 'user', parts: [{ text: msg.content }] });
      } else {
        const toolResults = msg.content.filter((b) => b.type === 'tool_result');
        if (toolResults.length > 0) {
          const parts = toolResults.map((tr) => ({
            functionResponse: {
              name: tr.name || 'tool_result',
              response: {
                content:
                  typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
              },
            },
          }));
          contents.push({ role: 'user', parts });
        } else {
          const text = msg.content.map((b) => b.text || '').join('\n');
          contents.push({ role: 'user', parts: [{ text }] });
        }
      }
    }
  }

  return contents;
}

function geminiToolsSchema() {
  // Gemini's parameter schema is JSON-schema-like but does not accept
  // some fields (like additionalProperties). Strip to a safe subset.
  const stripSchema = (schema) => ({
    type: schema.type,
    properties: schema.properties,
    required: schema.required,
  });

  return [
    {
      functionDeclarations: TOOL_DEFINITIONS.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: stripSchema(t.input_schema),
      })),
    },
  ];
}

async function callGemini(apiKey, model, messages) {
  const url = `${PROVIDERS['3'].apiUrl}/${model}:generateContent?key=${apiKey}`;

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    // functionResponse blocks are keyed by tool *name* (Gemini has no
    // call-id concept), which relies on tool_result blocks carrying
    // `name` — set for every tool_result pushed in the main loop.
    contents: unifiedMessagesToGemini(messages),
    tools: geminiToolsSchema(),
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw buildApiError(
      'Gemini',
      response.status,
      response.statusText,
      errBody,
      response.headers.get('retry-after')
    );
  }

  const data = await response.json();
  const candidate = data.candidates && data.candidates[0];
  const parts = (candidate && candidate.content && candidate.content.parts) || [];

  const content = [];
  let callIndex = 0;
  for (const part of parts) {
    if (part.text) {
      const block = { type: 'text', text: part.text };
      // Preserved verbatim so it can be echoed back next turn.
      if (part.thoughtSignature) block.thoughtSignature = part.thoughtSignature;
      content.push(block);
    } else if (part.functionCall) {
      callIndex += 1;
      const block = {
        type: 'tool_use',
        // Gemini doesn't hand back call ids, so we mint one that
        // encodes the tool name — later used to route functionResponse
        // back by name.
        id: `gemini-call-${Date.now()}-${callIndex}`,
        name: part.functionCall.name,
        input: part.functionCall.args || {},
      };
      // On parallel calls only the FIRST functionCall part carries a
      // signature; store whatever came back and echo it next turn.
      if (part.thoughtSignature) block.thoughtSignature = part.thoughtSignature;
      content.push(block);
    }
  }

  const hasToolCalls = content.some((b) => b.type === 'tool_use');
  const stop_reason = hasToolCalls ? 'tool_use' : 'end_turn';

  return { content, stop_reason };
}

module.exports = { callGemini, unifiedMessagesToGemini, geminiToolsSchema };
