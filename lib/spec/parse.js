'use strict';

const fs = require('fs');
const path = require('path');

const { WORKDIR, PROJECT_DIR } = require('../config');

// ====================================================================
// Markdown -> structured JSON parsing
//
// Nothing in this section is tied to one project or one document
// layout. Any markdown architecture documents will do: headings at any
// level, enumerated with letters, with numbers, or not at all; diagrams
// written in PlantUML or Mermaid, named or unnamed; kept in one file or
// spread across several, under whatever filenames the author chose.
//
// Produces exactly one flat JSON object with three top-level keys:
//   sections   - every top-level section of every input document
//   codeBlocks - every fenced code block, tagged with language + source
//   diagrams   - every PlantUML / Mermaid diagram found in any input
// ====================================================================

/** Documents that describe the agent or the repo, not the architecture. */
const NON_SPEC_DOCS = new Set([
  'readme.md',
  'changelog.md',
  'license.md',
  'contributing.md',
  'code_of_conduct.md',
  'memory.md',
  'claude.md',
]);

/**
 * Blank out the contents of fenced code blocks while keeping every
 * character position intact, so a "# comment" inside a shell snippet is
 * never mistaken for a markdown heading.
 */
function maskFencedBlocks(text) {
  return text.replace(/```[\s\S]*?(?:```|$)/g, (block) =>
    block.replace(/[^\n]/g, ' ')
  );
}

/** Strip a leading "A." / "3." / "3.1)" enumerator from a heading. */
function stripEnumerator(title) {
  return title.replace(/^(?:[A-Za-z]|\d+(?:\.\d+)*)[.):]\s+/, '').trim();
}

/** A stable, readable key for a section: its letter, its number, or its index. */
function sectionKey(title, index) {
  const letter = title.match(/^([A-Za-z])[.):]\s/);
  if (letter) return letter[1].toUpperCase();
  const number = title.match(/^(\d+(?:\.\d+)*)[.):]?\s/);
  if (number) return number[1];
  return `S${index + 1}`;
}

/**
 * Parse one markdown document into sections and code blocks.
 *
 * Sections split on the SHALLOWEST heading level the document actually
 * uses, so "# A. Executive Summary", "## 1. Overview" and a plain
 * "### Components" all work equally well; deeper headings stay inside
 * their parent section's content. A document with no headings at all
 * becomes a single section. Fenced code blocks stay inline in `content`
 * AND are extracted separately into `codeBlocks`.
 */
