'use strict';

/**
 * Prove the generated project actually runs.
 *
 * Everything else in this agent checks that files EXIST. This module
 * checks that they WORK: it installs the dependencies, starts the app the
 * way a user would, and — depending on what the spec asked for — either
 * requests pages over HTTP or runs the command-line entry point. The
 * verdict is measured, and the failure output is fed straight back to the
 * model so it can fix what it broke.
 *
 * It is deliberately conservative: a stack it does not recognise, or a
 * system with no runnable surface, is reported as "not verified" rather
 * than as a failure.
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const {
  PROJECT_DIR,
  SMOKE_INSTALL_TIMEOUT_MS,
  SMOKE_BOOT_TIMEOUT_MS,
  SMOKE_PROBE_ATTEMPTS,
  SMOKE_PROBE_INTERVAL_MS,
  SMOKE_OUTPUT_CHARS,
  SMOKE_CLI_TIMEOUT_MS,
} = require('../config');
const { sleep } = require('../util');
const { listProjectFiles, checkPlan } = require('../plan/verify');
const { extractAssetRefs, normalizePath } = require('../plan/frontend');
const { detectStack, projectHas } = require('./stack');

// --------------------------------------------------------------------
// Process helpers
// --------------------------------------------------------------------

/** Keep only the tail of a child process's output — that is where errors are. */
function tail(text, limit = SMOKE_OUTPUT_CHARS) {
  const value = String(text || '').replace(/\r/g, '');
  if (value.length <= limit) return value.trim();
  return `... [earlier output trimmed]\n${value.slice(-limit).trim()}`;
}

/** Kill a child and everything it spawned (npm start -> node -> …). */
function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch (e) {
    try {
      child.kill('SIGKILL');
    } catch (e2) {
      // Already gone.
    }
  }
}

/** One HTTP GET with a hard timeout. Any response at all means "server up". */
async function probe(url, { body = false } = {}) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(4000),
      redirect: 'manual',
    });
    const result = { reached: true, status: response.status };
    if (body) {
      result.body = (await response.text()).slice(0, 200000);
      result.contentType = response.headers.get('content-type') || '';
    }
    return result;
  } catch (err) {
    return { reached: false, error: err.name === 'TimeoutError' ? 'timed out' : err.message };
  }
}

/**
 * Load the page the way a browser would: fetch every stylesheet and
 * script it references, then call the API paths its code uses.
 *
 * This is what separates "the server responded" from "the app works". A
 * 200 on / with a 404 on /js/app.js is a blank screen, and a 404 on
 * /api/v1/questions is a button that does nothing.
 */
async function probePageDependencies(base, html, apiCalls) {
  const assets = [];
  for (const ref of extractAssetRefs(html).slice(0, 25)) {
    const url = ref.startsWith('/') ? `${base}${ref}` : `${base}/${ref.replace(/^\.\//, '')}`;
    const result = await probe(url);
    assets.push({ path: ref, ...result });
  }

  const endpoints = [];
  for (const call of apiCalls.slice(0, 15)) {
    // Only paths with no parameter holes can be requested blind.
    if (normalizePath(call).includes('*')) continue;
    const result = await probe(`${base}${call}`);
    endpoints.push({ path: call, ...result });
  }

  return { assets, endpoints };
}

// --------------------------------------------------------------------
// Steps
// --------------------------------------------------------------------

/** Install dependencies, unless they are demonstrably already installed. */
function installDependencies(stack) {
  if (!stack.installCmd) return { ok: true, skipped: 'nothing to install' };
  if (stack.installedMarker && projectHas(stack.installedMarker)) {
    return { ok: true, skipped: `${stack.installedMarker}/ already present` };
  }

  console.log(`[smoke] Installing dependencies: ${stack.installCmd}`);
  try {
    const output = execSync(stack.installCmd, {
      cwd: PROJECT_DIR,
      timeout: SMOKE_INSTALL_TIMEOUT_MS,
      encoding: 'utf8',
      shell: process.platform === 'win32' ? true : '/bin/bash',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024 * 32,
    });
    return { ok: true, output: tail(output) };
  } catch (err) {
    const output = tail(`${err.stdout || ''}\n${err.stderr || ''}\n${err.message || ''}`);
    return { ok: false, command: stack.installCmd, output };
  }
}

