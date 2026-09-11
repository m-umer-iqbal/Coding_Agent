'use strict';

/**
 * Work out how to install and start whatever the model built.
 *
 * Nothing here is told what the project is — it reads the manifests and
 * entry points that are actually on disk and derives the commands from
 * them, so a Node service, a Python API and a Go binary are all handled
 * the same way.
 */

const fs = require('fs');
const path = require('path');

const { PROJECT_DIR } = require('../config');

/** Read a file inside the project, or '' if it isn't there. */
function readProjectFile(rel) {
  try {
    return fs.readFileSync(path.join(PROJECT_DIR, rel), 'utf8');
  } catch (e) {
    return '';
  }
}

function projectHas(rel) {
  return fs.existsSync(path.join(PROJECT_DIR, rel));
}

/**
 * The port the app will listen on, dug out of the code the model wrote:
 * `process.env.PORT || 8080`, `PORT=8080` in .env.example, `listen(3000)`,
 * `uvicorn --port 8000`. Falls back to the ecosystem default.
 */
function detectPort(files, fallback) {
  const candidates = files.filter((f) =>
    /(^|\/)(\.env\.example|\.env|docker-compose\.ya?ml|README\.md)$|\.(js|mjs|ts|py|go|json|ya?ml)$/i.test(f)
  );

  const patterns = [
    /process\.env\.PORT\s*\|\|\s*(\d{2,5})/,
    /\bPORT\s*[=:]\s*["']?(\d{2,5})/i,
    /\.listen\(\s*(\d{2,5})/,
    /--port[ =](\d{2,5})/,
    /localhost:(\d{2,5})/,
  ];

  for (const pattern of patterns) {
    for (const rel of candidates) {
      const match = readProjectFile(rel).match(pattern);
      if (match) {
        const port = parseInt(match[1], 10);
        if (port >= 80 && port <= 65535) return port;
      }
    }
  }
  return fallback;
}

/** The Node start command: the start script if there is one, else the main file. */
function nodeStartCommand(pkg) {
  if (pkg.scripts && typeof pkg.scripts.start === 'string' && pkg.scripts.start.trim()) {
    return 'npm start';
  }
  const main = typeof pkg.main === 'string' && pkg.main ? pkg.main : null;
  for (const candidate of [main, 'src/index.js', 'index.js', 'app.js', 'server.js', 'src/server.js']) {
    if (candidate && projectHas(candidate)) return `node ${candidate}`;
  }
  return null;
}

/** The Python start command, chosen from the framework the deps name. */
function pythonStartCommand(files, requirements) {
  const deps = requirements.toLowerCase();

  if (/fastapi|uvicorn/.test(deps)) {
    for (const rel of ['main.py', 'app/main.py', 'src/main.py', 'app.py']) {
      if (projectHas(rel)) {
        const moduleName = rel.replace(/\.py$/, '').replace(/\//g, '.');
        return `python -m uvicorn ${moduleName}:app --host 127.0.0.1`;
      }
    }
  }
  if (/^django|django==/m.test(deps) && projectHas('manage.py')) {
    return 'python manage.py runserver';
  }
  for (const rel of ['app.py', 'main.py', 'src/main.py', 'run.py', 'cli.py', 'src/app.py']) {
    if (projectHas(rel)) return `python ${rel}`;
  }
  const anyPy = files.find((f) => /(^|\/)(main|app|cli|run)\.py$/i.test(f));
  return anyPy ? `python ${anyPy}` : null;
}

/**
 * Identify the stack from the manifests on disk and return everything
 * needed to install, start and reach the project.
 */
function detectStack(files) {
  if (projectHas('package.json')) {
    let pkg = {};
    try {
      pkg = JSON.parse(readProjectFile('package.json'));
    } catch (e) {
      return {
        id: 'node',
        label: 'Node.js',
        broken: 'package.json is not valid JSON, so nothing can be installed or started.',
      };
    }
    return {
      id: 'node',
      label: 'Node.js',
      manifest: 'package.json',
      installCmd: 'npm install',
      installedMarker: 'node_modules',
      startCmd: nodeStartCommand(pkg),
      testCmd: pkg.scripts && pkg.scripts.test ? 'npm test' : null,
      port: detectPort(files, 3000),
      prerequisites: ['Node.js 18 or newer', 'npm'],
    };
  }

  if (projectHas('requirements.txt') || projectHas('pyproject.toml')) {
    const requirements = readProjectFile('requirements.txt');
    return {
      id: 'python',
      label: 'Python',
      manifest: projectHas('requirements.txt') ? 'requirements.txt' : 'pyproject.toml',
      installCmd: projectHas('requirements.txt')
        ? 'pip install -r requirements.txt'
        : 'pip install .',
      installedMarker: null,
      startCmd: pythonStartCommand(files, requirements),
      testCmd: /pytest/.test(requirements.toLowerCase()) ? 'pytest' : null,
      port: detectPort(files, 8000),
      prerequisites: ['Python 3.10 or newer', 'pip'],
    };
  }

  if (projectHas('go.mod')) {
    return {
      id: 'go',
      label: 'Go',
      manifest: 'go.mod',
      installCmd: 'go mod download',
      installedMarker: null,
      startCmd: projectHas('main.go') ? 'go run main.go' : 'go run ./...',
      testCmd: 'go test ./...',
      port: detectPort(files, 8080),
      prerequisites: ['Go 1.21 or newer'],
    };
  }

  return {
    id: 'unknown',
    label: 'unrecognised',
    broken:
      'no dependency manifest was found (no package.json, requirements.txt, ' +
      'pyproject.toml or go.mod), so there is no way to install or start it.',
  };
}

module.exports = { detectStack, detectPort, readProjectFile, projectHas };
