'use strict';

const { PREVIEW_CHARS } = require('../config');

// ====================================================================
// Console progress helpers
// ====================================================================

function preview(text, maxChars = PREVIEW_CHARS) {
  const str = typeof text === 'string' ? text : JSON.stringify(text);
  if (str.length <= maxChars) return str;
  return str.slice(0, maxChars) + '... [truncated]';
}

function logToolCall(name, input) {
  console.log(`\n[tool call] ${name}`);
  console.log(`  input: ${preview(input)}`);
}

function logToolResult(name, result) {
  console.log(`[tool result] ${name} ->`);
  console.log(`  ${preview(result)}`);
}

module.exports = { preview, logToolCall, logToolResult };
