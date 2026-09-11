#!/usr/bin/env node
/**
 * agent.js — entry point
 * ------------------------------------------------------------------
 * A Simple Code Agent (Node.js, Terminal-Based)
 *
 * No package.json, no dependencies, no SDK. Uses Node's built-in fetch
 * (Node 18+) to call Anthropic, OpenAI or Gemini directly; the user
 * picks one from a menu at startup.
 *
 * It scans its own directory for markdown architecture inputs — any
 * filenames, any heading style, PlantUML or Mermaid diagrams — parses
 * them into one flat JSON spec { sections, codeBlocks, diagrams },
 * derives a build plan from it, and hands the model a set of tools to
 * scaffold the project. Nothing is specific to one project: the
 * components, deliverables, use cases and end-user surface all come out
 * of whatever documents are present, and the LLM decides the whole
 * output structure. task_complete is verified against the filesystem,
 * so the run cannot end while the plan is unmet — and the generated
 * project is then installed, booted and probed over HTTP, so "it works"
 * is measured rather than claimed.
 *
 * Runs are resumable. Before the first API call it scans the Project
 * folder and, if anything is already there, hands the model the existing
 * file tree, sizes, key manifests and a per-item build-plan status, so a
 * second run continues the same project instead of rewriting it.
 *
 * Where the code lives:
 *   lib/config.js         every constant and budget in one place
 *   lib/prompt.js         the system prompt
 *   lib/spec/parse.js     markdown + UML  ->  structured JSON spec
 *   lib/plan/derive.js    spec            ->  build plan
 *   lib/plan/verify.js    build plan      ->  what is missing on disk
 *   lib/project/scan.js   existing Project folder  ->  resume context
 *   lib/tools/            the tools handed to the model
 *   lib/providers/        Anthropic / OpenAI / Gemini wire formats
 *   lib/runner/smoke.js   installs, boots and probes the built project
 *   lib/agent/main.js     the turn loop
 *
 * Usage:
 *   1. Copy agent.js (with its lib/ folder) into a folder containing
 *      your architecture document(s) as markdown — one file or several,
 *      named whatever you like. A Project folder is created if missing.
 *   2. Open a terminal in that folder
 *   3. Run: node agent.js
 *   4. Pick a provider and paste its key when prompted.
 * ------------------------------------------------------------------
 */
'use strict';

const { main } = require('./lib/agent/main');

main().catch((err) => {
  console.error(`\n[fatal] Unhandled error: ${err.stack || err.message}`);
  process.exit(1);
});
