'use strict';

const { sleep } = require('../util');
const { callAnthropic } = require('./anthropic');
const { callOpenAI } = require('./openai');
const { callGemini } = require('./gemini');

// ====================================================================
// Unified message format used by the main loop, regardless of
// provider:
//
//   { role: 'user' | 'assistant', content: [ block, block, ... ] }
//
// where each block is one of:
//   { type: 'text', text }
//   { type: 'tool_use', id, name, input }
//   { type: 'tool_result', tool_use_id, content }
//
// Each provider's call*() function accepts this unified history plus
// the system prompt and tool definitions, translates them into that
// provider's wire format, sends the request, and translates the
// response back into { content: [ ...blocks ], stop_reason }.
// This keeps main() provider-agnostic.
// ====================================================================

const MAX_RATE_LIMIT_RETRIES = 3;
const DEFAULT_RETRY_DELAY_SECONDS = 20;
const MAX_RETRY_DELAY_SECONDS = 120;

/**
 * Wraps callProvider with automatic retry on 429 and 5xx. Any other
 * error (auth failure, bad request) is rethrown immediately.
 */
async function callProviderWithRetry(providerId, apiKey, model, messages) {
  let attempt = 0;

  while (true) {
    try {
      return await callProvider(providerId, apiKey, model, messages);
    } catch (err) {
      // 429 is rate limiting; 5xx is the provider being briefly
      // unavailable. Both are worth waiting out rather than throwing
      // away a run that may be 30 files deep.
      const isRetryable = err.status === 429 || (err.status >= 500 && err.status < 600);
      if (!isRetryable || attempt >= MAX_RATE_LIMIT_RETRIES) {
        throw err;
      }

      attempt += 1;
      const suggested =
        typeof err.retryDelaySeconds === 'number' && err.retryDelaySeconds > 0
          ? err.retryDelaySeconds
          : DEFAULT_RETRY_DELAY_SECONDS * attempt; // simple backoff if no hint given
      const waitSeconds = Math.min(suggested, MAX_RETRY_DELAY_SECONDS) + 1; // +1s safety margin

      console.log(
        `\n[retry] Provider returned ${err.status} ` +
        `(${err.status === 429 ? 'quota/rate limit exceeded' : 'server error'}). ` +
        `Waiting ${waitSeconds.toFixed(0)}s before retry ` +
        `(attempt ${attempt}/${MAX_RATE_LIMIT_RETRIES})...\n` +
        '[retry] The run is NOT lost — it resumes from the same turn.'
      );
      await sleep(waitSeconds * 1000);
    }
  }
}

async function callProvider(providerId, apiKey, model, messages) {
  switch (providerId) {
    case 'anthropic':
      return callAnthropic(apiKey, model, messages);
    case 'openai':
      return callOpenAI(apiKey, model, messages);
    case 'gemini':
      return callGemini(apiKey, model, messages);
    default:
      throw new Error(`Unknown provider: ${providerId}`);
  }
}

module.exports = { callProvider, callProviderWithRetry };
