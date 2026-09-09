#!/usr/bin/env node
/**
 * agent.js
 * ------------------------------------------------------------------
 * A Simple Code Agent (Node.js, Terminal-Based)
 *
 * Single file, no package.json, no dependencies, no SDK. Uses Node's
 * built-in fetch (Node 18+) to call Anthropic, OpenAI, or Gemini
 * directly; the user picks one from a menu at startup.
 *
 * It scans its own directory for the .md architecture inputs, parses
 * them into one flat JSON spec { sections, codeBlocks, diagrams },
 * derives a build plan from it, and hands the model five tools —
 * write_file, read_file, list_dir, run_bash, task_complete — to
 * scaffold the project. The LLM decides the whole output structure;
 * nothing here hardcodes it. task_complete is verified against the
 * filesystem, so the run cannot end while the plan is unmet.
 *
 * Usage:
 *   1. Copy agent.js into a folder containing Architecture_Documentation.md,
 *      Architecture_View.md, and a Project folder
 *   2. Open a terminal in that folder
 *   3. Run: node agent.js
 *   4. Pick a provider and paste its key when prompted.
 * ------------------------------------------------------------------
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ====================================================================
// Configuration constants
// ====================================================================

const MAX_TOKENS = 8192;
const MAX_TURNS = 100; // Total turn cap

// Multi-key rotation constants
const TURNS_PER_KEY = 14;      // Shift to next key on turn 14 to stay safe under 15 RPM
const KEY_CYCLE_PAUSE_MS = 60000; // 60-second pause after all keys are used once

// run_bash is not gated to a verify window at the end of the run: the
// model may call it on any turn, but only this many times in total, so a
// stray install/test loop can't eat the whole turn budget.
const RUN_BASH_BUDGET = 5;
const RUN_BASH_TIMEOUT_MS = 180000;
const RUN_BASH_MAX_OUTPUT_CHARS = 8000; // truncate huge command output
const PREVIEW_CHARS = 200; // console.log preview length for tool results
const WORKDIR = process.cwd();
const PROJECT_DIR = path.join(WORKDIR, 'Project');

// --- Completion gating -------------------------------------------------
// task_complete is checked against the build plan derived from the spec;
// if artifacts are missing the call is rejected. After this many
// rejections we accept anyway, so a disagreement can't loop forever.
const MAX_COMPLETION_REJECTIONS = 3;

// --- History budget ----------------------------------------------------
// Old tool results are the bulk of the transcript and are worthless once
// acted on, so they get elided to a stub past this many messages back.
const KEEP_FULL_TOOL_RESULTS_FOR_LAST_N_MESSAGES = 8;
const ELIDED_RESULT_MAX_CHARS = 300;

// Files that belong to the agent itself / its inputs, never to the
// generated project. Excluded from the completion scan.
const INPUT_ARTIFACTS = new Set(['agent.js']);

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

// ====================================================================
// System Prompt
// ====================================================================

const SYSTEM_PROMPT = `You are a code-generation agent. You will be given a structured JSON
specification of a software architecture — including components,
technology choices, API contracts, SQL schemas, and PlantUML diagrams.

Your job is to scaffold a complete, working project on disk that
implements the WHOLE architecture, using your tools.

COVERAGE IS THE PRIMARY REQUIREMENT. A small, tidy project that covers
one component is a FAILURE. The user message contains a BUILD PLAN
listing every component and every deliverable artifact the spec calls
for. You must produce all of them.

════════════════════════════════════════════════════════════════════════
HARD TURN BUDGET — READ THIS FIRST
════════════════════════════════════════════════════════════════════════
You have AT MOST ${MAX_TURNS} turns total for this entire run, and every
turn costs one API call whether you use a tool or not. There is no
partial credit for a plan you never finished writing to disk. On top of
the turn cap you get exactly ${RUN_BASH_BUDGET} run_bash calls for the
whole run, and you may spend them on ANY turn — there is no verify
window and no turn you have to wait for. Budget like this:

- Building is the default. Unless you have a specific reason to run a
  command, every turn must be a write_file call that produces a new,
  complete, real file. Do NOT re-read files you already wrote, do NOT
  polish — just keep producing the next missing file from the build plan.
- Spend your ${RUN_BASH_BUDGET} run_bash calls where they buy the most
  information — typically one early call to install dependencies and
  confirm the toolchain works, and the rest near the end to run the
  tests and fix what fails. Each run_bash call is still a turn stolen
  from a file that needs writing, so batch aggressively: prefer
  "npm install && npm test" over two separate calls.
- Once all ${RUN_BASH_BUDGET} calls are used, further run_bash calls are
  rejected and never executed. Do not burn them on sanity checks you
  could reason your way through instead.
- If turns run short and the build plan is not yet fully written, keep
  writing files and skip verification entirely. A project that exists
  but is unverified beats a verified project that is missing components.
- Never spend a turn on prose, planning, or asking a question. Every
  single turn must be exactly one tool call: write_file, run_bash, or
  task_complete.

════════════════════════════════════════════════════════════════════════
SPEC-DRIVEN REQUIREMENTS — HOW TO READ THE SPEC YOU ARE GIVEN
════════════════════════════════════════════════════════════════════════
The JSON spec you receive is parsed from whatever architecture documents
were found in the working directory. The content will differ on every
run. You must read and honour it completely. These rules apply to any
spec, regardless of domain or technology:

1. FUNCTIONAL REQUIREMENTS — from use-case, sequence, and class diagrams
   ─────────────────────────────────────────────────────────────────────
   • Extract every use case from the use-case diagram and implement it as
     a real endpoint or function — no placeholders.
   • Sequence diagrams define the EXACT call chain between components.
     Every arrow in a sequence diagram must become a real function call
     in code. Do not collapse two components into one just because it is
     easier.
   • Every class and method named in the class diagram must exist as real
     code. A method that only returns a hardcoded literal is a stub, not
     an implementation.
   • If the spec defines a state machine (state diagram), implement every
     state and every transition as named code paths. Reject illegal
     transitions with an appropriate error response (e.g. 409 Conflict).
   • If the spec names actors (User, Admin, Guest, …), implement the
     access-control rules that distinguish them.

2. DATA PERSISTENCE — satisfy whatever ASR the spec names for durability
   ─────────────────────────────────────────────────────────────────────
   • If the spec names a database (PostgreSQL, MySQL, MongoDB, SQLite,
     etc.), wire the corresponding client in every component that owns
     persistent data. In-memory Maps or plain arrays do NOT satisfy a
     data-durability requirement.
   • Read all connection settings from environment variables via a
     .env / dotenv pattern. Never hardcode credentials.
   • Use the SQL DDL or schema files from the spec; if they are absent,
     write them yourself based on the data model.
   • Use parameterised queries or an ORM — never string-interpolate user
     input into a query.
   • Provide a .env.example listing every required variable with a
     placeholder value.
   • In tests, mock or stub the database client so tests do not require a
     live database instance.

3. CACHING — satisfy whatever NFR the spec names for performance
   ─────────────────────────────────────────────────────────────────────
   • If the spec names a cache (Redis, Memcached, in-process LRU, etc.),
     import and configure the corresponding client.
   • Apply the cache to the components and read paths the spec describes.
     A typical pattern: check cache → on miss read from DB → write to
     cache with TTL → return result.
   • Read the cache connection URL from an environment variable.
   • Mock the cache client in tests.

4. SECURITY — satisfy whatever ASR the spec names for security
   ─────────────────────────────────────────────────────────────────────
   • If the spec names an auth mechanism (JWT, OAuth2, sessions, API
     keys, etc.), implement it fully — not just a header presence check.
     Verify signatures and expiry; check roles where the spec requires.
   • If the spec names password hashing (bcrypt, argon2, etc.), use it.
     Never store or return plain-text credentials.
   • Validate all required request fields before touching the database.
     Return descriptive 400 errors on validation failure.
   • Always use parameterised queries to prevent injection.
   • Read secrets (JWT_SECRET, API keys, etc.) from environment variables.

5. TRACEABILITY — map every requirement the spec defines
   ─────────────────────────────────────────────────────────────────────
   • If the spec contains a traceability matrix, ensure it has a row for
     EVERY requirement (FR, NFR, ASR) — not just the ones already listed.
     A matrix is only complete when every use case, quality attribute,
     and architectural decision has at least one entry.
   • If no matrix exists, create one.

6. API CONTRACT
   ─────────────────────────────────────────────────────────────────────
   • If the spec includes an OpenAPI / Swagger file, update it to reflect
     ALL endpoints you implement. A partial spec that only documents two
     or three paths out of ten is incomplete.
   • If no API contract file exists, create one that covers all routes.

7. TECHNOLOGY CHOICES
   ─────────────────────────────────────────────────────────────────────
   • Use the language, framework, and libraries named in the spec.
   • If the spec lists multiple options, pick the one marked as
     "recommended" or "default"; if none is marked, pick the first and
     note the choice in the README.
   • Do not introduce technologies not mentioned in the spec unless a
     required feature cannot be implemented without them — and if you do,
     explain why in the README.

════════════════════════════════════════════════════════════════════════
GENERAL IMPLEMENTATION RULES
════════════════════════════════════════════════════════════════════════
- Implement EVERY component named in the build plan, each in its own
  directory, even if the spec describes some of them only briefly. For a
  thinly-specified component, infer a reasonable implementation from its
  stated responsibility and the diagrams, and say so in the README.
- Produce EVERY deliverable filename listed in the build plan, at the
  exact path given.
- Endpoints must contain real logic — validation, state handling,
  persistence calls, error paths. Handlers that only return a hardcoded
  JSON literal do not count as implementing the component.
- The PlantUML diagrams are part of the spec, not decoration. Class and
  sequence diagrams tell you which classes, methods and call flows to
  write; implement them.
- Always include: source for each component, a dependency file
  (package.json or requirements.txt), a README.md, and real test files
  that assert behaviour — but writing test FILES costs no run_bash
  budget, while RUNNING them does. Write the test files freely; execute
  them with one of your ${RUN_BASH_BUDGET} run_bash calls.
- Include a Dockerfile only if it adds clear value.

════════════════════════════════════════════════════════════════════════
WORKING METHOD
════════════════════════════════════════════════════════════════════════
- Work incrementally — one file per write_file call.
- Never stop to ask the user a question; you are running unattended.
  Decide, write the file, and note the assumption in the README.
- Prefer finishing the next unwritten file over re-reading or polishing
  files you already wrote.
- Do not spend a run_bash call to sanity-check something small. Batch
  verification so a single command (e.g. "npm install && npm test")
  covers as much as possible, and keep calls in reserve for fixing the
  failures that command reveals.
- If a tool result tells you work is still outstanding, that is ground
  truth about the disk — believe it over your own recollection.

════════════════════════════════════════════════════════════════════════
FINISHING — task_complete REQUIREMENTS
════════════════════════════════════════════════════════════════════════
- Call task_complete ONLY when every component and every deliverable in
  the build plan exists on disk. Verification (dependencies installing,
  tests passing) should happen within your run_bash budget, ideally
  right before task_complete — not after every file.
- task_complete is verified against the actual filesystem. If artifacts
  are missing, the call is rejected and you must continue working.
- Running low on turns or run_bash calls is NOT a reason to call
  task_complete without writing the remaining files — but it IS a reason
  to skip or compress verification rather than skip files. Files on disk
  always outrank a clean test run.
- The "summary" field of task_complete is USER-FACING OUTPUT. It must be
  a complete "How to run this project" guide structured exactly like this:

    ## What was built
    <2-3 sentence description of the project and all components>

    ## Prerequisites
    <list every tool/runtime required, e.g. Node.js 18+, PostgreSQL 14+, Redis 6+>

    ## Environment setup
    <exact steps to create .env from .env.example and fill in values>

    ## Database setup
    <exact commands to create the database and run the DDL migrations>

    ## Installation
    \`\`\`
    npm install
    \`\`\`

    ## Running the application
    \`\`\`
    npm start
    \`\`\`
    <note the port and any key URLs, e.g. http://localhost:8080/health>

    ## Running the tests
    \`\`\`
    npm test
    \`\`\`

    ## Key API endpoints
    <bullet list of the most important routes with one-line descriptions>

    ## Architecture requirements coverage
    <bullet list mapping each FR/NFR/ASR to the file(s) that implement it>

  Do not abbreviate, truncate, or replace this guide with a one-liner.
  A developer reading only this output must be able to clone the repo
  and get the project running without opening any other file.`;

// ====================================================================
// Markdown -> structured JSON parsing
//
// Produces exactly one flat JSON object with three top-level keys:
//   sections   - keyed by section letter (A, B, C, ...) from
//                Architecture_Documentation.md
//   codeBlocks - every fenced code block from
//                Architecture_Documentation.md, tagged with language
//   diagrams   - every named PlantUML diagram from
//                Architecture_View.md
// ====================================================================

/**
 * Parse Architecture_Documentation.md into `sections` and `codeBlocks`.
 *
 * Sections are top-level headers of the form "# A. Executive Summary";
 * everything up to the next such header is that section's content.
 * Fenced code blocks stay inline in `content` AND are extracted
 * separately into `codeBlocks`.
 */
