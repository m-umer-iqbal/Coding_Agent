'use strict';

const {
  MAX_TURNS,
  KEY_CYCLE_PAUSE_MS,
  RUN_BASH_BUDGET,
  MAX_COMPLETION_REJECTIONS,
  CONSOLE_TREE_LINES,
  SMOKE_TEST_ENABLED,
  MAX_SMOKE_ATTEMPTS,
} = require('../config');
const { sleep, formatBytes } = require('../util');
const { buildStructuredSpec } = require('../spec/parse');
const { deriveBuildPlan, formatBuildPlan } = require('../plan/derive');
const {
  listProjectFiles,
  checkPlan,
  missingFromStatus,
  verifyCompletion,
  buildProgressReminder,
} = require('../plan/verify');
const { scanExistingProject, formatExistingProjectState } = require('../project/scan');
const { executeTool } = require('../tools');
const {
  createPrompter,
  promptForMode,
  promptForProviderAndApiKey,
} = require('../ui/prompter');
const { callProviderWithRetry } = require('../providers');
const {
  runSmokeTest,
  formatSmokeFailureForModel,
  writeRunGuide,
  printRunBanner,
  printSmokeResult,
} = require('../runner/smoke');
const { launchProject } = require('../runner/launch');
const { compactHistory } = require('./history');
const { logToolCall, logToolResult } = require('./log');

// ====================================================================
// Main agent loop
// ====================================================================