/**
 * Start the app, wait for it to answer on its port, and shut it down.
 * The server's own stdout/stderr is captured either way — a crash on boot
 * is the single most useful thing to hand back to the model.
 */
async function bootAndProbe(stack, paths, apiCalls = []) {
  console.log(`[smoke] Starting the app: ${stack.startCmd}`);

  const child = spawn(stack.startCmd, {
    cwd: PROJECT_DIR,
    shell: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'development' },
  });

  let output = '';
  let exited = null;
  const collect = (buf) => {
    output += buf.toString();
    if (output.length > SMOKE_OUTPUT_CHARS * 4) {
      output = output.slice(-SMOKE_OUTPUT_CHARS * 2);
    }
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });
  child.on('error', (err) => {
    output += `\n[spawn error] ${err.message}`;
    exited = { code: -1, signal: null };
  });

  const base = `http://127.0.0.1:${stack.port}`;
  const deadline = Date.now() + SMOKE_BOOT_TIMEOUT_MS;
  let reached = false;

  for (let attempt = 0; attempt < SMOKE_PROBE_ATTEMPTS && Date.now() < deadline; attempt++) {
    if (exited) break; // it died before it ever listened
    await sleep(SMOKE_PROBE_INTERVAL_MS);
    const result = await probe(`${base}/`);
    if (result.reached) {
      reached = true;
      break;
    }
  }

  const urls = [];
  let assets = [];
  let endpoints = [];
  if (reached) {
    for (const p of paths) {
      const result = await probe(`${base}${p}`, { body: p === '/' });
      urls.push({ path: p, status: result.status, reached: result.reached, error: result.error });
      if (p === '/' && result.body && /<html|<!doctype/i.test(result.body)) {
        const deps = await probePageDependencies(base, result.body, apiCalls);
        assets = deps.assets;
        endpoints = deps.endpoints;
      }
    }
  }

  killTree(child);
  await sleep(200);

  if (exited && !reached) {
    return {
      ok: false,
      started: false,
      reason:
        `the app exited immediately (exit code ${exited.code}${exited.signal ? `, signal ${exited.signal}` : ''}) ` +
        'instead of listening for requests',
      urls,
      output: tail(output),
    };
  }

  if (!reached) {
    return {
      ok: false,
      started: false,
      reason:
        `nothing was listening on ${base} after ${Math.round(SMOKE_BOOT_TIMEOUT_MS / 1000)}s — ` +
        'the app either failed to start, crashed while starting, or is ' +
        `listening on a different port than ${stack.port}`,
      urls,
      output: tail(output),
    };
  }

  // Reached, but the pages a user needs may still be broken.
  const broken = urls.filter((u) => !u.reached || u.status >= 500);
  if (broken.length > 0) {
    return {
      ok: false,
      started: true,
      reason:
        'the server started, but ' +
        broken
          .map((u) => `${u.path} ${u.reached ? `returned HTTP ${u.status}` : `did not respond (${u.error})`}`)
          .join(', '),
      urls,
      assets,
      endpoints,
      output: tail(output),
    };
  }

  // The page loads. Does everything ON the page load?
  const brokenAssets = assets.filter((a) => !a.reached || a.status >= 400);
  if (brokenAssets.length > 0) {
    return {
      ok: false,
      started: true,
      reason:
        'the page loads but the browser cannot fetch ' +
        brokenAssets
          .map((a) => `"${a.path}" (${a.reached ? `HTTP ${a.status}` : a.error})`)
          .join(', ') +
        ' — the interface renders broken, with no styling or no behaviour',
      urls,
      assets,
      endpoints,
      output: tail(output),
    };
  }

  const brokenEndpoints = endpoints.filter((e) => !e.reached || e.status === 404 || e.status >= 500);
  if (brokenEndpoints.length > 0) {
    return {
      ok: false,
      started: true,
      reason:
        'the interface calls endpoints the server does not answer: ' +
        brokenEndpoints
          .map((e) => `${e.path} -> ${e.reached ? `HTTP ${e.status}` : e.error}`)
          .join(', ') +
        ' — those screens are dead',
      urls,
      assets,
      endpoints,
      output: tail(output),
    };
  }

  return { ok: true, started: true, urls, assets, endpoints, output: tail(output) };
}

