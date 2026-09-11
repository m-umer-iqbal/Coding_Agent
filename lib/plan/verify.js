'use strict';

const fs = require('fs');
const path = require('path');

const {
  PROJECT_DIR,
  TEXT_FILE_EXT,
  MAX_SCAN_FILE_BYTES,
  SURFACE_KINDS,
  UI_DIR,
  SERVER_SIGNATURE,
  MAX_TURNS,
  RUN_BASH_BUDGET,
} = require('../config');
const { isNameCovered } = require('./names');
const { analyseFrontend } = require('./frontend');

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
 * Check the build plan against the disk, item by item. Deliverables match
 * on basename as well as full path, since the model may nest the project
 * one level deeper than the spec wrote it (src/openapi.yaml vs
 * openapi.yaml). A component counts as implemented if its name (or its
 * bare stem — "Game" from "GameComponent") shows up in a path, or if some
 * source file actually mentions it.
 *
 * Both sides of the ledger are returned: what already exists is what a
 * resumed run must NOT redo; what is missing is what it still owes.
 */
/**
 * Read every text file in the project once, lowercased and prefixed with
 * its own path, so coverage checks can search names across the whole
 * codebase without re-reading the disk per question.
 */
function readProjectTexts(files) {
  const texts = new Map();
  for (const rel of files) {
    if (!TEXT_FILE_EXT.test(rel)) continue;
    try {
      const full = path.join(PROJECT_DIR, rel);
      if (fs.statSync(full).size > MAX_SCAN_FILE_BYTES) continue;
      texts.set(rel, `${rel}\n${fs.readFileSync(full, 'utf8')}`.toLowerCase());
    } catch (e) {
      // Unreadable file: it simply contributes nothing to coverage.
    }
  }
  return texts;
}

/**
 * Decide whether the end-user surface the spec calls for actually exists,
 * or whether the run produced services nobody can reach.
 *
 * The rules come from the surface kind detected in the spec — web UI,
 * mobile app, desktop app or CLI — so this asks the right question for
 * the system at hand instead of always looking for HTML. Four things
 * must hold: the surface exists, it is more than a stub, it has an entry
 * point, and it is genuinely wired to the rest of the system.
 */
function checkUserSurface(plan, files, texts, options = {}) {
  const spec = plan.ui;
  const kind = SURFACE_KINDS.find((k) => k.id === spec.kind);
  if (!kind) return { missing: [], uiFiles: [] };

  // A server file that happens to live in a UI-ish directory is not part
  // of the interface — checking its text keeps the two sides separate.
  const isServerFile = (rel) => SERVER_SIGNATURE.test(texts.get(rel) || '');

  const primaryFiles = files.filter((f) => kind.primary.test(f) && !isServerFile(f));
  const supportingFiles = files.filter(
    (f) =>
      !kind.primary.test(f) &&
      kind.supporting.test(f) &&
      UI_DIR.test(f) &&
      !isServerFile(f)
  );
  const uiFiles = [...primaryFiles, ...supportingFiles];
  const missing = [];

  if (primaryFiles.length === 0) {
    missing.push(
      `NO ${kind.label.toUpperCase()} EXISTS — the project contains no ` +
      `${kind.primaryDesc} file at all. The spec describes a ` +
      `${kind.label} and it has not been built. Build it now: ` +
      `${kind.checklist[0]}, then ${kind.checklist[1]}.`
    );
    return { missing, uiFiles };
  }

  let uiBytes = 0;
  for (const rel of uiFiles) {
    try {
      uiBytes += fs.statSync(path.join(PROJECT_DIR, rel)).size;
    } catch (e) {
      // Counted as zero.
    }
  }

  if (uiFiles.length < kind.minFiles || uiBytes < kind.minBytes) {
    missing.push(
      `the ${kind.label} is only a placeholder (${uiFiles.length} file(s), ` +
      `${uiBytes} bytes) — build the real screens/commands the spec describes`
    );
  }

  if (!primaryFiles.some((f) => kind.entry.test(f))) {
    missing.push(`no ${kind.label} entry point (${kind.entryDesc})`);
  }

  const uiText = uiFiles.map((f) => texts.get(f) || '').join('\n');
  if (!kind.wiring.test(uiText)) {
    missing.push(`the ${kind.label} never ${kind.wiringDesc}`);
  }

  // A page that exists is not a frontend. Check that it is a real project
  // (split into files), that everything it loads exists, and that every
  // API path it calls is actually served.
  let review = null;
  if (kind.id === 'web' || kind.id === 'desktop') {
    review = analyseFrontend(uiFiles, files, plan);
    missing.push(...review.findings);
  }

  return { missing, uiFiles, review };
}

/**
 * Check the build plan against the disk, item by item: deliverables,
 * components, use cases, and the user interface.
 *
 * Deliverables match on basename as well as full path, since the model
 * may nest the project one level deeper than the spec wrote it
 * (src/openapi.yaml vs openapi.yaml). A component counts as implemented
 * if its name (or its bare stem — "Game" from "GameComponent") shows up
 * in a path, or if some source file actually mentions it.
 *
 * Both sides of the ledger are returned: what already exists is what a
 * resumed run must NOT redo; what is missing is what it still owes.
 */