function parseArchitectureDocumentation(rawText) {
  const sections = {};
  const codeBlocks = [];

  // --- Extract fenced code blocks first (```lang ... ```) ---
  // Tolerant of both \n and \r\n line endings after the language tag.
  const codeBlockRegex = /```([A-Za-z0-9_+-]*)\r?\n([\s\S]*?)```/g;
  let match;
  while ((match = codeBlockRegex.exec(rawText)) !== null) {
    const lang = (match[1] || 'text').trim().toLowerCase();
    const code = match[2].replace(/\s+$/, '');
    codeBlocks.push({ lang, code });
  }

  // --- Split into top-level sections by "# <Letter>. <Title>" headers ---
  // Matches headers like: "# A. Executive Summary"
  const sectionHeaderRegex = /^#\s+([A-Z])\.\s+(.+)$/gm;
  const headerMatches = [];
  let hMatch;
  while ((hMatch = sectionHeaderRegex.exec(rawText)) !== null) {
    headerMatches.push({
      letter: hMatch[1],
      title: hMatch[2].trim(),
      startIndex: hMatch.index,
      headerLength: hMatch[0].length,
    });
  }

  for (let i = 0; i < headerMatches.length; i++) {
    const current = headerMatches[i];
    const next = headerMatches[i + 1];
    const contentStart = current.startIndex + current.headerLength;
    const contentEnd = next ? next.startIndex : rawText.length;
    const content = rawText.slice(contentStart, contentEnd).trim();

    sections[current.letter] = {
      title: current.title,
      content,
    };
  }

  return { sections, codeBlocks };
}