/** For a command-line project: does the entry point run and print its help? */
function runCliHelp(stack) {
  const command = `${stack.startCmd} --help`;
  console.log(`[smoke] Running the CLI: ${command}`);
  try {
    const output = execSync(command, {
      cwd: PROJECT_DIR,
      timeout: SMOKE_CLI_TIMEOUT_MS,
      encoding: 'utf8',
      shell: process.platform === 'win32' ? true : '/bin/bash',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024 * 8,
    });
    if (!output || output.trim().length < 10) {
      return {
        ok: false,
        reason: '`--help` printed nothing, so the CLI has no usable interface yet',
        output: tail(output),
      };
    }
    return { ok: true, output: tail(output) };
  } catch (err) {
    return {
      ok: false,
      reason: '`--help` exited with an error instead of printing usage',
      output: tail(`${err.stdout || ''}\n${err.stderr || ''}\n${err.message || ''}`),
    };
  }
}

// --------------------------------------------------------------------
// The check itself
// --------------------------------------------------------------------

/** Which pages a web project must be able to serve. */
function pathsToProbe(files) {
  const paths = ['/'];
  const hasHealth = files.some((f) => /health/i.test(f)) ||
    listProjectFiles().some((f) => {
      try {
        return /['"`]\/health['"`]/.test(fs.readFileSync(path.join(PROJECT_DIR, f), 'utf8'));
      } catch (e) {
        return false;
      }
    });
  if (hasHealth) paths.push('/health');
  return paths;
}

/**
 * Install, start and exercise the project. Returns a verdict object:
 *   { verified, ok, stack, port, steps, reason, output, startCmd, … }
 * `verified: false` means the check could not be run (unknown stack, a
 * mobile app, a library) — that is not a failure.
 */
async function runSmokeTest(plan) {
  const files = listProjectFiles();
  if (files.length === 0) {
    return { verified: false, ok: false, skipped: 'the project folder is empty' };
  }

  const stack = detectStack(files);
  if (stack.broken) {
    return { verified: true, ok: false, stack, reason: stack.broken, output: '' };
  }

  const surfaceKind = plan && plan.ui ? plan.ui.kind : 'none';
  const strategy =
    surfaceKind === 'web' || surfaceKind === 'desktop'
      ? 'http'
      : surfaceKind === 'cli'
        ? 'cli'
        : 'install-only';

  const steps = [];

  const install = installDependencies(stack);
  steps.push({
    name: `install (${stack.installCmd || 'n/a'})`,
    ok: install.ok,
    detail: install.skipped || (install.ok ? 'completed' : 'FAILED'),
  });
  if (!install.ok) {
    return {
      verified: true,
      ok: false,
      stack,
      steps,
      reason: `\`${install.command}\` failed, so the project cannot even be installed`,
      output: install.output,
    };
  }

  if (!stack.startCmd) {
    return {
      verified: true,
      ok: false,
      stack,
      steps,
      reason:
        'there is no way to start this project: no "start" script in the ' +
        'manifest and no recognisable entry file (src/index.js, app.py, main.go, …)',
      output: '',
    };
  }

  if (strategy === 'install-only') {
    steps.push({
      name: 'run',
      ok: true,
      detail: `not applicable for a ${plan && plan.ui ? plan.ui.label : 'non-interactive'} project`,
    });
    return {
      verified: false,
      ok: true,
      stack,
      steps,
      skipped:
        `dependencies install cleanly; starting it is not something this ` +
        'check can do for that kind of project',
    };
  }

  // The static review already worked out which API paths the UI calls;
  // reuse it so the runtime check exercises the same ones.
  let apiCalls = [];
  try {
    const status = checkPlan(plan);
    if (status.uiReview) {
      apiCalls = [
        ...(status.uiReview.facts.apiCalls || []),
        ...(status.uiReview.facts.derivedCalls || []),
      ];
    }
  } catch (e) {
    apiCalls = [];
  }

  const result =
    strategy === 'cli'
      ? runCliHelp(stack)
      : await bootAndProbe(stack, pathsToProbe(files), apiCalls);

  // "Did the server come up?" is a different question from "does the whole
  // interface work?" — a page that loads with a 404 script means the first
  // succeeded and the second did not.
  const started = strategy === 'cli' ? result.ok : result.started !== false;
  steps.push({
    name: strategy === 'cli' ? `run (${stack.startCmd} --help)` : `start (${stack.startCmd})`,
    ok: started,
    detail: started
      ? strategy === 'cli'
        ? 'printed usage'
        : `listening on port ${stack.port}`
      : 'FAILED',
  });

  if (result.urls) {
    for (const url of result.urls) {
      steps.push({
        name: `GET ${url.path}`,
        ok: url.reached && url.status < 500,
        detail: url.reached ? `HTTP ${url.status}` : `no response (${url.error})`,
      });
    }
  }

  for (const asset of result.assets || []) {
    steps.push({
      name: `asset ${asset.path}`,
      ok: asset.reached && asset.status < 400,
      detail: asset.reached ? `HTTP ${asset.status}` : `no response (${asset.error})`,
    });
  }

  for (const endpoint of result.endpoints || []) {
    steps.push({
      name: `API ${endpoint.path}`,
      ok: endpoint.reached && endpoint.status !== 404 && endpoint.status < 500,
      detail: endpoint.reached ? `HTTP ${endpoint.status}` : `no response (${endpoint.error})`,
    });
  }

  return {
    verified: true,
    ok: result.ok,
    stack,
    steps,
    strategy,
    reason: result.reason,
    output: result.output,
    urls: result.urls || [],
    assets: result.assets || [],
    endpoints: result.endpoints || [],
  };
}

// --------------------------------------------------------------------
// Reporting
// --------------------------------------------------------------------

/** The failure, written for the model: what broke, and what to do next. */
function formatSmokeFailureForModel(result) {
  const lines = [
    'REJECTED — the files exist, but the project DOES NOT RUN.',
    '',
    'The agent installed the dependencies and tried to start the project ' +
    'exactly as a user would. The result:',
    '',
    `  ${result.reason}`,
  ];

  if (result.steps) {
    lines.push('', 'Steps:');
    for (const step of result.steps) {
      lines.push(`  ${step.ok ? '[ok]  ' : '[FAIL]'} ${step.name} — ${step.detail}`);
    }
  }

  if (result.output) {
    lines.push('', 'Output from the attempt:', '```', result.output, '```');
  }

  lines.push(
    '',
    'Fix this now. Read the failing file with read_file, correct the real ' +
    'cause (a missing dependency in the manifest, a bad require/import ' +
    'path, a crash on startup, a client that connects to a database at ' +
    'import time, a port mismatch), and write the fix with write_file.',
    '',
    'Make the project start with NO external services running: if a ' +
    'database, cache or broker is unreachable, log a warning and fall back ' +
    'to an in-process store rather than throwing during startup. A user ' +
    'must be able to clone this and run it with one command.',
    '',
    'Do not call task_complete again until it starts.'
  );

  return lines.join('\n');
}

/** RUN.md — the file the user opens when they want to run what was built. */
function writeRunGuide(result, plan) {
  const stack = result.stack || {};
  const lines = [
    '# How to run this project',
    '',
    `_Generated by agent.js on ${new Date().toISOString().slice(0, 16).replace('T', ' ')}._`,
    '',
  ];

  if (result.verified && result.ok) {
    lines.push(
      '## Verified',
      '',
      'The agent ran these steps on this machine and they worked:',
      ''
    );
    for (const step of result.steps || []) {
      lines.push(`- \`${step.name}\` — ${step.detail}`);
    }
  } else if (result.verified) {
    lines.push(
      '## Not working yet',
      '',
      `The agent tried to start this project and it failed: ${result.reason}`,
      '',
      'The steps below are still the right ones — fix the error above first.'
    );
  } else {
    lines.push(
      '## Not verified',
      '',
      `The agent did not start this project automatically (${result.skipped || 'unsupported stack'}).`
    );
  }

  lines.push('', '## Quick start', '', '```bash', 'cd Project');
  if (stack.installCmd) lines.push(stack.installCmd);
  if (stack.startCmd) lines.push(stack.startCmd);
  lines.push('```', '');

  if (stack.port && plan && plan.ui && (plan.ui.kind === 'web' || plan.ui.kind === 'desktop')) {
    lines.push(
      `Then open **http://localhost:${stack.port}/** in a browser.`,
      '',
      'The backend serves the user interface, so this one command is all you',
      'need — there is no separate frontend server to start.',
      ''
    );
    if (result.urls && result.urls.length > 0) {
      lines.push('Checked URLs:', '');
      for (const url of result.urls) {
        lines.push(
          `- \`http://localhost:${stack.port}${url.path}\` → ` +
          (url.reached ? `HTTP ${url.status}` : `no response (${url.error})`)
        );
      }
      lines.push('');
    }
  }

  if (stack.prerequisites) {
    lines.push('## Prerequisites', '');
    for (const item of stack.prerequisites) lines.push(`- ${item}`);
    lines.push('');
  }

  if (stack.testCmd) {
    lines.push('## Running the tests', '', '```bash', `cd Project`, stack.testCmd, '```', '');
  }

  lines.push(
    '## If it does not start',
    '',
    `- Port ${stack.port || 'in use'} already taken? Set \`PORT\` to something else and restart.`,
    '- Dependencies out of date? Delete the install folder and install again.',
    '- Reading an error about a database, cache or broker? Those are optional',
    '  for local use — the app should start without them.',
    '- Full architecture details are in `README.md` next to this file.',
    ''
  );

  try {
    fs.writeFileSync(path.join(PROJECT_DIR, 'RUN.md'), lines.join('\n'), 'utf8');
    return 'RUN.md';
  } catch (e) {
    return null;
  }
}

/** The last thing the user sees: exactly what to type. */
function printRunBanner(result, plan) {
  const stack = result.stack || {};
  const bar = '═'.repeat(68);

  console.log(`\n${bar}`);
  console.log('  RUN IT');
  console.log(bar);

  if (!stack.startCmd) {
    console.log(`  Could not work out how to start this project: ${result.reason || result.skipped}`);
    console.log(bar);
    return;
  }

  console.log('  cd Project');
  if (stack.installCmd) console.log(`  ${stack.installCmd}`);
  console.log(`  ${stack.startCmd}`);

  if (stack.port && plan && plan.ui && (plan.ui.kind === 'web' || plan.ui.kind === 'desktop')) {
    console.log(`\n  then open  ->  http://localhost:${stack.port}/`);
  }

  if (result.verified && result.ok) {
    const probes = (result.urls || [])
      .map((u) => `${u.path} ${u.reached ? u.status : 'no response'}`)
      .join(', ');
    console.log(
      `\n  Verified by the agent: it installed, started${probes ? ` and answered ${probes}` : ''}.`
    );
  } else if (result.verified) {
    console.log(`\n  NOT verified: ${result.reason}`);
    console.log('  Re-run "node agent.js" to let the agent fix it.');
  } else {
    console.log(`\n  Not verified automatically (${result.skipped || 'unsupported stack'}).`);
  }

  console.log(`  Full instructions: Project/RUN.md`);
  console.log(bar);
}

/** Console summary of a smoke run, printed as it finishes. */
function printSmokeResult(result) {
  if (!result.verified) {
    console.log(`[smoke] Skipped: ${result.skipped}`);
    return;
  }
  for (const step of result.steps || []) {
    console.log(`[smoke] ${step.ok ? 'ok  ' : 'FAIL'} ${step.name} — ${step.detail}`);
  }
  console.log(
    result.ok
      ? '[smoke] PASS — the project installs and runs.'
      : `[smoke] FAIL — ${result.reason}`
  );
}

module.exports = {
  runSmokeTest,
  formatSmokeFailureForModel,
  writeRunGuide,
  printRunBanner,
  printSmokeResult,
};
