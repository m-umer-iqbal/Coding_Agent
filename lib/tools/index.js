'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const {
  PROJECT_DIR,
  RUN_BASH_BUDGET,
  RUN_BASH_TIMEOUT_MS,
  RUN_BASH_MAX_OUTPUT_CHARS,
} = require('../config');

// ====================================================================
// Tool implementations
//
// Tools: write_file, read_file, list_dir, run_bash, task_complete
// All generated file paths are resolved relative to PROJECT_DIR and are prevented
// from escaping it.
// ====================================================================

/** Resolve a user-supplied relative path safely within PROJECT_DIR. */
function resolveSafePath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('Path must be a non-empty string.');
  }
  const resolved = path.resolve(PROJECT_DIR, relativePath);
  if (resolved !== PROJECT_DIR && !resolved.startsWith(PROJECT_DIR + path.sep)) {
    throw new Error(
      `Refusing to access path outside the project directory: ${relativePath}`
    );
  }
  return resolved;
}

function toolWriteFile(input) {
  const { path: relPath, content } = input;
  const fullPath = resolveSafePath(relPath);

  // Say plainly when a write replaced something, so a resumed run cannot
  // quietly wipe work an earlier run had already finished.
  const existed = fs.existsSync(fullPath) && fs.statSync(fullPath).isFile();
  const previousBytes = existed ? fs.statSync(fullPath).size : 0;

  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content ?? '', 'utf8');
  const bytes = Buffer.byteLength(content ?? '', 'utf8');

  if (!existed) return `Wrote ${bytes} bytes to ${relPath} (new file).`;
  return (
    `OVERWROTE the existing file ${relPath} (was ${previousBytes} bytes, ` +
    `now ${bytes} bytes). If that file already held working code you did ` +
    'not mean to replace, read_file it and restore what you dropped.'
  );
}

function toolReadFile(input) {
  const { path: relPath } = input;
  const fullPath = resolveSafePath(relPath);
  if (!fs.existsSync(fullPath)) {
    return `ERROR: file does not exist: ${relPath}`;
  }
  return fs.readFileSync(fullPath, 'utf8');
}

function toolListDir(input) {
  const relPath = input && input.path ? input.path : '.';
  const fullPath = resolveSafePath(relPath);
  if (!fs.existsSync(fullPath)) {
    return `ERROR: directory does not exist: ${relPath}`;
  }
  const entries = fs.readdirSync(fullPath, { withFileTypes: true });
  const lines = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  return lines.length > 0 ? lines.join('\n') : '(empty directory)';
}

function toolRunBash(input) {
  const { command } = input;
  if (!command || typeof command !== 'string') {
    return 'ERROR: no command provided';
  }
  try {
    const output = execSync(command, {
      cwd: PROJECT_DIR,
      timeout: RUN_BASH_TIMEOUT_MS,
      encoding: 'utf8',
      // Let Node select the host OS's default command interpreter.
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024 * 10,
    });
    return truncateOutput(`EXIT CODE: 0\n${output}`);
  } catch (err) {
    const stdout = err.stdout ? err.stdout.toString() : '';
    const stderr = err.stderr ? err.stderr.toString() : '';
    const exitCode = typeof err.status === 'number' ? err.status : 'unknown';
    return truncateOutput(
      `EXIT CODE: ${exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}\n${err.signal ? `SIGNAL: ${err.signal}\n` : ''
      }${err.message && !stdout && !stderr ? `MESSAGE: ${err.message}\n` : ''}`
    );
  }
}

function truncateOutput(text) {
  if (text.length <= RUN_BASH_MAX_OUTPUT_CHARS) return text;
  const half = Math.floor(RUN_BASH_MAX_OUTPUT_CHARS / 2);
  return (
    text.slice(0, half) +
    `\n... [truncated ${text.length - RUN_BASH_MAX_OUTPUT_CHARS} chars] ...\n` +
    text.slice(text.length - half)
  );
}

/**
 * Tool schema definitions sent to the Anthropic API.
 */