/**
 * Parse Architecture_View.md into `diagrams`.
 *
 * Each block is delimited by @startuml <Name> ... @enduml. The name is
 * the text after @startuml; the body is stored verbatim.
 */
function parseArchitectureView(rawText) {
  const diagrams = [];
  const plantUmlRegex = /@startuml\s+(\S+)[\s\S]*?@enduml/g;
  let match;
  while ((match = plantUmlRegex.exec(rawText)) !== null) {
    const name = match[1].trim();
    const plantuml = match[0].trim();
    diagrams.push({ name, plantuml });
  }
  return diagrams;
}

/**
 * Find the two required architecture inputs and the generated-project
 * directory in the working directory.
 */
function discoverInputFiles() {
  const docFile = 'Architecture_Documentation.md';
  const viewFile = 'Architecture_View.md';
  const missing = [];

  if (!fs.existsSync(path.join(WORKDIR, docFile))) missing.push(docFile);
  if (!fs.existsSync(path.join(WORKDIR, viewFile))) missing.push(viewFile);
  if (!fs.existsSync(PROJECT_DIR) || !fs.statSync(PROJECT_DIR).isDirectory()) {
    missing.push('Project/');
  }

  if (missing.length > 0) {
    throw new Error(
      `Required workspace items are missing: ${missing.join(', ')}. ` +
      'Place both architecture files and a Project folder beside agent.js.'
    );
  }

  return { docFile, viewFile };
}

