'use strict';

/**
 * Launch mode — run what is already in the Project folder.
 *
 * The build mode's smoke test starts the project blind, in the
 * background, for a few seconds, to prove it boots. This is the other
 * thing: the user wants the app RUNNING, in their terminal, for as long
 * as they like.
 *
 * Nothing is started until the ground is checked. The project on disk is
 * read — its manifest, its environment variables, the services its
 * dependencies imply, the port it binds — and every prerequisite that
 * could plausibly be missing is put to the user as a question first:
 * is PostgreSQL up, is there a .env, was the schema applied, is the port
 * free. A launch that dies three seconds in on ECONNREFUSED teaches the
 * user nothing; a question asked beforehand tells them exactly what to
 * fix.
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const { PROJECT_DIR, SMOKE_INSTALL_TIMEOUT_MS } = require('../config');
const { listProjectFiles } = require('../plan/verify');
const { detectStack, readProjectFile, projectHas } = require('./stack');

// How many env var names to print before trimming the list.
const MAX_ENV_VARS_SHOWN = 12;

// --------------------------------------------------------------------
// Reading the project
// --------------------------------------------------------------------

/** Every source file worth grepping for env vars and service clients. */
function sourceFiles(files) {
  return files.filter(
    (f) =>
      !/(^|\/)(node_modules|\.git|dist|build|venv|__pycache__)\//.test(f) &&
      /\.(js|mjs|cjs|ts|py|go|json|ya?ml|env|example|sql|md)$/i.test(f)
  );
}

/**
 * The environment variables the code actually reads:
 * `process.env.X`, `os.environ["X"]`, `os.getenv("X")`, `os.Getenv("X")`,
 * plus every key declared in a .env.example.
 */
