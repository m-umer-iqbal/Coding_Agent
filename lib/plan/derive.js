'use strict';

const {
  DESKTOP_SHELL_REQUIRED,
  DESKTOP_SHELL_ENTRY,
  DESKTOP_SHELL_SCRIPT,
  MAX_PLAN_COMPONENTS,
  MAX_PLAN_DELIVERABLES,
  MAX_PLAN_USE_CASES,
  ROLE_SUFFIXES,
  LAYER_SUFFIXES,
  LOGICAL_SUFFIXES,
  GENERIC_NAMES,
  NON_COMPONENT_WORDS,
  QUALITY_WORDS,
  KNOWN_FILE_EXT,
  NAMED_FILES,
  SURFACE_KINDS,
} = require('../config');
const { nameWords } = require('./names');

// ====================================================================
// Build plan derivation + completion verification
//
// A checklist derived from the spec itself: the components it names and
// the deliverable filenames it lists. It is handed to the model up front
// and checked against the real filesystem before task_complete is
// honoured, so "done" is measured rather than claimed.
// ====================================================================

/** Every scrap of prose in the spec, as one lowercase-able string. */
function specProse(spec) {
  return Object.values(spec.sections)
    .map((section) => `${section.title}\n${section.content}`)
    .join('\n');
}

/** Every diagram body in the spec, as one string. */
function specDiagramText(spec) {
  return spec.diagrams.map((d) => d.content).join('\n');
}
/**
 * Pull the system's components out of the spec, without assuming any
 * naming convention.
 *
 * Three independent sources, strongest first:
 *   1. Structural diagram nodes — component, deployment, container and
 *      package diagrams in PlantUML or Mermaid. When a spec draws its
 *      components, that drawing is the answer.
 *   2. Names carrying an architectural role word (…Service, …Module,
 *      …Gateway, …Worker, …), wherever they appear in the prose.
 *   3. Bullet or table entries in a section about components/modules,
 *      written as "Name: responsibility" or "**Name** — responsibility".
 */
function extractComponents(spec) {
  const found = new Map(); // lowercase key -> display name

  const add = (raw) => {
    if (!raw) return;
    const name = String(raw).trim().replace(/^["'<[({]+|["'>\])}]+$/g, '').trim();
    if (!name || name.length > 60) return;
    if (!/[A-Za-z]/.test(name)) return;
    const words = nameWords(name);
    if (words.length === 0 || words.length > 5) return;
    if (GENERIC_NAMES.has(words.join(' '))) return;
    if (words.some((w) => NON_COMPONENT_WORDS.has(w))) return;
    const key = words.join(' ');
    if (!found.has(key)) found.set(key, name);
  };

  // --- 1. Structural diagram nodes -----------------------------------
  const structuralKeyword =
    /^[ \t]*(?:component|artifact|node|package|rectangle|database|queue|folder|cloud|frame|storage|card|subgraph|container|system|system_boundary|container_boundary)\b[ \t]+(?:"([^"]+)"|<[^>]*>[ \t]*)?([A-Za-z_][\w]*)?/gim;
  // PlantUML shorthand for a component: [Order Service]
  const bracketComponent = /^[ \t]*\[([A-Za-z][^\]\n]{1,58})\][ \t]*(?:as[ \t]+\w+)?[ \t]*$/gim;
  // C4-PlantUML / mermaid: Container(api, "Order API", ...)  |  A[Order API]
  const c4Node = /\b(?:Container|Component|System|ContainerDb|ComponentDb)\s*\(\s*[\w]+\s*,\s*"([^"]+)"/g;
  const mermaidNode = /\b[A-Za-z_][\w]*\s*[[({]{1,2}\s*"?([A-Za-z][^"\])}\n|]{1,58})"?\s*[\])}]{1,2}/g;

  for (const diagram of spec.diagrams) {
    const body = diagram.content;
    const isStructural =
      /\b(component|deployment|container|package|artifact|node|cloud|subgraph|C4)\b/i.test(
        `${diagram.name}\n${body}`
      );

    let m;
    while ((m = structuralKeyword.exec(body)) !== null) add(m[1] || m[2]);
    while ((m = bracketComponent.exec(body)) !== null) add(m[1]);
    while ((m = c4Node.exec(body)) !== null) add(m[1]);
    if (isStructural && diagram.notation === 'mermaid') {
      while ((m = mermaidNode.exec(body)) !== null) add(m[1]);
    }
  }

  // --- 2. Role-suffixed names in the prose ---------------------------
  const roleAlternatives = [...ROLE_SUFFIXES]
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('|');
  const roleRegex = new RegExp(
    `\\b([A-Z][A-Za-z0-9]*(?:${roleAlternatives}))\\b`,
    'g'
  );
  for (const section of Object.values(spec.sections)) {
    // Strip fenced code: "service OrderService" inside a .proto contract
    // is an interface on a component, not a component of its own.
    const text = section.content.replace(/```[\s\S]*?```/g, '');
    let m;
    while ((m = roleRegex.exec(text)) !== null) add(m[1]);
  }

  // --- 3. Bullet / table entries in a components-ish section ---------
  for (const text of componentListingBlocks(spec)) {
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      // * **Name** — responsibility   |   * Name: responsibility
      const bullet = line.match(
        /^[-*+][ \t]+\**\s*([A-Z][A-Za-z0-9 _/-]{2,58}?)\s*\**\s*[:—–-]\s+\S/
      );
      if (bullet) add(bullet[1]);
      // | Name | responsibility | ... (first cell of a markdown table)
      const cell = line.match(/^\|\s*\**\s*([A-Z][A-Za-z0-9 _/-]{2,58}?)\s*\**\s*\|/);
      if (cell && !/^-+$/.test(cell[1])) add(cell[1]);
    }
  }

  // Actors are people, not components; use-case names are features.
  for (const actor of extractActors(spec)) found.delete(nameWords(actor).join(' '));

  const components = collapseLayerDuplicates(found).sort();
  return components.length > MAX_PLAN_COMPONENTS
    ? components.slice(0, MAX_PLAN_COMPONENTS)
    : components;
}