function parseMarkdownDocument(rawText, source) {
  const sections = [];
  const codeBlocks = [];

  const codeBlockRegex = /```([A-Za-z0-9_+-]*)\r?\n([\s\S]*?)```/g;
  let match;
  while ((match = codeBlockRegex.exec(rawText)) !== null) {
    codeBlocks.push({
      lang: (match[1] || 'text').trim().toLowerCase(),
      code: match[2].replace(/\s+$/, ''),
      source,
    });
  }

  // Find headings outside code fences, then keep only the shallowest level.
  const masked = maskFencedBlocks(rawText);
  const headingRegex = /^(#{1,6})[ \t]+(\S.*?)[ \t]*#*[ \t]*$/gm;
  const headings = [];
  while ((match = headingRegex.exec(masked)) !== null) {
    headings.push({
      level: match[1].length,
      raw: match[2].trim(),
      startIndex: match.index,
      headerLength: match[0].length,
    });
  }

  if (headings.length === 0) {
    const content = rawText.trim();
    if (content) {
      sections.push({ key: 'S1', title: source, content, source, level: 0 });
    }
    return { sections, codeBlocks };
  }

  const topLevel = Math.min(...headings.map((h) => h.level));
  const tops = headings.filter((h) => h.level === topLevel);

  // Anything before the first heading is still spec text worth keeping.
  const preamble = rawText.slice(0, tops[0].startIndex).trim();
  if (preamble) {
    sections.push({ key: 'S0', title: 'Preamble', content: preamble, source, level: 0 });
  }

  for (let i = 0; i < tops.length; i++) {
    const current = tops[i];
    const next = tops[i + 1];
    const contentStart = current.startIndex + current.headerLength;
    const contentEnd = next ? next.startIndex : rawText.length;

    sections.push({
      key: sectionKey(current.raw, i),
      title: stripEnumerator(current.raw) || current.raw,
      content: rawText.slice(contentStart, contentEnd).trim(),
      source,
      level: current.level,
    });
  }

  return { sections, codeBlocks };
}

/**
 * Give a diagram a usable name whatever the author wrote: the name on the
 * @startuml line, a `title` line, the mermaid diagram type, or a
 * positional fallback.
 */
function nameDiagram(declared, body, notation, index) {
  const named = (declared || '').trim().replace(/^["']|["']$/g, '');
  if (named) return named;

  const title = body.match(/^\s*title[ \t]+(.+)$/im);
  if (title) return title[1].trim();

  const firstLine = body.split(/\r?\n/).find((l) => l.trim());
  if (firstLine) {
    const kind = firstLine
      .trim()
      .match(/^(sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|flowchart|graph|mindmap|timeline|C4Context|C4Container)/i);
    if (kind) return `${kind[1]} ${index + 1}`;
  }

  return `${notation} diagram ${index + 1}`;
}

/**
 * Extract every diagram from a document, in either notation:
 *   PlantUML  @startuml [Name] ... @enduml   (also @startmindmap, @startwbs, …)
 *   Mermaid   ```mermaid ... ```
 * The name after @startuml is optional — unnamed diagrams are named from
 * their title line or their type instead of being dropped.
 */
function parseDiagrams(rawText, source) {
  const diagrams = [];

  const umlRegex = /@start(uml|mindmap|wbs|salt|gantt|json|yaml|ditaa)([^\n]*)\r?\n([\s\S]*?)@end\1/gi;
  let match;
  while ((match = umlRegex.exec(rawText)) !== null) {
    diagrams.push({
      name: nameDiagram(match[2], match[3], 'plantuml', diagrams.length),
      notation: 'plantuml',
      source,
      content: match[0].trim(),
    });
  }

  const mermaidRegex = /```mermaid\r?\n([\s\S]*?)```/gi;
  while ((match = mermaidRegex.exec(rawText)) !== null) {
    diagrams.push({
      name: nameDiagram('', match[1], 'mermaid', diagrams.length),
      notation: 'mermaid',
      source,
      content: match[1].trim(),
    });
  }

  return diagrams;
}

/**
 * Find the architecture documents in the working directory.
 *
 * Every markdown file beside agent.js is an input, whatever it is called
 * — there are no required filenames. Repo boilerplate (README, LICENSE,
 * …) is skipped unless it is the only markdown there is. The Project
 * folder is created when missing rather than treated as an error.
 */
function discoverInputFiles() {
  let entries;
  try {
    entries = fs.readdirSync(WORKDIR, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Cannot read the working directory: ${err.message}`);
  }

  const markdown = entries
    .filter((e) => e.isFile() && /\.(md|markdown|mdx)$/i.test(e.name))
    .map((e) => e.name)
    .sort();

  if (markdown.length === 0) {
    throw new Error(
      'No markdown architecture documents found beside agent.js. Put your ' +
      'architecture document(s) — any filename, any structure — in this ' +
      'folder and run again.'
    );
  }

  const specDocs = markdown.filter((f) => !NON_SPEC_DOCS.has(f.toLowerCase()));
  const chosen = specDocs.length > 0 ? specDocs : markdown;

  if (!fs.existsSync(PROJECT_DIR)) {
    fs.mkdirSync(PROJECT_DIR, { recursive: true });
    console.log('[scan] Created the Project folder (it did not exist yet).');
  } else if (!fs.statSync(PROJECT_DIR).isDirectory()) {
    throw new Error(
      `"${path.relative(WORKDIR, PROJECT_DIR)}" exists but is not a directory. ` +
      'The generated project needs that path.'
    );
  }

  return chosen;
}

/**
 * Build the final flat spec object: { sections, codeBlocks, diagrams }
 * from whatever documents were found.
 */
function buildStructuredSpec() {
  const inputFiles = discoverInputFiles();

  const sections = {};
  const codeBlocks = [];
  const diagrams = [];
  let sectionIndex = 0;

  for (const file of inputFiles) {
    console.log(`[scan] Reading architecture document: ${file}`);
    const raw = fs.readFileSync(path.join(WORKDIR, file), 'utf8');

    const parsed = parseMarkdownDocument(raw, file);
    for (const section of parsed.sections) {
      sectionIndex += 1;
      // Keys collide across documents ("1" in two files); keep both.
      let key = section.key;
      if (Object.prototype.hasOwnProperty.call(sections, key)) {
        key = `${section.key}-${sectionIndex}`;
      }
      sections[key] = {
        title: section.title,
        content: section.content,
        source: section.source,
      };
    }

    codeBlocks.push(...parsed.codeBlocks);
    diagrams.push(...parseDiagrams(raw, file));
  }

  console.log(`[scan] Generated project folder: ${path.relative(WORKDIR, PROJECT_DIR)}`);

  const spec = { sections, codeBlocks, diagrams };

  console.log(
    `[parse] Extracted ${Object.keys(sections).length} sections, ` +
    `${codeBlocks.length} code blocks, ${diagrams.length} diagram(s) ` +
    `from ${inputFiles.length} document(s).`
  );

  if (Object.keys(sections).length === 0 && diagrams.length === 0) {
    throw new Error(
      `The document(s) ${inputFiles.join(', ')} contain no headings, code ` +
      'blocks or diagrams — there is no specification to build from.'
    );
  }

  return spec;
}

module.exports = {
  buildStructuredSpec,
  discoverInputFiles,
  parseMarkdownDocument,
  parseDiagrams,
  maskFencedBlocks,
  stripEnumerator,
  sectionKey,
  nameDiagram,
};
