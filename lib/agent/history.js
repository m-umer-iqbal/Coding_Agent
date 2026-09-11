'use strict';

const {
  KEEP_FULL_TOOL_RESULTS_FOR_LAST_N_MESSAGES,
  ELIDED_RESULT_MAX_CHARS,
} = require('../config');

// ====================================================================
// History compaction
//
// Tool results dominate the transcript and are dead weight once acted
// on. Old ones are replaced by a short stub; the assistant's own
// reasoning and tool calls are always kept intact.
// ====================================================================

function compactHistory(messages) {
  const cutoff = messages.length - KEEP_FULL_TOOL_RESULTS_FOR_LAST_N_MESSAGES;

  return messages.map((msg, index) => {
    if (index >= cutoff || msg.role !== 'user' || typeof msg.content === 'string') {
      return msg;
    }
    if (!Array.isArray(msg.content)) return msg;

    let changed = false;
    const content = msg.content.map((block) => {
      if (block.type !== 'tool_result') return block;
      const text = typeof block.content === 'string' ? block.content : '';
      if (text.length <= ELIDED_RESULT_MAX_CHARS) return block;
      changed = true;
      return {
        ...block,
        content:
          text.slice(0, ELIDED_RESULT_MAX_CHARS) +
          `\n... [older result elided — ${text.length} chars. ` +
          'Re-read the file if you need it again.]',
      };
    });

    return changed ? { ...msg, content } : msg;
  });
}

module.exports = { compactHistory };
