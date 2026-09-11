'use strict';

// ====================================================================
// Provider registry
//
// Every provider is driven through the SAME message loop. Wire-format
// differences live only in the call*() and unifiedMessagesTo*()
// functions, so main() never knows which one is active.
// ====================================================================

const PROVIDERS = {
  '1': {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    apiUrl: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-sonnet-5',
    keyPrompt: 'Enter your Anthropic API key',
  },
  '2': {
    id: 'openai',
    label: 'OpenAI (GPT)',
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o',
    keyPrompt: 'Enter your OpenAI API key',
  },
  '3': {
    id: 'gemini',
    label: 'Google (Gemini)',
    apiUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    defaultModel: 'gemini-3.5-flash-lite',
    keyPrompt: 'Enter your Google AI (Gemini) API key',
  },
};

module.exports = { PROVIDERS };