/**
 * Build the final flat spec object: { sections, codeBlocks, diagrams }
 */
function buildStructuredSpec() {
  const { docFile, viewFile } = discoverInputFiles();

  console.log(`[scan] Using documentation file: ${docFile}`);
  console.log(`[scan] Using view file: ${viewFile}`);
  console.log(`[scan] Using project folder: ${path.relative(WORKDIR, PROJECT_DIR)}`);

  const docRaw = fs.readFileSync(path.join(WORKDIR, docFile), 'utf8');
  const viewRaw = fs.readFileSync(path.join(WORKDIR, viewFile), 'utf8');

  const { sections, codeBlocks } = parseArchitectureDocumentation(docRaw);
  const diagramsFromDoc = /@startuml/.test(docRaw)
    ? parseArchitectureView(docRaw)
    : [];
  const diagrams = [...parseArchitectureView(viewRaw), ...diagramsFromDoc];

  const spec = { sections, codeBlocks, diagrams };

  console.log(
    `[parse] Extracted ${Object.keys(sections).length} sections, ` +
    `${codeBlocks.length} code blocks, ${diagrams.length} diagrams.`
  );

  return spec;
}

// ====================================================================
// Build plan derivation + completion verification
//
// A checklist derived from the spec itself: the components it names and
// the deliverable filenames it lists. It is handed to the model up front
// and checked against the real filesystem before task_complete is
// honoured, so "done" is measured rather than claimed.
// ====================================================================

/**
 * Pull component names (e.g. "GameComponent") out of the spec by
 * scanning every section and diagram for the *Component / *Service
 * naming convention.
 */
function extractComponents(spec) {
  const names = new Set();
  const nameRegex = /\b([A-Z][A-Za-z0-9]*(?:Component|Service))\b/g;

  for (const letter of Object.keys(spec.sections)) {
    // Strip fenced code blocks first: a "service GameService" in the
    // .proto contract is an interface on a component, not a component
    // of its own, and would add a phantom entry that never ticks.
    const text = spec.sections[letter].content.replace(/```[\s\S]*?```/g, '');
    let m;
    while ((m = nameRegex.exec(text)) !== null) names.add(m[1]);
  }
  // Diagrams name participants/classes too; those confirm components
  // that the prose only mentions in passing.
  for (const d of spec.diagrams) {
    let m;
    while ((m = nameRegex.exec(d.plantuml)) !== null) names.add(m[1]);
  }

  return [...names].sort();
}