/**
 * Most specs draw the same component three times: once logically
 * (GameComponent), once as a running process (GameServer) and once as a
 * deployable (GameContainer) — plus a bare "Game" in a class or package
 * diagram. They are one thing to build, so keep the logical name and
 * fold the rest into it.
 */
function collapseLayerDuplicates(found) {
  const coreOf = (key) => {
    const words = key.split(' ');
    return words.length > 1 && ROLE_SUFFIXES.has(words[words.length - 1])
      ? words.slice(0, -1).join(' ')
      : key;
  };
  const suffixOf = (key) => key.split(' ').pop();

  const groups = new Map();
  for (const key of found.keys()) {
    const core = coreOf(key);
    if (!groups.has(core)) groups.set(core, []);
    groups.get(core).push(key);
  }

  const kept = [];
  for (const keys of groups.values()) {
    const logical = keys.filter((k) => LOGICAL_SUFFIXES.has(suffixOf(k)));
    if (logical.length > 0) {
      // Every distinct logical thing survives; layers and bare stems drop.
      for (const key of logical) kept.push(found.get(key));
      continue;
    }
    // No logical name in this group: keep the most specific single name.
    const ranked = keys
      .slice()
      .sort((a, b) => {
        const rank = (k) =>
          LAYER_SUFFIXES.has(suffixOf(k)) ? 2 : k.includes(' ') ? 0 : 1;
        return rank(a) - rank(b) || a.length - b.length;
      });
    kept.push(found.get(ranked[0]));
  }

  return kept;
}

/**
 * The stretches of the documents where a component list plausibly lives.
 *
 * A section's own heading may say "Components", but just as often the
 * list sits under a sub-heading ("## Parts", "### Building blocks") of a
 * broader section, so every heading level is considered. Headings about
 * design options are deliberately excluded: their bullets list technology
 * choices, not components.
 */