async function main({ turnsBeforeKeySwitch = 4 } = {}) {
  console.log('=== Simple Code Agent (agent.js) ===\n');

  // One prompter for the whole run: the mode question, the provider
  // menu and the launch preflight all read from the same stdin, and two
  // readline interfaces over it would eat each other's lines.
  const prompter = createPrompter();

  // The first question of every run: build the project, or run the one
  // that is already there. Launch mode needs no LLM, no API key and no
  // architecture document — only the Project folder.
  const mode = await promptForMode(prompter);
  if (mode === 'launch') {
    const code = await launchProject(prompter);
    if (code) process.exitCode = code;
    return;
  }

  let spec;
  try {
    spec = buildStructuredSpec();
  } catch (err) {
    console.error(`\n[fatal] ${err.message}`);
    process.exit(1);
  }

  const buildPlan = deriveBuildPlan(spec);

  // Scan the Project folder before anything else. If an earlier run
  // already wrote files, this run must continue that project rather than
  // scaffold it again from the first file.
  const projectScan = scanExistingProject();
  if (projectScan.isEmpty) {
    console.log('[scan] Project folder is empty — starting a fresh build.');
  } else {
    console.log(
      `[scan] Project folder already contains ${projectScan.fileCount} file(s) ` +
      `in ${projectScan.dirCount} director(ies) ` +
      `(${formatBytes(projectScan.totalBytes)}) — resuming that project.`
    );
    for (const line of projectScan.treeLines.slice(0, CONSOLE_TREE_LINES)) {
      console.log(`  ${line}`);
    }
    if (projectScan.treeLines.length > CONSOLE_TREE_LINES) {
      console.log(
        `  ... [${projectScan.treeLines.length - CONSOLE_TREE_LINES} more entries]`
      );
    }

    const status = checkPlan(buildPlan);
    const outstanding = missingFromStatus(status);
    if (outstanding.length === 0) {
      console.log(
        '[scan] Build plan already satisfied on disk — this run will review, ' +
        'verify and finish.'
      );
    } else {
      console.log(
        `[scan] ${outstanding.length} build-plan item(s) still outstanding — ` +
        'the model will be told to pick up from there.'
      );
      if (status.uiMissing.length > 0) {
        console.log(
          `[scan] ${buildPlan.ui.label}: ${status.uiFiles.length} file(s) ` +
          'found — incomplete, so this run will be pushed to build it.'
        );
      }
    }
  }

  let provider, apiKeys, model;
  try {
    ({ provider, apiKeys, model } = await promptForProviderAndApiKey(prompter));
  } catch (err) {
    console.error(`\n[fatal] ${err.message}`);
    process.exit(1);
  }

  // The build loop never reads stdin again, and a live readline
  // interface would keep the process alive after the run ends.
  prompter.close();

  console.log(`\n[agent] Using provider: ${provider.label} (model: ${model})`);
  console.log(`[agent] Loaded ${apiKeys.length} API key(s) for rotation.`);

  const initialUserMessage = {
    role: 'user',
    content:
      'Here is the architecture specification, as structured JSON ' +
      '(sections, codeBlocks, diagrams).\n\n' +
      '```json\n' +
      JSON.stringify(spec, null, 2) +
      '\n```\n\n' +
      // What is already on disk, scanned just now. On a first run this
      // says the folder is empty; on later runs it is the tree, the
      // manifests and the per-item status the model must continue from.
      formatExistingProjectState(projectScan, buildPlan) +
      '\n\n' +
      formatBuildPlan(buildPlan) +
      '\n\n' +
      (projectScan.isEmpty
        ? 'Scaffold a complete project on disk that implements the whole ' +
        'specification, using your tools.'
        : 'Continue this existing project on disk until the whole ' +
        'specification is implemented, using your tools. Add and fix — ' +
        'do not rebuild what is already there.') +
      `\n\nTURN BUDGET: you have ${MAX_TURNS} turns total for this whole ` +
      `run, and ${RUN_BASH_BUDGET} run_bash calls you may spend on any turn.`
  };

  const messages = [initialUserMessage];

  // --- Initialize loop tracking variables ---
  let turn = 0;
  let completed = false;
  let activeKeyIndex = 0;
  let completionRejections = 0;
  let runBashUsed = 0;
  let noToolCallStreak = 0;
  let smokeAttempts = 0;
  let smokeResult = null;     // the last runnability verdict, printed at the end
  let completionSummary = ''; // populated by task_complete, printed in the final report

  while (turn < MAX_TURNS && !completed) {
    turn += 1;

    // --- KEY ROTATION & PAUSE LOGIC ---
    if (apiKeys.length > 0) {
      if (turn > 1 && (turn - 1) % turnsBeforeKeySwitch === 0) {
        const nextIndex = (activeKeyIndex + 1) % apiKeys.length;

        console.log(`\n================================================================`);
        console.log(`[rotation] Reached ${turnsBeforeKeySwitch} turns on Key #${activeKeyIndex + 1}.`);

        if (nextIndex === 0) {
          console.log(`[rotation] All ${apiKeys.length} key(s) used. Pausing for ${KEY_CYCLE_PAUSE_MS / 1000} seconds...`);
          console.log(`================================================================\n`);
          await sleep(KEY_CYCLE_PAUSE_MS);
          console.log(`[rotation] Resuming run with Key #1...\n`);
        } else {
          console.log(`[rotation] Switching directly to Key #${nextIndex + 1}...`);
          console.log(`================================================================\n`);
        }

        activeKeyIndex = nextIndex;
      }
    }

    const currentKey = apiKeys[activeKeyIndex];

    console.log(`\n----- Turn ${turn}/${MAX_TURNS} [Key #${activeKeyIndex + 1}] -----`);

    let response;
    try {
      response = await callProviderWithRetry(
        provider.id,
        currentKey,
        model,
        compactHistory(messages)
      );
    } catch (err) {
      if (err.status === 429) {
        console.error(`\n[fatal] API key #${activeKeyIndex + 1} hit rate limits.`);
      } else {
        console.error(`\n[fatal] API call failed: ${err.message}`);
      }
      process.exit(1);
    }

    const contentBlocks = response.content || [];

    // Log any plain-text reasoning/commentary from the model.
    for (const block of contentBlocks) {
      if (block.type === 'text' && block.text && block.text.trim()) {
        console.log(`\n[agent says]\n${block.text.trim()}`);
      }
    }

    // Append the assistant's turn to the running message history.
    messages.push({ role: 'assistant', content: contentBlocks });

    const toolUseBlocks = contentBlocks.filter((b) => b.type === 'tool_use');

    if (toolUseBlocks.length === 0) {
      // No tool call means nothing reached disk. Nudge rather than
      // break out — this is recoverable — and let the streak counter
      // below stop a model that simply will not use its tools.
      noToolCallStreak += 1;
      console.log(
        `\n[agent] Model replied without calling a tool ` +
        `(${noToolCallStreak} in a row). Nudging it back to the tools.`
      );

      if (noToolCallStreak >= 3) {
        console.log(
          '[agent] Model will not use its tools. Stopping to avoid burning turns.'
        );
        break;
      }

      messages.push({
        role: 'user',
        content:
          'You replied with text but called no tool, so nothing was ' +
          'written to disk. Do not describe what you will do — do it.' +
          buildProgressReminder(
            buildPlan,
            turn,
            RUN_BASH_BUDGET - runBashUsed
          ) +
          '\n\nRespond with a write_file tool call now.',
      });
      continue;
    }

    noToolCallStreak = 0;

    // Execute each tool call and collect results for the next turn.
    const toolResultBlocks = [];
    // Set when the run-check rejected task_complete: every planned file
    // exists, so the usual "here is what is still missing" reminder would
    // contradict the rejection.
    let smokeRejected = false;

    for (const block of toolUseBlocks) {
      const { name, input, id } = block;
      logToolCall(name, input);

      if (name === 'task_complete') {
        // Don't take the model's word for it — check the disk.
        const missing = verifyCompletion(buildPlan);

        if (missing.length > 0 && completionRejections < MAX_COMPLETION_REJECTIONS) {
          completionRejections += 1;
          console.log(
            `\n[task_complete REJECTED ${completionRejections}/${MAX_COMPLETION_REJECTIONS}] ` +
            `${missing.length} item(s) from the build plan are still missing:`
          );
          for (const m of missing) console.log(`  - ${m}`);

          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: id,
            name,
            content:
              'REJECTED — the project is NOT complete. A filesystem check ' +
              `found ${missing.length} outstanding item(s):\n` +
              missing.map((m) => `  - ${m}`).join('\n') +
              '\n\nDo not call task_complete again until these exist. ' +
              'Write the next missing file now, one write_file call at a time.',
          });
          break;
        }

        if (missing.length > 0) {
          console.log(
            `\n[task_complete] Accepting after ${completionRejections} rejection(s), ` +
            'but the build plan is still incomplete:'
          );
          for (const m of missing) console.log(`  - ${m}`);
        }

        // Every planned file exists. Now the harder question: does any of
        // it actually run? Install it, start it, request a page from it.
        if (SMOKE_TEST_ENABLED && smokeAttempts < MAX_SMOKE_ATTEMPTS) {
          smokeAttempts += 1;
          console.log(
            `\n[smoke] Build plan satisfied — verifying the project actually ` +
            `runs (attempt ${smokeAttempts}/${MAX_SMOKE_ATTEMPTS}).`
          );
          smokeResult = await runSmokeTest(buildPlan);
          printSmokeResult(smokeResult);

          if (smokeResult.verified && !smokeResult.ok) {
            smokeRejected = true;
            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: id,
              name,
              content: formatSmokeFailureForModel(smokeResult),
            });
            break; // back to the model with the real error
          }
        }

        console.log(`\n[task_complete] ${input.summary || '(no summary provided)'}`);
        completionSummary = input.summary || '';
        completed = true;
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: id,
          name,
          content: 'Task marked complete. Ending run.',
        });
        break; // don't bother executing further tools this turn
      }

      // run_bash is capped by a total budget rather than a turn window:
      // the model verifies whenever it judges best, but only
      // RUN_BASH_BUDGET times, so it can't spend the run shelling out.
      if (name === 'run_bash') {
        if (runBashUsed >= RUN_BASH_BUDGET) {
          const result =
            `REJECTED — the run_bash budget is exhausted (${RUN_BASH_BUDGET} ` +
            `of ${RUN_BASH_BUDGET} calls used). The command was NOT ` +
            'executed. Write the remaining files with write_file, then call ' +
            'task_complete.';
          logToolResult(name, result);
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: id,
            name,
            content: result,
          });
          continue;
        }
        runBashUsed += 1;
        console.log(
          `[run_bash] Using budget ${runBashUsed}/${RUN_BASH_BUDGET}.`
        );
      }

      let result;
      try {
        result = executeTool(name, input);
      } catch (err) {
        result = `ERROR: ${err.message}`;
      }
      logToolResult(name, result);

      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: id,
        name,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      });
    }

    // Re-state what is outstanding and how many turns remain, every
    // turn — including the build/verify phase boundary.
    if (!completed && toolResultBlocks.length > 0) {
      const last = toolResultBlocks[toolResultBlocks.length - 1];
      last.content += smokeRejected
        ? `\n\n[turn budget] Turn ${turn}/${MAX_TURNS} ` +
        `(${MAX_TURNS - turn} left). Every planned file already exists, so ` +
        'do NOT write new features and do NOT re-check the build plan. Fix ' +
        'the startup failure above — read the failing file, correct the ' +
        'cause, write it back — then call task_complete again.'
        : buildProgressReminder(buildPlan, turn, RUN_BASH_BUDGET - runBashUsed);
    }

    messages.push({ role: 'user', content: toolResultBlocks });
  }

  // Final report: what actually landed on disk, measured — not what the
  // model claimed in its summary.
  const remaining = verifyCompletion(buildPlan);
  const written = listProjectFiles();

  const finalStatus = checkPlan(buildPlan);

  console.log('\n=== Run report ===');
  console.log(`Turns used: ${turn}/${MAX_TURNS}`);
  console.log(`Files in project: ${written.length}`);
  console.log(
    `Build plan: ${buildPlan.components.length} components, ` +
    `${buildPlan.deliverables.length} deliverables, ` +
    `${buildPlan.useCases.length} use cases`
  );
  if (buildPlan.ui.required) {
    console.log(
      `${buildPlan.ui.label}: ${finalStatus.uiFiles.length} file(s) — ` +
      (finalStatus.uiMissing.length === 0
        ? 'present and wired to the services.'
        : `INCOMPLETE (${finalStatus.uiMissing.length} issue(s)).`)
    );
  }

  if (remaining.length === 0) {
    console.log('Build plan: SATISFIED — every planned artifact exists.');
  } else {
    console.log(`Build plan: INCOMPLETE — ${remaining.length} item(s) missing:`);
    for (const m of remaining) console.log(`  - ${m}`);
  }

  // Always leave the user with a verified way to run what was built —
  // even when the run ended on the turn limit rather than task_complete.
  if (SMOKE_TEST_ENABLED && written.length > 0 && !smokeResult) {
    console.log('\n[smoke] Checking whether the project runs...');
    smokeResult = await runSmokeTest(buildPlan);
    printSmokeResult(smokeResult);
  }

  if (smokeResult) {
    const guide = writeRunGuide(smokeResult, buildPlan);
    if (guide) console.log(`[smoke] Wrote Project/${guide}`);
  }

  if (completed) {
    console.log('\n=== Agent finished: task_complete was called. ===');
    if (completionSummary) {
      console.log('\n' + '═'.repeat(68));
      console.log('  HOW TO RUN THIS PROJECT');
      console.log('═'.repeat(68));
      console.log(completionSummary);
      console.log('═'.repeat(68));
    }
  } else {
    const reason =
      turn >= MAX_TURNS
        ? `Turn limit reached (${MAX_TURNS} turns)`
        : `Stopped early after ${turn} turn(s) — the model would not use its tools`;
    console.log(
      `\n=== ${reason} before task_complete was called. Exiting cleanly. ===\n` +
      'Re-run "node agent.js" to continue where this run stopped: the next ' +
      'run scans the Project folder first, hands the model the file tree ' +
      'above along with what is still missing, and picks up from there ' +
      'instead of rebuilding what already exists.'
    );
  }

  if (smokeResult) printRunBanner(smokeResult, buildPlan);
}

module.exports = { main };