const TOOL_DEFINITIONS = [
  {
    name: 'write_file',
    description:
      'Write content to a file, creating any necessary parent directories. ' +
      'Paths are relative to the Project folder inside the directory where ' +
      'agent.js is running. NOTE: this REPLACES the whole file if it ' +
      'already exists — there is no append and no partial edit. The Project ' +
      'folder may already contain files from an earlier run; those are ' +
      'listed in the EXISTING PROJECT STATE block of the first user ' +
      'message. Before writing to a path that is already there, call ' +
      'read_file on it and rewrite it in full, keeping what still works.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative file path to write, e.g. "src/index.js"',
        },
        content: {
          type: 'string',
          description: 'Full text content to write to the file.',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'read_file',
    description:
      'Read and return the full text content of a file in the Project folder.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative file path to read.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_dir',
    description:
      'List the files and subdirectories inside a directory. ' +
      'Defaults to the Project folder if no path is given. Use it to see ' +
      'what an earlier run already wrote before you add files next to it.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative directory path to list. Defaults to ".".',
        },
      },
      required: [],
    },
  },
  {
    name: 'run_bash',
    description:
      'Execute a shell command in the project root directory (e.g. ' +
      '"npm install", "npm test", "python -m pytest"). Returns exit code, ' +
      'stdout, and stderr. You may call this on ANY turn, but only ' +
      `${RUN_BASH_BUDGET} times in the entire run — once that budget is ` +
      'used, further calls are rejected and not executed. Batch as much ' +
      'as possible into one command (e.g. "npm install && npm test") so a ' +
      'single call covers installation and verification together. Commands ' +
      'run through the host OS default shell, so prefer portable npm, node, ' +
      'python, and test-runner commands and avoid shell-specific syntax. ' +
      'The command starts in the Project folder.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute.',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'task_complete',
    description:
      'Call this ONLY when the WHOLE system has been built — every ' +
      'component, every deliverable, every use case, and the user ' +
      'interface if the build plan asked for one — dependencies install ' +
      'cleanly, and tests pass (or you have clearly explained why a check ' +
      'could not be run in this environment). A backend with no frontend ' +
      'is not complete, and neither is a project you only added a README ' +
      'to. The call is verified against the filesystem and rejected if ' +
      'anything in the plan is still missing. The agent then INSTALLS AND ' +
      'STARTS the project and requests a page from it; if it does not run, ' +
      'this call is rejected too and you are given the error output. ' +
      'This ends the agent run. ' +
      'IMPORTANT: the "summary" field is printed verbatim as the final ' +
      'user-facing output of this run. It MUST be a complete "How to run ' +
      'this project" guide — not a one-liner, not a bullet list of files ' +
      'written. A developer who has never seen this codebase must be able ' +
      'to read only this summary and get the project running. ' +
      'Required sections (use these exact headings): ' +
      '"## What was built", ' +
      '"## Prerequisites", ' +
      '"## Environment setup", ' +
      '"## Database setup", ' +
      '"## Installation", ' +
      '"## Running the application", ' +
      '"## Opening the app in a browser", ' +
      '"## Running the tests", ' +
      '"## Key API endpoints", ' +
      '"## User interface", ' +
      '"## Architecture requirements coverage". ' +
      'Each section must contain real content — exact commands, real ' +
      'env variable names, real port numbers. Do not omit or abbreviate ' +
      'any section.',
    input_schema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description:
            'A complete "How to run this project" guide for a developer ' +
            'who has never seen this codebase. Must contain all eleven ' +
            'sections listed in the tool description, with exact commands ' +
            'and real values throughout. This text is printed verbatim ' +
            'as the final output of the agent run — do not truncate it.',
        },
      },
      required: ['summary'],
    },
  },
];

/** Dispatch a single tool_use block to its implementation. */
function executeTool(name, input) {
  switch (name) {
    case 'write_file':
      return toolWriteFile(input);
    case 'read_file':
      return toolReadFile(input);
    case 'list_dir':
      return toolListDir(input);
    case 'run_bash':
      return toolRunBash(input);
    case 'task_complete':
      return null; // handled specially in the main loop
    default:
      return `ERROR: unknown tool "${name}"`;
  }
}

module.exports = {
  TOOL_DEFINITIONS,
  executeTool,
  resolveSafePath,
  toolWriteFile,
  toolReadFile,
  toolListDir,
  toolRunBash,
  truncateOutput,
};