function componentListingBlocks(spec) {
  const wanted = /component|module|service|subsystem|overview|architecture|building block|part|piece|element|structure|package|layer|responsibilit|inventory/i;
  // Sections about process, quality or paperwork list rows that look like
  // components but are not — test types, risks, requirement ids, metrics.
  const unwanted = /test|matrix|traceab|risk|migration|rollout|trade[- ]?off|open question|assumption|glossary|runbook|slo\b|sla\b|metric|observab|monitoring|operations|review|threat|secret/i;
  const blocks = [];

  for (const section of Object.values(spec.sections)) {
    const body = section.content.replace(/```[\s\S]*?```/g, '');
    const headingRegex = /^#{1,6}[ \t]+(.+)$/gm;

    const marks = [];
    let m;
    while ((m = headingRegex.exec(body)) !== null) {
      marks.push({ title: m[1].trim(), start: m.index, end: m.index + m[0].length });
    }

    const sectionOk = wanted.test(section.title) && !unwanted.test(section.title);

    // Text before the first sub-heading belongs to the section itself.
    const lead = marks.length > 0 ? body.slice(0, marks[0].start) : body;
    if (sectionOk) blocks.push(lead);

    for (let i = 0; i < marks.length; i++) {
      const title = marks[i].title;
      if (unwanted.test(title)) continue;
      const chunk = body.slice(marks[i].end, marks[i + 1] ? marks[i + 1].start : body.length);
      if (wanted.test(title) || sectionOk) blocks.push(chunk);
    }
  }

  return blocks;
}

/**
 * Pull deliverable file paths out of the spec: a deliverables section if
 * there is one, otherwise any path-shaped token in a list, an inline
 * code span, or a plain-text code block anywhere in the documents.
 */