/**
 * Pull deliverable file paths out of the spec. The deliverables section
 * lists them inside a fenced block, one per line; we also accept any
 * path-looking token elsewhere in that section.
 */
function extractDeliverables(spec) {
  const files = new Set();
  const filePattern = /^[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,6}$/;

  // Prefer a section literally about deliverables; fall back to scanning
  // every markdown/text code block in the spec.
  const deliverableSections = Object.values(spec.sections).filter((s) =>
    /deliverable/i.test(s.title)
  );
  const haystacks = deliverableSections.length
    ? deliverableSections.map((s) => s.content)
    : spec.codeBlocks
      .filter((b) => b.lang === 'markdown' || b.lang === 'text')
      .map((b) => b.code);

  for (const text of haystacks) {
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim().replace(/^[-*]\s+/, '').replace(/^`|`$/g, '');
      if (filePattern.test(line)) files.add(line);
    }
  }

  return [...files].sort();
}

function deriveBuildPlan(spec) {
  const components = extractComponents(spec);
  const deliverables = extractDeliverables(spec);
  console.log(
    `[plan] Build plan: ${components.length} components ` +
    `(${components.join(', ') || 'none detected'}), ` +
    `${deliverables.length} named deliverables.`
  );
  return { components, deliverables };
}

/** Render the build plan as an explicit checklist for the model. */
function formatBuildPlan(plan) {
  const lines = ['BUILD PLAN — everything below must exist before you finish.', ''];

  lines.push('Components to implement (each in its own directory, with real logic):');
  if (plan.components.length === 0) {
    lines.push('  (none auto-detected — read the spec and decide for yourself)');
  } else {
    for (const c of plan.components) lines.push(`  [ ] ${c}`);
  }

  lines.push('', 'Deliverable files to produce (at these exact paths):');
  if (plan.deliverables.length === 0) {
    lines.push('  (none auto-detected — follow the spec)');
  } else {
    for (const f of plan.deliverables) lines.push(`  [ ] ${f}`);
  }

  lines.push(
    '',
    'Plus, always: a dependency file, a README.md, and tests that assert',
    'real behaviour. Work through this list file by file.'
  );
  return lines.join('\n');
}

/**
 * Walk the generated project directory, skipping usual dependency noise.
 * Returns paths relative to PROJECT_DIR.
 */
function listProjectFiles(dir = PROJECT_DIR, prefix = '') {
  const skipDirs = new Set(['node_modules', '.git', '__pycache__', 'venv', '.venv', 'dist']);
  const out = [];

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }

  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      out.push(...listProjectFiles(path.join(dir, entry.name), rel));
    } else {
      if (!prefix && entry.name.toLowerCase().endsWith('.docx')) continue;
      out.push(rel);
    }
  }
  return out;
}

/**
 * Check the build plan against the disk. Returns human-readable missing
 * items — empty means the run may finish. Deliverables match on basename
 * as well as full path, since the model may nest the project one level
 * deeper than the spec wrote it (src/openapi.yaml vs openapi.yaml).
 */
function verifyCompletion(plan) {
  const files = listProjectFiles();
  const lowerPaths = files.map((f) => f.toLowerCase());
  const basenames = new Set(lowerPaths.map((f) => f.split('/').pop()));
  const missing = [];

  for (const deliverable of plan.deliverables) {
    const wanted = deliverable.toLowerCase();
    const base = wanted.split('/').pop();
    const found =
      lowerPaths.some((p) => p === wanted || p.endsWith('/' + wanted)) ||
      basenames.has(base);
    if (!found) missing.push(`deliverable file not found: ${deliverable}`);
  }

  // A component counts as implemented if its name (or its bare stem —
  // "Game" from "GameComponent") shows up in a path, or if some source
  // file actually mentions it.
  for (const component of plan.components) {
    const lower = component.toLowerCase();
    const stem = lower.replace(/(component|service)$/, '');
    const inPath = lowerPaths.some((p) => p.includes(lower) || (stem && p.includes(stem)));
    if (inPath) continue;

    const mentioned = files.some((f) => {
      if (!/\.(js|ts|py|java|go|json|md|yaml|yml|sql)$/i.test(f)) return false;
      try {
        return fs
          .readFileSync(path.join(PROJECT_DIR, f), 'utf8')
          .toLowerCase()
          .includes(lower);
      } catch (e) {
        return false;
      }
    });
    if (!mentioned) missing.push(`component not implemented: ${component}`);
  }

  if (files.length === 0) missing.push('no files were written at all');

  return missing;
}

/**
 * A short status line appended to every tool result, so the model keeps
 * seeing what is still outstanding and how many turns it has left.
 */