function collectEnvVars(files) {
  const found = new Set();
  const patterns = [
    /process\.env\.([A-Z][A-Z0-9_]{2,})/g,
    /process\.env\[['"]([A-Z][A-Z0-9_]{2,})['"]\]/g,
    /os\.environ(?:\.get)?[[(]\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
    /os\.getenv\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
    /os\.Getenv\(\s*"([A-Z][A-Z0-9_]{2,})"/g,
  ];

  for (const rel of sourceFiles(files)) {
    const text = readProjectFile(rel);
    if (!text) continue;
    for (const pattern of patterns) {
      let match;
      pattern.lastIndex = 0;
      while ((match = pattern.exec(text)) !== null) found.add(match[1]);
    }
  }

  // A .env.example is the project's own statement of what it needs.
  for (const rel of ['.env.example', '.env.sample', 'env.example']) {
    for (const line of readProjectFile(rel).split('\n')) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]{2,})\s*=/);
      if (match) found.add(match[1]);
    }
  }

  // These always have a sane default or are opt-in switches — they are
  // not something the user has to set up before starting.
  for (const optional of ['NODE_ENV', 'PORT', 'ELECTRON_DEVTOOLS', 'ELECTRON_RUN_AS_NODE']) {
    found.delete(optional);
  }
  return [...found].sort();
}

/**
 * External services the project will try to talk to, inferred from its
 * dependencies, its env var names and its connection strings. Each one
 * becomes a question, because each one is a way the launch can die on
 * startup through no fault of the code.
 */
function detectServices(files) {
  const haystack = [
    readProjectFile('package.json'),
    readProjectFile('requirements.txt'),
    readProjectFile('pyproject.toml'),
    readProjectFile('go.mod'),
    readProjectFile('docker-compose.yml'),
    readProjectFile('docker-compose.yaml'),
    readProjectFile('.env.example'),
    ...sourceFiles(files)
      .filter((f) => /\.(js|mjs|cjs|ts|py|go)$/i.test(f))
      .slice(0, 60)
      .map(readProjectFile),
  ]
    .join('\n')
    .toLowerCase();

  const catalogue = [
    {
      name: 'PostgreSQL',
      test: /"pg"|\bpsycopg|postgresql:\/\/|postgres:\/\/|\bsequelize\b|postgres_(user|password|db)|pgbouncer|lib\/pq/,
      question: 'Is your PostgreSQL server running and accepting connections?',
      hint:
        'Start it first — e.g. `pg_ctl start`, `brew services start postgresql`, ' +
        '`sudo service postgresql start`, or `docker compose up -d db`.',
    },
    {
      name: 'MySQL / MariaDB',
      test: /mysql2?|mariadb|mysql:\/\//,
      question: 'Is your MySQL/MariaDB server running?',
      hint: 'Start it with `sudo service mysql start` or `docker compose up -d db`.',
    },
    {
      name: 'MongoDB',
      test: /mongoose|mongodb(\+srv)?:\/\/|"mongodb"/,
      question: 'Is your MongoDB server running?',
      hint: 'Start it with `mongod`, `brew services start mongodb-community`, or Docker.',
    },
    {
      name: 'Redis',
      test: /"redis"|ioredis|redis:\/\//,
      question: 'Is your Redis server running?',
      hint: 'Start it with `redis-server` or `docker run -p 6379:6379 redis`.',
    },
    {
      name: 'A message broker (RabbitMQ / Kafka)',
      test: /amqplib|amqp:\/\/|kafkajs|"kafka"|rabbitmq/,
      question: 'Is your message broker (RabbitMQ/Kafka) running?',
      hint: 'Start it with Docker, or the app will fail to connect on startup.',
    },
  ];

  return catalogue.filter((service) => service.test.test(haystack));
}

/** Schema/migration work the user has to have done before the app will read anything. */
function detectSchemaSetup(files) {
  const sqlFiles = files.filter((f) => /\.sql$/i.test(f) && !/node_modules/.test(f));
  if (sqlFiles.length > 0) {
    return {
      question:
        `This project ships ${sqlFiles.length} SQL file(s) — have you created ` +
        'the database and applied them?',
      hint:
        'Apply them before starting, e.g.\n' +
        sqlFiles
          .slice(0, 4)
          .map((f) => `      psql -d <your_db> -f ${f}`)
          .join('\n'),
    };
  }
  if (projectHas('prisma/schema.prisma')) {
    return {
      question: 'Have you run the Prisma migrations against your database?',
      hint: 'Run `npx prisma migrate deploy` (or `npx prisma db push`) in Project/ first.',
    };
  }
  if (files.some((f) => /(^|\/)migrations\//i.test(f))) {
    return {
      question: 'Have you applied the database migrations in migrations/?',
      hint: 'Run your migration command before starting, or the app will query missing tables.',
    };
  }
  return null;
}

/**
 * Does this project ship a desktop shell?
 *
 * A project with an `electron` script is meant to be opened as a desktop
 * window, not as a page in a browser — the shell starts the backend
 * itself and owns its lifetime. Launch mode runs that instead of the
 * plain server, so the user never ends up at a URL when the project has
 * an app.
 */
function detectDesktopShell() {
  if (!projectHas('package.json')) return null;

  let pkg = {};
  try {
    pkg = JSON.parse(readProjectFile('package.json'));
  } catch (e) {
    return null;
  }

  if (!pkg.scripts || !pkg.scripts.electron) return null;

  return {
    label: 'Electron desktop app',
    startCmd: 'npm run electron',
    // The Electron binary is a ~100 MB download living in
    // devDependencies, so it can easily be the one thing missing.
    installed: projectHas(path.join('node_modules', 'electron')),
  };
}

/** Is anything already listening on this port? */
function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net
      .createServer()
      .once('error', () => resolve(false))
      .once('listening', () => server.close(() => resolve(true)))
      .listen(port, '127.0.0.1');
  });
}

