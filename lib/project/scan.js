'use strict';

const fs = require('fs');
const path = require('path');

const {
  PROJECT_DIR,
  MAX_LINE_COUNT_BYTES,
  MAX_MANIFEST_CHARS,
  MAX_TREE_LINES,
  MANIFEST_FILENAMES,
} = require('../config');
const { formatBytes } = require('../util');
const { listProjectFiles, checkPlan, verifyCompletion } = require('../plan/verify');

// ====================================================================
// Existing-project scan (resume support)
//
// The Project folder is read from disk before the first API call. If an
// earlier run already wrote files, the model is handed the real tree, the
// size of every file and the contents of the key manifests, so it
// continues that project instead of scaffolding a second one on top of it.
// ====================================================================

/** listProjectFiles(), plus the size and line count of every file. */
function statProjectFiles() {
  return listProjectFiles().map((rel) => {
    let bytes = 0;
    let lines = 0;
    try {
      const buf = fs.readFileSync(path.join(PROJECT_DIR, rel));
      bytes = buf.length;
      if (bytes <= MAX_LINE_COUNT_BYTES) {
        lines = buf.toString('utf8').split(/\r?\n/).length;
      }
    } catch (e) {
      // Unreadable file: still list it, just without measurements.
    }
    return { rel, bytes, lines };
  });
}

/**
 * Render the scanned files as an indented directory tree, so the model
 * sees the layout it must extend rather than a flat list of paths.
 */
function renderProjectTree(entries) {
  const root = { dirs: new Map(), files: [] };

  for (const entry of entries) {
    const parts = entry.rel.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) {
        node.dirs.set(parts[i], { dirs: new Map(), files: [] });
      }
      node = node.dirs.get(parts[i]);
    }
    node.files.push({ ...entry, name: parts[parts.length - 1] });
  }

  const lines = ['Project/'];

  const walk = (node, indent) => {
    for (const name of [...node.dirs.keys()].sort()) {
      lines.push(`${indent}${name}/`);
      walk(node.dirs.get(name), indent + '  ');
    }
    for (const file of node.files.sort((a, b) => a.name.localeCompare(b.name))) {
      const size = formatBytes(file.bytes);
      const count = file.lines ? `, ${file.lines} lines` : '';
      lines.push(`${indent}${file.name}  (${size}${count})`);
    }
  };

  walk(root, '  ');
  return lines;
}

/**
 * Read the manifest-style files that pin down the stack the existing
 * project already committed to (dependencies, env vars, API contract).
 */
function collectManifestExcerpts(entries) {
  const excerpts = [];
  for (const entry of entries) {
    const base = entry.rel.split('/').pop().toLowerCase();
    if (!MANIFEST_FILENAMES.has(base)) continue;

    let text;
    try {
      text = fs.readFileSync(path.join(PROJECT_DIR, entry.rel), 'utf8');
    } catch (e) {
      continue;
    }

    const truncated = text.length > MAX_MANIFEST_CHARS;
    excerpts.push({
      rel: entry.rel,
      content: truncated ? text.slice(0, MAX_MANIFEST_CHARS) : text,
      truncated,
    });
  }
  return excerpts;
}

/** Scan the Project folder and describe whatever is already there. */
function scanExistingProject() {
  const entries = statProjectFiles();

  const dirs = new Set();
  for (const entry of entries) {
    const parts = entry.rel.split('/');
    parts.pop();
    let prefix = '';
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      dirs.add(prefix);
    }
  }

  return {
    entries,
    isEmpty: entries.length === 0,
    fileCount: entries.length,
    dirCount: dirs.size,
    totalBytes: entries.reduce((sum, e) => sum + e.bytes, 0),
    treeLines: renderProjectTree(entries),
    manifests: collectManifestExcerpts(entries),
  };
}

/**
 * The EXISTING PROJECT STATE block handed to the model in the very first
 * user message: the tree on disk, the manifests already written, and
 * which build-plan items that disk already satisfies.
 */