function buildProgressReminder(plan, turn, bashLeft) {
  const missing = verifyCompletion(plan);
  const turnsLeft = MAX_TURNS - turn;

  const budgetLine =
    `[turn budget] Turn ${turn}/${MAX_TURNS} (${turnsLeft} left) — ` +
    (bashLeft > 0
      ? `run_bash: ${bashLeft} of ${RUN_BASH_BUDGET} call(s) left, usable ` +
      'on any turn. Otherwise keep writing files.'
      : `run_bash: budget exhausted (0 of ${RUN_BASH_BUDGET} left) — ` +
      'write_file only from here, then task_complete.');

  if (missing.length === 0) {
    return (
      `\n\n${budgetLine}\n[progress check] Build plan satisfied on disk. ` +
      (bashLeft > 0
        ? 'Install dependencies and run the tests with run_bash, then call ' +
        'task_complete.'
        : 'No run_bash calls remain — call task_complete.')
    );
  }
  return (
    `\n\n${budgetLine}\n[progress check] Still outstanding (${missing.length}):\n` +
    missing.map((m) => `  - ${m}`).join('\n') +
    '\nKeep going: write the next missing file now.'
  );
}

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
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content ?? '', 'utf8');
  const bytes = Buffer.byteLength(content ?? '', 'utf8');
  return `Wrote ${bytes} bytes to ${relPath}`;
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

/**
 * Pick the right shell for run_bash: Windows has no /bin/bash, so let
 * Node use the OS default (cmd.exe) there and bash everywhere else.
 */
function pickShellForPlatform() {
  if (process.platform === 'win32') {
    // Let Node use the OS default (cmd.exe) rather than hardcoding a
    // path that may not exist on every Windows machine.
    return true; // passing `shell: true` tells execSync to use the OS default shell
  }
  return '/bin/bash';
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
      shell: pickShellForPlatform(),
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
      'Overwrites the file if it already exists. Paths are relative to the ' +
      'Project folder inside the directory where agent.js is running.',
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
      'Defaults to the Project folder if no path is given.',
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
      'single call covers installation and verification together. ' +
      (process.platform === 'win32'
        ? 'IMPORTANT: this command runs on Windows via cmd.exe, not bash. ' +
        'Use Windows-compatible commands (e.g. "dir" not "ls", "type" not ' +
        '"cat", "&" or separate calls instead of Unix-only shell syntax). ' +
        'npm/node/python commands work the same as on other platforms. ' +
        'The command starts in the Project folder.'
        : 'This command runs via bash on a Unix-like system.'),
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
      'Call this ONLY when the project has been fully scaffolded, ' +
      'dependencies install cleanly, and tests pass (or you have clearly ' +
      'explained why a check could not be run in this environment). This ' +
      'ends the agent run. ' +
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
      '"## Running the tests", ' +
      '"## Key API endpoints", ' +
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
            'who has never seen this codebase. Must contain all nine ' +
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
    close() {
      rl.close();
    },
  };
}

/**
 * Asks user for provider choice, plan type (free/paid), the exact number
 * of API keys they want to enter (any positive integer), and collects keys sequentially.
 */
async function promptForProviderAndApiKey() {
  const prompter = createPrompter();

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

  prompter.close();

  if (apiKeys.length === 0) {
    throw new Error('No API keys provided.');
  }

  return { provider, apiKeys, model };
}

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

// ====================================================================
// API error helper + retry-with-backoff
//
// A 429 on a free tier means a request was rejected, not billed. Rather
// than crash the run we parse the provider's suggested delay and retry
// the same turn.
// ====================================================================

/**
 * Build an Error annotated with the HTTP status and, when the provider
 * says how long to wait (Gemini's RetryInfo, or a Retry-After header),
 * a retryDelaySeconds field.
 */
function buildApiError(providerLabel, status, statusText, rawBody, retryAfterHeader) {
  const err = new Error(
    `${providerLabel} API request failed (${status} ${statusText}): ${rawBody}`
  );
  err.status = status;

  // Try the Retry-After header first (seconds or HTTP-date).
  if (retryAfterHeader) {
    const asSeconds = Number(retryAfterHeader);
    if (!Number.isNaN(asSeconds)) {
      err.retryDelaySeconds = asSeconds;
    }
  }

  // Fall back to parsing a provider-specific retry hint out of the body.
  if (err.retryDelaySeconds === undefined) {
    // Gemini: { error: { details: [ { "@type": ".../RetryInfo", retryDelay: "56s" } ] } }
    const retryDelayMatch = rawBody.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
    if (retryDelayMatch) {
      err.retryDelaySeconds = parseFloat(retryDelayMatch[1]);
    }
  }

  return err;
}

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