function checkPlan(plan) {
  const files = listProjectFiles();
  const texts = readProjectTexts(files);
  const lowerPaths = files.map((f) => f.toLowerCase());
  const basenames = new Set(lowerPaths.map((f) => f.split('/').pop()));

  const deliverablesFound = [];
  const deliverablesMissing = [];
  const componentsFound = [];
  const componentsMissing = [];
  const useCasesFound = [];
  const useCasesMissing = [];

  for (const deliverable of plan.deliverables) {
    const wanted = deliverable.toLowerCase();
    const base = wanted.split('/').pop();
    const found =
      lowerPaths.some((p) => p === wanted || p.endsWith('/' + wanted)) ||
      basenames.has(base);
    (found ? deliverablesFound : deliverablesMissing).push(deliverable);
  }

  for (const component of plan.components) {
    const covered = isNameCovered(component, texts, lowerPaths);
    (covered ? componentsFound : componentsMissing).push(component);
  }

  for (const useCase of plan.useCases || []) {
    const covered = isNameCovered(useCase, texts, lowerPaths);
    (covered ? useCasesFound : useCasesMissing).push(useCase);
  }

  const ui =
    plan.ui && plan.ui.required
      ? checkUserSurface(plan, files, texts)
      : { missing: [], uiFiles: [] };

  return {
    files,
    uiReview: ui.review || null,
    deliverablesFound,
    deliverablesMissing,
    componentsFound,
    componentsMissing,
    useCasesFound,
    useCasesMissing,
    uiFiles: ui.uiFiles,
    uiMissing: ui.missing,
    // Lets the wording of a missing use case match the system being built:
    // a CLI has commands, a library has neither screens nor commands.
    surfaceLabel: plan.ui && plan.ui.required ? plan.ui.label : null,
  };
}

/**
 * Human-readable list of what the build plan still owes the disk — empty
 * means the run may finish.
 */
function missingFromStatus(status) {
  const missing = [
    ...status.deliverablesMissing.map((d) => `deliverable file not found: ${d}`),
    ...status.componentsMissing.map((c) => `component not implemented: ${c}`),
    ...status.useCasesMissing.map((u) =>
      status.surfaceLabel
        ? `use case not implemented end to end (services + ${status.surfaceLabel}): ${u}`
        : `use case not implemented: ${u}`
    ),
    ...status.uiMissing.map((m) => `user interface: ${m}`),
  ];

  if (status.files.length === 0) missing.push('no files were written at all');

  return missing;
}

function verifyCompletion(plan) {
  return missingFromStatus(checkPlan(plan));
}
/**
 * A short status line appended to every tool result, so the model keeps
 * seeing what is still outstanding and how many turns it has left.
 */
function buildProgressReminder(plan, turn, bashLeft) {
  const status = checkPlan(plan);
  const missing = missingFromStatus(status);
  const turnsLeft = MAX_TURNS - turn;

  // The failure this guards against: a run that builds the services,
  // adds a README and declares victory with no UI on disk.
  const uiGap =
    status.uiMissing.length > 0 || status.useCasesMissing.length > 0
      ? `\n[END-USER SURFACE MISSING] The build plan requires a working ` +
      `${plan.ui.label} and it is not on disk yet. Do NOT call ` +
      'task_complete, and do NOT spend turns polishing the backend or ' +
      'the README. Build it now: the entry point, one screen or command ' +
      'per use case, and the calls that connect them to your services.'
      : '';

  const budgetLine =
    `[turn budget] Turn ${turn}/${MAX_TURNS} (${turnsLeft} left) — ` +
    (bashLeft > 0
      ? `run_bash: ${bashLeft} of ${RUN_BASH_BUDGET} call(s) left, usable ` +
      'on any turn. Otherwise keep writing files.'
      : `run_bash: budget exhausted (0 of ${RUN_BASH_BUDGET} left) — ` +
      'write_file only from here, then task_complete.');

  if (missing.length === 0) {
    return (
      `\n\n${budgetLine}\n[progress check] Build plan satisfied on disk ` +
      '(components, deliverables, use cases and end-user surface). ' +
      (bashLeft > 0
        ? 'Install dependencies and run the tests with run_bash, then call ' +
        'task_complete.'
        : 'No run_bash calls remain — call task_complete.')
    );
  }
  return (
    `\n\n${budgetLine}\n[progress check] Still outstanding (${missing.length}):\n` +
    missing.map((m) => `  - ${m}`).join('\n') +
    uiGap +
    '\nKeep going: write the next missing file now.'
  );
}

module.exports = {
  listProjectFiles,
  readProjectTexts,
  checkUserSurface,
  checkPlan,
  missingFromStatus,
  verifyCompletion,
  buildProgressReminder,
};