function extractDeliverables(spec) {
  const files = new Set();

  const looksLikeFile = (token) => {
    const value = token.trim();
    if (!value || value.length > 120 || /\s/.test(value)) return false;
    if (/^https?:/i.test(value)) return false;
    if (NAMED_FILES.has(value.split('/').pop().toLowerCase())) return true;
    const ext = value.split('.').pop().toLowerCase();
    if (!KNOWN_FILE_EXT.has(ext)) return false;
    return /^[A-Za-z0-9_.\/-]+$/.test(value) && /[A-Za-z]/.test(value.split('/').pop());
  };

  const harvest = (text) => {
    for (const rawLine of String(text).split(/\r?\n/)) {
      const line = rawLine.trim().replace(/^[-*+]\s+/, '');
      // A bare path on its own line, or one wrapped in backticks.
      const bare = line.replace(/^`|`$/g, '').replace(/[,;]$/, '');
      if (looksLikeFile(bare)) files.add(bare);
      // Inline code spans anywhere in the line.
      const spans = line.match(/`([^`]+)`/g) || [];
      for (const span of spans) {
        const value = span.slice(1, -1).trim();
        if (looksLikeFile(value)) files.add(value);
      }
    }
  };

  const deliverableSections = Object.values(spec.sections).filter((s) =>
    /deliverable|artifact|file list|output/i.test(s.title)
  );

  if (deliverableSections.length > 0) {
    for (const section of deliverableSections) harvest(section.content);
  }

  if (files.size === 0) {
    for (const block of spec.codeBlocks) {
      if (['markdown', 'md', 'text', 'txt', 'plain', ''].includes(block.lang)) {
        harvest(block.code);
      }
    }
  }

  if (files.size === 0) {
    // Last resort: inline code spans across the whole specification.
    for (const section of Object.values(spec.sections)) harvest(section.content);
  }

  return [...files].sort().slice(0, MAX_PLAN_DELIVERABLES);
}

/** Actors named in the diagrams — the humans and systems that use this. */
function extractActors(spec) {
  const actors = new Set();
  const text = specDiagramText(spec);
  const actorRegex = /^[ \t]*(?:actor|:)[ \t]*"?([A-Za-z][A-Za-z0-9 _-]{1,40}?)"?[ \t]*:?[ \t]*(?:as[ \t]+\w+)?[ \t]*$/gim;
  let m;
  while ((m = actorRegex.exec(text)) !== null) {
    const name = m[1].trim();
    if (name && !/^(uml|mindmap)$/i.test(name)) actors.add(name);
  }
  return [...actors].sort();
}

/**
 * Pull the features a user must be able to perform out of the spec.
 *
 * Use-case diagrams are the best source, but plenty of specs have none,
 * so requirement tables and requirement bullet lists count too — any
 * "FR-3 | Place an order" row is a feature that has to work.
 */
function extractUseCases(spec) {
  const useCases = new Set();

  for (const diagram of spec.diagrams) {
    const text = diagram.content;
    if (!/usecase|use\s*case/i.test(text) && !/^\s*actor\b/im.test(text)) continue;

    const aliases = new Set();
    let declared = 0;
    let m;

    const labelledRegex = /usecase\s+"([^"]+)"\s+as\s+\(?([A-Za-z0-9_]+)\)?/gi;
    while ((m = labelledRegex.exec(text)) !== null) {
      useCases.add(m[1].trim());
      aliases.add(m[2].toLowerCase());
      declared += 1;
    }

    const quotedRegex = /usecase\s+"([^"]+)"(?!\s+as)/gi;
    while ((m = quotedRegex.exec(text)) !== null) {
      useCases.add(m[1].trim());
      declared += 1;
    }

    const bareRegex = /usecase\s+\(?([A-Za-z][A-Za-z0-9_]*)\)?\s*$/gim;
    while ((m = bareRegex.exec(text)) !== null) {
      useCases.add(m[1].trim());
      declared += 1;
    }

    if (declared === 0) {
      const parenRegex = /\(([A-Z][A-Za-z0-9 _-]{2,40})\)/g;
      while ((m = parenRegex.exec(text)) !== null) {
        const name = m[1].trim();
        if (!aliases.has(name.toLowerCase())) useCases.add(name);
      }
    }
  }

  // Requirement tables / lists: "FR-1 | Play game" or "- FR-1: Play game".
  // Only FUNCTIONAL ids describe something a user does; NFR/ASR rows are
  // quality attributes, which constrain the build instead of being screens.
  const requirementRegex =
    /\b(FR|NFR|ASR|QA|UC|US|REQ)[-_ ]?\d+(?:\.\d+)?\b[ \t]*[|:—–-][ \t]*\**([^|\n*]{3,80})/gi;
  let m;
  while ((m = requirementRegex.exec(specProse(spec))) !== null) {
    const kind = m[1].toUpperCase();
    if (kind === 'NFR' || kind === 'ASR' || kind === 'QA') continue;
    const text = m[2].trim().replace(/\s+/g, ' ').replace(/[.;,]$/, '');
    if (QUALITY_WORDS.test(text)) continue;
    useCases.add(text);
  }

  // "Play Game" from the diagram and "Play game" from the requirement
  // table are one feature; keep the first spelling seen.
  const unique = new Map();
  for (const useCase of useCases) {
    const key = nameWords(useCase).join(' ');
    if (key && !unique.has(key)) unique.set(key, useCase);
  }

  return [...unique.values()].sort().slice(0, MAX_PLAN_USE_CASES);
}

/**
 * Work out what kind of surface real people use to reach this system —
 * a web UI, a mobile app, a desktop app, a CLI — or none at all, for a
 * library or a machine-to-machine service.
 *
 * The answer decides what "the project is finished" means on disk, so it
 * is derived from the spec's own vocabulary rather than assumed.
 */
function detectUserSurface(spec) {
  const prose = specProse(spec);
  const diagrams = specDiagramText(spec);
  const haystack = `${prose}\n${diagrams}`;

  const scores = SURFACE_KINDS.map((kind) => {
    const hits = new Set();
    let m;
    const regex = new RegExp(kind.detect.source, 'gi');
    while ((m = regex.exec(haystack)) !== null) hits.add(m[0].toLowerCase());
    return { kind, hits: [...hits] };
  }).sort((a, b) => b.hits.length - a.hits.length);

  const best = scores[0];
  const actors = extractActors(spec);

  // Client surfaces the diagrams name outright (UserClient, AdminUI, …).
  const surfaces = new Set();
  const surfaceRegex = /\b([A-Z][A-Za-z0-9]*(?:Client|UI|Frontend|Portal|WebApp|App|Console|Dashboard))\b/g;
  let m;
  while ((m = surfaceRegex.exec(haystack)) !== null) surfaces.add(m[1]);

  const humanSignals = /\b(user interface|end[- ]user|screen|actor|human|operator|customer)\b/i.test(
    haystack
  );

  if (best.hits.length > 0) {
    return {
      required: true,
      kind: best.kind.id,
      label: best.kind.label,
      checklist: best.kind.checklist,
      signals: best.hits.slice(0, 12),
      surfaces: [...surfaces].sort(),
      actors,
      inferred: false,
    };
  }

  if (actors.length > 0 || surfaces.size > 0 || humanSignals) {
    // People use it, but no client technology is named — the spec leaves
    // the choice open, so ask for the most portable one.
    const fallback = SURFACE_KINDS.find((k) => k.id === 'web');
    return {
      required: true,
      kind: fallback.id,
      label: `${fallback.label} (no client technology named in the spec — ` +
        'plain HTML/CSS/JS is fine)',
      checklist: fallback.checklist,
      signals: actors.length ? actors.map((a) => `actor ${a}`) : ['user-facing wording'],
      surfaces: [...surfaces].sort(),
      actors,
      inferred: true,
    };
  }

  return {
    required: false,
    kind: 'none',
    label: 'no end-user surface (library / service-to-service system)',
    checklist: [],
    signals: [],
    surfaces: [],
    actors,
    inferred: false,
  };
}

function deriveBuildPlan(spec) {
  const components = extractComponents(spec);
  const deliverables = extractDeliverables(spec);
  const useCases = extractUseCases(spec);
  const ui = detectUserSurface(spec);

  console.log(
    `[plan] Build plan: ${components.length} component(s) ` +
    `(${components.join(', ') || 'none detected'}), ` +
    `${deliverables.length} named deliverable(s), ` +
    `${useCases.length} use case(s).`
  );
  console.log(
    ui.required
      ? `[plan] End-user surface required: ${ui.label}` +
      (ui.signals.length ? ` [from: ${ui.signals.slice(0, 6).join(', ')}]` : '')
      : '[plan] No end-user surface detected in the spec — services only.'
  );

  return { components, deliverables, useCases, ui };
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

  if (plan.useCases && plan.useCases.length > 0) {
    lines.push(
      '',
      'Use cases from the spec — each must be implemented END TO END',
      '(backend logic AND a screen in the UI that a real user can reach):'
    );
    for (const uc of plan.useCases) lines.push(`  [ ] ${uc}`);
  }

  if (plan.ui && plan.ui.required) {
    lines.push(
      '',
      `END-USER SURFACE — REQUIRED: ${plan.ui.label}.`,
      'The spec describes a system real people use, so the services alone',
      'do NOT satisfy this plan. You must also build:'
    );
    for (const item of plan.ui.checklist) lines.push(`  [ ] ${item}`);

    // A web build is delivered as a desktop application as well as a
    // site: the launcher opens the Electron shell, not a browser.
    if (DESKTOP_SHELL_REQUIRED && plan.ui.kind === 'web') {
      lines.push(
        '',
        'DESKTOP APPLICATION — REQUIRED: this project is launched as an',
        'Electron desktop app, not as a browser tab. On top of the web',
        'interface above you must also build:',
        `  [ ] ${DESKTOP_SHELL_ENTRY} — the Electron main process: start the`,
        '      backend as a child process, wait until it answers, open a',
        '      BrowserWindow on it, and kill the child when the window closes',
        `  [ ] an "${DESKTOP_SHELL_SCRIPT}" script in package.json that runs it`,
        '  [ ] "electron" in devDependencies',
        '  The browser route must keep working: npm start still serves the',
        '  same site on the same port. The desktop shell is an addition.'
      );
    }
    if (plan.ui.surfaces.length > 0) {
      lines.push(
        '',
        `  The spec names these client surfaces: ${plan.ui.surfaces.join(', ')}.`,
        '  Build a screen set for each one.'
      );
    }
    if (plan.ui.inferred) {
      lines.push(
        '',
        '  The spec does not name a client technology, so choose the simplest',
        '  thing that works (plain HTML/CSS/JS is fine) and say so in the README.'
      );
    }
    if (plan.ui.actors.length > 0) {
      lines.push(
        `  Actors who need screens: ${plan.ui.actors.join(', ')}.`
      );
    }
  }

  lines.push(
    '',
    'Plus, always: a dependency file, a README.md, and tests that assert',
    'real behaviour. Work through this list file by file.'
  );
  return lines.join('\n');
}

module.exports = {
  deriveBuildPlan,
  formatBuildPlan,
  extractComponents,
  extractDeliverables,
  extractUseCases,
  extractActors,
  detectUserSurface,
  specProse,
  specDiagramText,
};