// --------------------------------------------------------------------
// Anthropic (Claude) — Messages API
// --------------------------------------------------------------------

async function callAnthropic(apiKey, model, messages) {
  const response = await fetch(PROVIDERS['1'].apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: TOOL_DEFINITIONS.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      })),
      messages, // Anthropic's wire format already matches our unified shape
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw buildApiError(
      'Anthropic',
      response.status,
      response.statusText,
      errBody,
      response.headers.get('retry-after')
    );
  }

  const data = await response.json();
  return { content: data.content || [], stop_reason: data.stop_reason };
}

// --------------------------------------------------------------------
// OpenAI — Chat Completions API (tool calling)
// --------------------------------------------------------------------

function unifiedMessagesToOpenAI(messages) {
  const openaiMessages = [{ role: 'system', content: SYSTEM_PROMPT }];

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const textParts = msg.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      const toolCalls = msg.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
        }));

      const entry = { role: 'assistant', content: textParts || null };
      if (toolCalls.length > 0) entry.tool_calls = toolCalls;
      openaiMessages.push(entry);
    } else {
      // role === 'user' — may contain plain text (the initial brief)
      // or tool_result blocks (fed back after tool execution).
      const toolResults = msg.content.filter
        ? msg.content.filter((b) => b && b.type === 'tool_result')
        : [];

      if (typeof msg.content === 'string') {
        openaiMessages.push({ role: 'user', content: msg.content });
      } else if (toolResults.length > 0) {
        for (const tr of toolResults) {
          openaiMessages.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content:
              typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
          });
        }
      } else {
        // Fallback: array of text blocks
        const text = msg.content.map((b) => b.text || '').join('\n');
        openaiMessages.push({ role: 'user', content: text });
      }
    }
  }

  return openaiMessages;
}

function openAIToolsSchema() {
  return TOOL_DEFINITIONS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

async function callOpenAI(apiKey, model, messages) {
  const body = {
    model,
    max_tokens: MAX_TOKENS,
    messages: unifiedMessagesToOpenAI(messages),
    tools: openAIToolsSchema(),
  };

  const response = await fetch(PROVIDERS['2'].apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw buildApiError(
      'OpenAI',
      response.status,
      response.statusText,
      errBody,
      response.headers.get('retry-after')
    );
  }

  const data = await response.json();
  const choice = data.choices && data.choices[0];
  const message = choice ? choice.message : {};

  const content = [];
  if (message.content) {
    content.push({ type: 'text', text: message.content });
  }
  for (const call of message.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(call.function.arguments || '{}');
    } catch (e) {
      input = {};
    }
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input,
    });
  }

  const stop_reason =
    choice && choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn';

  return { content, stop_reason };
}

// --------------------------------------------------------------------
// Google Gemini — generateContent API (function calling)
// --------------------------------------------------------------------

function unifiedMessagesToGemini(messages) {
  const contents = [];

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const parts = [];
      for (const b of msg.content) {
        if (b.type === 'text' && b.text) {
          // Gemini 3 requires thought signatures echoed back verbatim.
          const part = { text: b.text };
          if (b.thoughtSignature) part.thoughtSignature = b.thoughtSignature;
          parts.push(part);
        } else if (b.type === 'tool_use') {
          // Without the original signature Gemini 3 returns 400.
          const part = { functionCall: { name: b.name, args: b.input || {} } };
          if (b.thoughtSignature) part.thoughtSignature = b.thoughtSignature;
          parts.push(part);
        }
      }
      contents.push({ role: 'model', parts });
    } else {
      // role === 'user'
      if (typeof msg.content === 'string') {
        contents.push({ role: 'user', parts: [{ text: msg.content }] });
      } else {
        const toolResults = msg.content.filter((b) => b.type === 'tool_result');
        if (toolResults.length > 0) {
          const parts = toolResults.map((tr) => ({
            functionResponse: {
              name: tr.name || 'tool_result',
              response: {
                content:
                  typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
              },
            },
          }));
          contents.push({ role: 'user', parts });
        } else {
          const text = msg.content.map((b) => b.text || '').join('\n');
          contents.push({ role: 'user', parts: [{ text }] });
        }
      }
    }
  }

  return contents;
}

function geminiToolsSchema() {
  // Gemini's parameter schema is JSON-schema-like but does not accept
  // some fields (like additionalProperties). Strip to a safe subset.
  const stripSchema = (schema) => ({
    type: schema.type,
    properties: schema.properties,
    required: schema.required,
  });

  return [
    {
      functionDeclarations: TOOL_DEFINITIONS.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: stripSchema(t.input_schema),
      })),
    },
  ];
}

