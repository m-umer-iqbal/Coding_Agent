'use strict';

const readline = require('readline');

const { PROVIDERS } = require('../providers/registry');

// ====================================================================
// Provider menu + API key prompt via readline
// (memory only, never written to disk)
// ====================================================================

/**
 * A small line-queueing prompter over readline.
 *
 * rl.question() alone drops any line that arrives while no question is
 * pending, which breaks piped stdin. Queueing the lines instead serves
 * an interactive terminal and a scripted run
 * (`printf '1\n\n' | node agent.js`) with the same code.
 */
function createPrompter() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const waiting = []; // resolvers for questions asked before input arrived
  const buffered = []; // lines that arrived before anyone asked
  let closed = false;

  rl.on('line', (line) => {
    const resolve = waiting.shift();
    if (resolve) resolve(line.trim());
    else buffered.push(line.trim());
  });

  rl.on('close', () => {
    closed = true;
    // Release anything still waiting so the run falls back to defaults
    // rather than hanging forever at EOF.
    while (waiting.length) waiting.shift()('');
  });

  return {
    ask(question) {
      process.stdout.write(question);
      if (buffered.length > 0) {
        const answer = buffered.shift();
        process.stdout.write(answer + '\n'); // echo, since we aren't a TTY
        return Promise.resolve(answer);
      }
      if (closed) {
        process.stdout.write('\n');
        return Promise.resolve('');
      }
      return new Promise((resolve) => waiting.push(resolve));
    },
    /**
     * Yes/no question. `defaultYes` decides what a bare Enter (or EOF
     * on piped stdin) means, so a scripted run never hangs.
     */
    async ask_yes_no(question, defaultYes = true) {
      const suffix = defaultYes ? ' [Y/n]: ' : ' [y/N]: ';
      while (true) {
        const answer = (await this.ask(question + suffix)).toLowerCase();
        if (!answer) return defaultYes;
        if (['y', 'yes'].includes(answer)) return true;
        if (['n', 'no'].includes(answer)) return false;
        console.log('Please answer y or n.');
      }
    },
    close() {
      if (closed) return;
      closed = true;
      rl.close();
    },
  };
}

// ====================================================================
// Startup mode
// ====================================================================

const MODES = {
  '1': {
    id: 'make',
    label: 'Make the project  — read the architecture docs and build it with an LLM',
  },
  '2': {
    id: 'launch',
    label: 'Launch the project — install, check prerequisites and run what is in Project/',
  },
};

/**
 * The first question of every run: build, or run what was already built.
 * Defaults to "make" on a bare Enter so existing scripted runs
 * (`printf '1\n...' | node agent.js`) keep working.
 */
async function promptForMode(prompter) {
  console.log('\nWhat would you like to do?');
  for (const key of Object.keys(MODES)) {
    console.log(`  ${key}) ${MODES[key].label}`);
  }

  while (true) {
    const choice = await prompter.ask('Enter a number (1-2) [default: 1]: ');
    if (!choice) return MODES['1'].id;
    if (MODES[choice]) return MODES[choice].id;
    console.log('Not a valid option, please try again.');
  }
}

/**
 * Asks user for provider choice, plan type (free/paid), the exact number
 * of API keys they want to enter (any positive integer), and collects keys sequentially.
 */
async function promptForProviderAndApiKey(existingPrompter) {
  // Reuse the caller's prompter when there is one — two readline
  // interfaces over the same stdin would fight over the input lines.
  const prompter = existingPrompter || createPrompter();

  console.log('\nWhich LLM provider would you like to use?');
  for (const key of Object.keys(PROVIDERS)) {
    console.log(`  ${key}) ${PROVIDERS[key].label}`);
  }

  const choices = Object.keys(PROVIDERS);
  let provider = null;
  while (!provider) {
    const choice = await prompter.ask(
      `Enter a number (${choices[0]}-${choices[choices.length - 1]}): `
    );
    if (PROVIDERS[choice]) {
      provider = PROVIDERS[choice];
    } else {
      console.log('Not a valid option, please try again.');
    }
  }

  const apiKeys = [];

  // 1. Ask for Free or Paid tier
  let planType = '';
  while (planType !== '1' && planType !== '2') {
    planType = await prompter.ask(
      '\nAre you using:\n  1) Free API Keys\n  2) Paid API Keys\nSelect (1 or 2): '
    );
  }

  // 2. Ask how many keys the user wants to add (any positive integer)
  let numKeys = 0;
  while (isNaN(numKeys) || numKeys < 1) {
    const inputNum = await prompter.ask('\nHow many API keys do you want to add?: ');
    numKeys = parseInt(inputNum, 10);
    if (isNaN(numKeys) || numKeys < 1) {
      console.log('Please enter a valid positive number (e.g., 1, 2, 5).');
    }
  }

  // 3. Prompt for each API key sequentially
  console.log(`\nPlease enter your ${numKeys} API key(s):`);
  for (let i = 1; i <= numKeys; i++) {
    let key = '';
    while (!key) {
      key = await prompter.ask(`Enter API Key #${i}: `);
      if (!key) {
        console.log('Key cannot be empty. Please re-enter.');
      }
    }
    apiKeys.push(key);
  }

  const modelAnswer = await prompter.ask(`Model to use [default: ${provider.defaultModel}]: `);
  const model = modelAnswer || provider.defaultModel;

  if (!existingPrompter) prompter.close();

  if (apiKeys.length === 0) {
    throw new Error('No API keys provided.');
  }

  return { provider, apiKeys, model };
}

module.exports = { createPrompter, promptForMode, promptForProviderAndApiKey, MODES };