/** Run the stack's install command, inheriting the terminal. */
function install(stack) {
  try {
    execSync(stack.installCmd, {
      cwd: PROJECT_DIR,
      timeout: SMOKE_INSTALL_TIMEOUT_MS,
      encoding: 'utf8',
      shell: process.platform === 'win32' ? true : '/bin/bash',
      stdio: 'inherit',
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

// --------------------------------------------------------------------
// The preflight questions
// --------------------------------------------------------------------

/**
 * Walk the user through everything that has to be true before the app
 * can start. Returns { proceed, port, extraEnv } — proceed is false when
 * they decide to go and fix something first.
 */
async function preflight(prompter, stack, files, desktop) {
  console.log('\n' + '-'.repeat(68));
  console.log('  PREFLIGHT — a few questions before anything is started');
  console.log('-'.repeat(68));
  console.log(`  Stack detected : ${stack.label} (${stack.manifest})`);
  console.log(`  Runs as        : ${desktop ? desktop.label : 'a web app in your browser'}`);
  console.log(`  Start command  : ${stack.startCmd}`);
  console.log(`  Backend port   : ${stack.port}`);
  console.log('-'.repeat(68));

  const warnings = [];
  const extraEnv = {};
  let port = stack.port;
  let step = 1;

  // --- Dependencies -----------------------------------------------------
  const installed = stack.installedMarker ? projectHas(stack.installedMarker) : null;
  if (stack.installCmd) {
    if (installed === false) {
      console.log(
        `\n[${step}] Dependencies are NOT installed — ${stack.installedMarker}/ is missing.`
      );
      const doInstall = await prompter.ask_yes_no(
        `    Run \`${stack.installCmd}\` now?`,
        true
      );
      if (!doInstall) {
        console.log(
          '    Skipping. The app will almost certainly fail on a missing module — ' +
          `run \`cd Project && ${stack.installCmd}\` yourself first.`
        );
        warnings.push('dependencies were never installed');
      } else {
        console.log(`    Running ${stack.installCmd} ... (this can take a few minutes)`);
        const result = install(stack);
        if (result.ok) {
          console.log('    Dependencies installed.');
        } else {
          console.log(`    Install FAILED: ${result.message}`);
          const carryOn = await prompter.ask_yes_no('    Try to start it anyway?', false);
          if (!carryOn) return { proceed: false };
          warnings.push('the dependency install failed');
        }
      }
    } else {
      const question =
        installed === true
          ? `\n[${step}] ${stack.installedMarker}/ is present. Have you installed ` +
            'dependencies since the last change to the manifest?'
          : `\n[${step}] This stack installs with \`${stack.installCmd}\`. ` +
            'Have you already installed its dependencies?';
      const ready = await prompter.ask_yes_no(question, true);
      if (!ready) {
        const doInstall = await prompter.ask_yes_no(
          `    Run \`${stack.installCmd}\` now?`,
          true
        );
        if (doInstall) {
          const result = install(stack);
          if (!result.ok) {
            console.log(`    Install FAILED: ${result.message}`);
            warnings.push('the dependency install failed');
          }
        } else {
          warnings.push('dependencies may be out of date');
        }
      }
    }
    step += 1;
  }

  // --- The desktop shell itself ------------------------------------------
  // Checked separately from the dependency step above: node_modules/ can
  // be present and complete for the server while the Electron binary,
  // a large devDependency download, is absent.
  if (desktop && !desktop.installed && stack.installCmd) {
    console.log(`
[${step}] Electron itself is NOT installed (node_modules/electron is missing).`);
    console.log('    Without it the desktop window cannot open.');
    const doInstall = await prompter.ask_yes_no(
      `    Run \`${stack.installCmd}\` to fetch it now (a ~100 MB download)?`,
      true
    );
    if (doInstall) {
      const result = install(stack);
      if (result.ok && projectHas(path.join('node_modules', 'electron'))) {
        console.log('    Electron installed.');
        desktop.installed = true;
      } else {
        console.log(`    Electron is still missing${result.ok ? '' : `: ${result.message}`}`);
        const carryOn = await prompter.ask_yes_no('    Try to launch anyway?', false);
        if (!carryOn) return { proceed: false };
        warnings.push('Electron is not installed — the window will not open');
      }
    } else {
      const carryOn = await prompter.ask_yes_no('    Try to launch anyway?', false);
      if (!carryOn) return { proceed: false };
      warnings.push('Electron is not installed — the window will not open');
    }
    step += 1;
  }

  // --- Environment file --------------------------------------------------
  const envVars = collectEnvVars(files);
  const hasEnv = projectHas('.env');
  const exampleName = ['.env.example', '.env.sample', 'env.example'].find(projectHas);

  if (envVars.length > 0) {
    console.log(
      `\n[${step}] This project reads ${envVars.length} environment variable(s):`
    );
    console.log(
      '    ' +
      envVars.slice(0, MAX_ENV_VARS_SHOWN).join(', ') +
      (envVars.length > MAX_ENV_VARS_SHOWN
        ? `, ... (+${envVars.length - MAX_ENV_VARS_SHOWN} more)`
        : '')
    );

    if (hasEnv) {
      console.log('    Project/.env exists.');
      const filled = await prompter.ask_yes_no(
        '    Are the real values filled in (database URL, secrets, API keys)?',
        true
      );
      if (!filled) warnings.push('.env may still hold placeholder values');
    } else if (exampleName) {
      console.log(`    Project/.env is MISSING, but ${exampleName} is there.`);
      const copy = await prompter.ask_yes_no(
        `    Create .env from ${exampleName} now (you still have to fill in the values)?`,
        true
      );
      if (copy) {
        try {
          fs.copyFileSync(
            path.join(PROJECT_DIR, exampleName),
            path.join(PROJECT_DIR, '.env')
          );
          console.log('    Wrote Project/.env — open it and put the real values in.');
          const done = await prompter.ask_yes_no(
            '    Have you filled it in already?',
            false
          );
          if (!done) {
            console.log(
              '    Fine — edit Project/.env, then re-run `node agent.js` and ' +
              'choose Launch again.'
            );
            return { proceed: false };
          }
        } catch (err) {
          console.log(`    Could not copy it: ${err.message}`);
          warnings.push('no .env file');
        }
      } else {
        warnings.push('no .env file');
      }
    } else {
      console.log('    Project/.env is MISSING and there is no example to copy.');
      const carryOn = await prompter.ask_yes_no(
        '    Start anyway (the code falls back to defaults where it can)?',
        true
      );
      if (!carryOn) return { proceed: false };
      warnings.push('no .env file — the app runs on whatever defaults the code has');
    }
    step += 1;
  }

  // --- External services -------------------------------------------------
  for (const service of detectServices(files)) {
    console.log(`\n[${step}] ${service.name} looks like a dependency of this project.`);
    const up = await prompter.ask_yes_no(`    ${service.question}`, true);
    if (!up) {
      console.log(`    ${service.hint}`);
      const carryOn = await prompter.ask_yes_no(
        `    Start the app anyway without ${service.name}?`,
        false
      );
      if (!carryOn) return { proceed: false };
      warnings.push(`${service.name} is not running`);
    }
    step += 1;
  }

  // --- Schema / migrations ------------------------------------------------
  const schema = detectSchemaSetup(files);
  if (schema) {
    console.log(`\n[${step}] Database schema.`);
    const applied = await prompter.ask_yes_no(`    ${schema.question}`, true);
    if (!applied) {
      console.log(`    ${schema.hint}`);
      const carryOn = await prompter.ask_yes_no(
        '    Start the app anyway (reads and writes will fail until you do)?',
        false
      );
      if (!carryOn) return { proceed: false };
      warnings.push('the database schema has not been applied');
    }
    step += 1;
  }

  // --- Port ---------------------------------------------------------------
  if (port) {
    console.log(
      `\n[${step}] Port ${port}` +
      (desktop ? ' — the desktop app starts the backend on it.' : '.')
    );
    let free = await isPortFree(port);
    while (!free) {
      console.log(
        `    Port ${port} is ALREADY IN USE — something else is listening there ` +
        '(an earlier run of this app, most likely).'
      );
      const answer = await prompter.ask(
        '    Enter a different port, or press Enter to stop and free it yourself: '
      );
      const chosen = parseInt(answer, 10);
      if (!answer || Number.isNaN(chosen) || chosen < 1 || chosen > 65535) {
        console.log('    Stopping. Kill whatever holds the port, then launch again.');
        return { proceed: false };
      }
      port = chosen;
      free = await isPortFree(port);
    }
    if (port !== stack.port) {
      extraEnv.PORT = String(port);
      console.log(`    Using port ${port} instead (PORT=${port} is passed to the app).`);
    } else {
      console.log(`    Port ${port} is free.`);
    }
    step += 1;
  }

  // --- Final confirmation --------------------------------------------------
  console.log('\n' + '-'.repeat(68));
  if (warnings.length > 0) {
    console.log('  Starting with these caveats:');
    for (const warning of warnings) console.log(`    - ${warning}`);
  } else {
    console.log('  Everything checks out.');
  }
  console.log('-'.repeat(68));

  const go = await prompter.ask_yes_no(
    `\nStart the project now with \`${stack.startCmd}\`?`,
    true
  );
  return { proceed: go, port, extraEnv };
}

// --------------------------------------------------------------------
// Running it
// --------------------------------------------------------------------

/**
 * Start the app in the foreground and hand the terminal over to it. The
 * agent stays out of the way from here: the app's own output is the
 * output, and Ctrl+C stops it.
 */
function runInForeground(stack, port, extraEnv, isWeb, desktop) {
  const bar = '='.repeat(68);
  console.log(`\n${bar}`);
  console.log(`  RUNNING — ${stack.startCmd}   (in Project/)`);
  if (desktop) {
    console.log('  A desktop window will open shortly — the app starts its own');
    console.log('  backend and shuts it down again when you close the window.');
    console.log('  Close the window (or press Ctrl+C here) to stop everything.');
  } else {
    if (isWeb && port) console.log(`  Open   ->  http://localhost:${port}/`);
    console.log('  Press Ctrl+C to stop.');
  }
  console.log(bar + '\n');

  const childEnv = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV || 'development',
    ...extraEnv,
  };

  // A terminal opened from inside an Electron app — VS Code's integrated
  // terminal is the common one — inherits ELECTRON_RUN_AS_NODE=1. That
  // variable makes the electron binary behave as plain Node, so the app
  // would die on `app.requestSingleInstanceLock` instead of opening a
  // window. The desktop shell sets it deliberately for its own server
  // child; Electron itself must never inherit it.
  if (desktop) delete childEnv.ELECTRON_RUN_AS_NODE;

  // Set when we are the ones who ended it, so a deliberate Ctrl+C is
  // not reported as a crash: taskkill makes the shell exit non-zero.
  let killedByUs = false;

  return new Promise((resolve) => {
    const child = spawn(stack.startCmd, {
      cwd: PROJECT_DIR,
      shell: true,
      stdio: 'inherit',
      env: childEnv,
    });

    // Ctrl+C belongs to the app while it is running; pass it through and
    // let the exit handler below end the launch.
    //
    // The command runs through a shell, so `child` is the shell, not the
    // app — and Windows has no process groups, so signalling the shell
    // leaves npm, electron and the backend it spawned running, holding
    // the port against the next launch. taskkill /T walks the tree.
    const forward = () => {
      if (child.exitCode !== null) return;
      killedByUs = true;
      try {
        if (process.platform === 'win32') {
          execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
        } else {
          child.kill('SIGINT');
        }
      } catch (e) {
        try {
          child.kill('SIGKILL');
        } catch (e2) {
          // Already gone.
        }
      }
    };
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);

    child.on('error', (err) => {
      console.error(`\n[launch] Could not start it: ${err.message}`);
      process.removeListener('SIGINT', forward);
      process.removeListener('SIGTERM', forward);
      resolve(1);
    });

    child.on('exit', (code, signal) => {
      process.removeListener('SIGINT', forward);
      process.removeListener('SIGTERM', forward);
      console.log(`\n${bar}`);
      // Ctrl+C is a normal way to end a launch, not a crash. Through a
      // shell the signal comes back as 128+n rather than in `signal`,
      // and a taskkill'd shell on Windows simply reports exit code 1 —
      // so the fact that WE killed it is the reliable signal.
      const stoppedByUser =
        killedByUs ||
        signal === 'SIGINT' ||
        signal === 'SIGTERM' ||
        code === 130 ||
        code === 143;
      if (stoppedByUser || code === 0 || code === null) {
        console.log('  Stopped.');
      } else {
        console.log(`  The app exited with code ${code}.`);
        console.log('  Read the error above. If it is a missing module, install again;');
        console.log('  if it is a refused connection, the database or cache it needs is');
        console.log('  not running; if it is a missing variable, check Project/.env.');
        console.log('  To have the agent FIX it, re-run `node agent.js` and choose');
        console.log('  "Make the project" instead.');
      }
      console.log(bar);
      resolve(stoppedByUser || code === null ? 0 : code);
    });
  });
}

// --------------------------------------------------------------------
// Entry point
// --------------------------------------------------------------------

/**
 * Launch mode end to end: check there is something to launch, work out
 * how it starts, ask the preflight questions, then run it.
 *
 * The prompter is closed before the child starts — the app owns stdin
 * from that point on.
 */
async function launchProject(prompter, plan) {
  console.log('\n=== Launch mode — running the project in Project/ ===');

  const files = listProjectFiles();
  if (files.length === 0) {
    console.log(
      '\n[launch] The Project folder is empty — there is nothing to launch yet.\n' +
      '[launch] Re-run `node agent.js` and choose "Make the project" first.'
    );
    prompter.close();
    return 1;
  }

  console.log(`[launch] ${files.length} file(s) found in Project/.`);

  const stack = detectStack(files);
  if (stack.broken) {
    console.log(`\n[launch] Cannot launch this project: ${stack.broken}`);
    prompter.close();
    return 1;
  }
  if (!stack.startCmd) {
    console.log(
      '\n[launch] Cannot work out how to start this project: there is no "start" ' +
      'script in its manifest and no recognisable entry file ' +
      '(src/index.js, app.py, main.go, ...).'
    );
    console.log('[launch] See Project/RUN.md, or start it by hand.');
    prompter.close();
    return 1;
  }

  // A project that ships a desktop shell is opened as an app, not as a
  // URL in a browser. The shell starts the same backend underneath, so
  // everything the preflight asks about still applies.
  const desktop = detectDesktopShell();
  if (desktop) {
    console.log(
      `[launch] ${desktop.label} detected — this project opens in its own ` +
      'window, not in a browser.'
    );
    stack.startCmd = desktop.startCmd;
  }

  const { proceed, port, extraEnv } = await preflight(prompter, stack, files, desktop);

  // From here the app owns the terminal, so stop reading stdin ourselves.
  prompter.close();

  if (!proceed) {
    console.log(
      '\n[launch] Not started. Fix the item above, then run `node agent.js` ' +
      'and choose Launch again.'
    );
    return 0;
  }

  const uiKind = plan && plan.ui ? plan.ui.kind : null;
  // There is no build plan in launch mode: treat anything that binds a
  // port as something the user will open in a browser — unless there is
  // a desktop shell, in which case there is no URL to hand them.
  const isWeb = desktop
    ? false
    : uiKind
      ? uiKind === 'web' || uiKind === 'desktop'
      : Boolean(port);

  return runInForeground(stack, port, extraEnv, isWeb, desktop);
}

module.exports = {
  launchProject,
  // Exposed for the shutdown test in the agent's own checks; not part of
  // the module's public surface.
  __runInForeground: runInForeground,
  preflight,
  detectDesktopShell,
  collectEnvVars,
  detectServices,
  detectSchemaSetup,
  isPortFree,
};