async function callGemini(apiKey, model, messages) {
  const url = `${PROVIDERS['3'].apiUrl}/${model}:generateContent?key=${apiKey}`;

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    // functionResponse blocks are keyed by tool *name* (Gemini has no
    // call-id concept), which relies on tool_result blocks carrying
    // `name` — set for every tool_result pushed in the main loop.
    contents: unifiedMessagesToGemini(messages),
    tools: geminiToolsSchema(),
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw buildApiError(
      'Gemini',
      response.status,
      response.statusText,
      errBody,
      response.headers.get('retry-after')
    );
  }

  const data = await response.json();
  const candidate = data.candidates && data.candidates[0];
  const parts = (candidate && candidate.content && candidate.content.parts) || [];

  const content = [];
  let callIndex = 0;
  for (const part of parts) {
    if (part.text) {
      const block = { type: 'text', text: part.text };
      // Preserved verbatim so it can be echoed back next turn.
      if (part.thoughtSignature) block.thoughtSignature = part.thoughtSignature;
      content.push(block);
    } else if (part.functionCall) {
      callIndex += 1;
      const block = {
        type: 'tool_use',
        // Gemini doesn't hand back call ids, so we mint one that
        // encodes the tool name — later used to route functionResponse
        // back by name.
        id: `gemini-call-${Date.now()}-${callIndex}`,
        name: part.functionCall.name,
        input: part.functionCall.args || {},
      };
      // On parallel calls only the FIRST functionCall part carries a
      // signature; store whatever came back and echo it next turn.
      if (part.thoughtSignature) block.thoughtSignature = part.thoughtSignature;
      content.push(block);
    }
  }

  const hasToolCalls = content.some((b) => b.type === 'tool_use');
  const stop_reason = hasToolCalls ? 'tool_use' : 'end_turn';

  return { content, stop_reason };
}

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

// ====================================================================
// Main agent loop
// ====================================================================

async function main() {
  console.log('=== Simple Code Agent (agent.js) ===\n');

  let spec;
  try {
    spec = buildStructuredSpec();
  } catch (err) {
    console.error(`\n[fatal] ${err.message}`);
    process.exit(1);
  }

  const buildPlan = deriveBuildPlan(spec);

  let provider, apiKeys, model;
  try {
    ({ provider, apiKeys, model } = await promptForProviderAndApiKey());
  } catch (err) {
    console.error(`\n[fatal] ${err.message}`);
    process.exit(1);
  }

  console.log(`\n[agent] Using provider: ${provider.label} (model: ${model})`);
  console.log(`[agent] Loaded ${apiKeys.length} API key(s) for rotation.`);

  const initialUserMessage = {
    role: 'user',
    content:
      'Here is the architecture specification, as structured JSON ' +
      '(sections, codeBlocks, diagrams). Scaffold a complete project on ' +
      'disk that implements it, using your tools.\n\n' +
      '```json\n' +
      JSON.stringify(spec, null, 2) +
      '\n```\n\n' +
      formatBuildPlan(buildPlan) +
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
  let completionSummary = ''; // populated by task_complete, printed in the final report

  while (turn < MAX_TURNS && !completed) {
    turn += 1;

    // --- KEY ROTATION & PAUSE LOGIC ---
    if (apiKeys.length > 0) {
      if (turn > 1 && (turn - 1) % TURNS_PER_KEY === 0) {
        const nextIndex = (activeKeyIndex + 1) % apiKeys.length;

        console.log(`\n================================================================`);
        console.log(`[rotation] Reached ${TURNS_PER_KEY} turns on Key #${activeKeyIndex + 1}.`);

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
      last.content += buildProgressReminder(
        buildPlan,
        turn,
        RUN_BASH_BUDGET - runBashUsed
      );
    }

    messages.push({ role: 'user', content: toolResultBlocks });
  }

  // Final report: what actually landed on disk, measured — not what the
  // model claimed in its summary.
  const remaining = verifyCompletion(buildPlan);
  const written = listProjectFiles();

  console.log('\n=== Run report ===');
  console.log(`Turns used: ${turn}/${MAX_TURNS}`);
  console.log(`Files in project: ${written.length}`);
  console.log(
    `Build plan: ${buildPlan.components.length} components, ` +
    `${buildPlan.deliverables.length} deliverables`
  );

  if (remaining.length === 0) {
    console.log('Build plan: SATISFIED — every planned artifact exists.');
  } else {
    console.log(`Build plan: INCOMPLETE — ${remaining.length} item(s) missing:`);
    for (const m of remaining) console.log(`  - ${m}`);
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
      'Re-run to continue: the agent will see the existing files and ' +
      'fill in what the report above lists as missing.'
    );
  }
}

main().catch((err) => {
  console.error(`\n[fatal] Unhandled error: ${err.stack || err.message}`);
  process.exit(1);
});