function formatExistingProjectState(scan, plan) {
  if (scan.isEmpty) {
    return [
      'EXISTING PROJECT STATE — the Project folder is EMPTY.',
      '',
      'Nothing has been built yet, so this is a fresh start: choose the',
      'structure yourself and begin with the first item of the build plan.',
    ].join('\n');
  }

  const status = checkPlan(plan);
  const lines = [
    'EXISTING PROJECT STATE — the Project folder ALREADY CONTAINS ' +
    `${scan.fileCount} file(s) in ${scan.dirCount} director(ies) ` +
    `(${formatBytes(scan.totalBytes)} total).`,
    '',
    'THIS RUN IS A CONTINUATION, NOT A FRESH START. The files below were',
    'written by an earlier run of this agent (or by the user). Do NOT',
    're-scaffold the project, do NOT rewrite these files, and do NOT switch',
    'to a different layout, framework or naming convention. Adopt what is',
    'on disk and extend it.',
    '',
    'Current file and folder structure (sizes measured just now):',
    '',
  ];

  const tree = scan.treeLines;
  lines.push(...tree.slice(0, MAX_TREE_LINES));
  if (tree.length > MAX_TREE_LINES) {
    lines.push(
      `  ... [${tree.length - MAX_TREE_LINES} more entries not listed — ` +
      'use list_dir to see them]'
    );
  }

  if (scan.manifests.length > 0) {
    lines.push('', 'Manifests and contracts already on disk:');
    for (const manifest of scan.manifests) {
      lines.push('', `--- ${manifest.rel} ---`, manifest.content.trimEnd());
      if (manifest.truncated) lines.push('... [truncated]');
    }
    lines.push(
      '',
      'Reuse these: the same dependencies and versions, the same env',
      'variable names, the same scripts. Extend them rather than replacing',
      'them.'
    );
  }

  const done = [
    ...status.componentsFound.map((c) => `component implemented: ${c}`),
    ...status.deliverablesFound.map((d) => `deliverable present: ${d}`),
  ];
  const outstanding = verifyCompletion(plan);

  lines.push('', 'Build-plan items ALREADY SATISFIED on disk — do not redo these:');
  if (done.length === 0) {
    lines.push('  (none yet)');
  } else {
    for (const item of done) lines.push(`  [x] ${item}`);
  }

  const backendDone =
    status.deliverablesMissing.length === 0 && status.componentsMissing.length === 0;
  const uiOutstanding = status.uiMissing.length > 0 || status.useCasesMissing.length > 0;

  if (backendDone && uiOutstanding) {
    lines.push(
      '',
      `*** THE SERVICES ARE BUILT, THE ${plan.ui.label.toUpperCase()} IS NOT. ***`,
      'The previous run stopped after the backend. The user-facing half is',
      'your entire job this run: the entry point, a screen (or command) for',
      'every use case, the styling, and the calls that connect them to the',
      'endpoints that already exist. Do not re-touch the backend, do not',
      'rewrite the README, and do not call task_complete until a real user',
      'can open this and complete every use case.'
    );
  }

  lines.push('', 'Build-plan items STILL OUTSTANDING — this is your work for this run:');
  if (outstanding.length === 0) {
    lines.push(
      '  (none — every planned artifact exists. Read the existing files for',
      '   stubs or gaps, fix what is incomplete, verify with run_bash, then',
      '   call task_complete.)'
    );
  } else {
    for (const item of outstanding) lines.push(`  [ ] ${item}`);
  }

  lines.push(
    '',
    'How to work from here:',
    '  1. Start from the outstanding list above, not from file #1 of the',
    '     project.',
    '  2. read_file any existing file you must integrate with (imports,',
    '     exports, function signatures, route paths, table names) so the',
    '     new code actually fits the code that is already there.',
    '  3. Overwrite an existing file only when it is a stub, is wrong, or',
    '     must change to wire in the new work — and then rewrite it in',
    '     full, keeping the behaviour that already worked.',
    '  4. When nothing is outstanding, verify and call task_complete.'
  );

  return lines.join('\n');
}

module.exports = {
  scanExistingProject,
  formatExistingProjectState,
  statProjectFiles,
  renderProjectTree,
  collectManifestExcerpts,
};
