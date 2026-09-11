'use strict';

/**
 * Judge the frontend the way a user would.
 *
 * "A .html file exists" says nothing about whether anything works. This
 * module reads the built UI and the built backend and answers the
 * questions that decide whether a person can actually use the thing:
 *
 *   - Is it a real project, or one enormous index.html with everything
 *     inlined into it?
 *   - Does every stylesheet and script the page loads actually exist?
 *   - Does every API path the UI calls actually exist in the backend?
 *
 * The last one is the reason a generated app usually looks fine and does
 * nothing: the page calls /api/v1/questions, the server only ever mounted
 * /api/questions, and every button silently fails.
 *
 * Findings are plain sentences, phrased as instructions, because they are
 * handed straight back to the model.
 */

const fs = require('fs');
const path = require('path');

const {
  PROJECT_DIR,
  MIN_UI_SOURCE_FILES,
  MIN_UI_SOURCE_FILES_MULTI_SCREEN,
  MULTI_SCREEN_USE_CASES,
  MAX_SINGLE_HTML_BYTES,
  MAX_INLINE_SCRIPT_BYTES,
  MIN_BACKEND_ROUTES_TO_CROSS_CHECK,
  STATIC_ASSET_EXT,
} = require('../config');

const HTML_EXT = /\.html?$/i;
const SCRIPT_EXT = /\.(js|mjs|jsx|ts|tsx|vue|svelte)$/i;
const STYLE_EXT = /\.(css|scss|sass|less)$/i;

function read(rel) {
  try {
    return fs.readFileSync(path.join(PROJECT_DIR, rel), 'utf8');
  } catch (e) {
    return '';
  }
}

// --------------------------------------------------------------------
// URL / path helpers
// --------------------------------------------------------------------

/** Strip query, hash and template holes so two paths can be compared. */
function normalizePath(value) {
  return String(value)
    .split('?')[0]
    .split('#')[0]
    .replace(/\$\{[^}]*\}/g, '*')
    .replace(/\/+$/, '') || '/';
}

function segments(p) {
  return normalizePath(p).split('/').filter(Boolean);
}

/** `:id`, `{id}`, `<int:id>` and `*` all match any single segment. */
function isWildcardSegment(seg) {
  return (
    seg === '*' ||
    seg.startsWith(':') ||
    /^\{.*\}$/.test(seg) ||
    /^<.*>$/.test(seg) ||
    seg.startsWith('$')
  );
}

function pathMatches(callPath, routePath) {
  const call = segments(callPath);
  const route = segments(routePath);
  if (route.length === 1 && route[0] === '*') return true;
  if (call.length !== route.length) return false;
  return call.every(
    (seg, i) =>
      isWildcardSegment(route[i]) ||
      isWildcardSegment(seg) ||
      seg.toLowerCase() === route[i].toLowerCase()
  );
}

function looksStatic(p) {
  const last = normalizePath(p).split('/').pop() || '';
  const ext = last.includes('.') ? last.split('.').pop().toLowerCase() : '';
  return ext !== '' && STATIC_ASSET_EXT.has(ext);
}

function isExternal(value) {
  return /^(?:[a-z]+:)?\/\//i.test(value) || /^(data|mailto|tel|javascript|#):?/i.test(value);
}

// --------------------------------------------------------------------
// Extraction
// --------------------------------------------------------------------

/** Every stylesheet / script / image the HTML asks the browser to load. */
function extractAssetRefs(html) {
  const refs = [];
  const patterns = [
    /<link[^>]+href\s*=\s*["']([^"']+)["']/gi,
    /<script[^>]+src\s*=\s*["']([^"']+)["']/gi,
    /<img[^>]+src\s*=\s*["']([^"']+)["']/gi,
    /import\s+["']([^"']+\.(?:js|mjs|css))["']/gi,
  ];
  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(html)) !== null) {
      if (!isExternal(m[1])) refs.push(m[1]);
    }
  }
  return [...new Set(refs)];
}

/** `const API_BASE = '/api/v1'` — the prefix a well-written API layer shares. */
function extractBaseConstants(source) {
  const bases = new Map();
  const pattern = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[`'"](\/[^`'"\s]*)[`'"]/g;
  let m;
  while ((m = pattern.exec(source)) !== null) {
    const value = normalizePath(m[2]);
    if (!looksStatic(value) && value !== '/') bases.set(m[1], value);
  }
  return bases;
}

const usable = (value) =>
  value && value.startsWith('/') && !isExternal(value) && !looksStatic(value);

/**
 * Every server path the UI asks for.
 *
 * `strong` are literal URLs passed straight to fetch/axios — if one of
 * those has no route, the frontend is provably broken, so it is reported
 * as a blocking finding.
 *
 * `derived` come from the pattern good code actually uses:
 *
 *     const base = '/api/v1';
 *     const json = (p) => fetch(base + p).then(r => r.json());
 *     export const playGame = () => json('/play');
 *
 * The path is assembled at runtime, so it is not proof of anything on its
 * own — but it is exactly what the running server should be asked for, so
 * these are probed live instead of being judged statically.
 */
function extractApiCalls(source) {
  const strong = new Set();
  const derived = new Set();
  const bases = extractBaseConstants(source);

  const literalPatterns = [
    /fetch\s*\(\s*[`'"]([^`'"]+)[`'"]/g,
    /axios\s*\.\s*(?:get|post|put|patch|delete)\s*\(\s*[`'"]([^`'"]+)[`'"]/g,
    /\$\.(?:get|post|ajax)\s*\(\s*[`'"]([^`'"]+)[`'"]/g,
    /url\s*:\s*[`'"](\/[^`'"]+)[`'"]/g,
    /(?:open)\s*\(\s*["'][A-Z]+["']\s*,\s*[`'"]([^`'"]+)[`'"]/g,
  ];
  for (const pattern of literalPatterns) {
    let m;
    while ((m = pattern.exec(source)) !== null) {
      const value = m[1].trim();
      if (usable(value)) strong.add(normalizePath(value));
    }
  }

  // fetch(`${base}/play`) and fetch(base + '/play')
  const composed = [
    /fetch\s*\(\s*`\$\{\s*([A-Za-z_$][\w$]*)\s*\}([^`]*)`/g,
    /fetch\s*\(\s*([A-Za-z_$][\w$]*)\s*\+\s*[`'"]([^`'"]+)[`'"]/g,
  ];
  for (const pattern of composed) {
    let m;
    while ((m = pattern.exec(source)) !== null) {
      const base = bases.get(m[1]);
      const suffix = m[2] || '';
      if (base) strong.add(normalizePath(base + (suffix.startsWith('/') ? suffix : `/${suffix}`)));
    }
  }

  // Only look for wrapper-style calls in files that really do talk HTTP.
  if (/fetch\s*\(|axios|XMLHttpRequest/.test(source) && bases.size > 0) {
    const literal = /[`'"](\/[^`'"\s]*)[`'"]/g;
    let m;
    while ((m = literal.exec(source)) !== null) {
      const value = normalizePath(m[1]);
      if (!usable(value) || value === '/') continue;
      if (strong.has(value)) continue;
      for (const base of bases.values()) {
        if (value.startsWith(base)) continue; // already absolute
        derived.add(normalizePath(base + value));
      }
    }
  }

  return { strong: [...strong], derived: [...derived] };
}

/** Every path the backend actually serves, plus the prefixes it mounts at. */
function extractBackendRoutes(backendFiles) {
  const routes = new Set();
  const prefixes = new Set();

  const routePatterns = [
    /\b(?:app|router|api|server|r|mux)\s*\.\s*(?:get|post|put|patch|delete|all|options|head)\s*\(\s*[`'"]([^`'"]+)[`'"]/gi,
    /@\w+\.route\s*\(\s*[`'"]([^`'"]+)[`'"]/g,
    /@\w+\.(?:get|post|put|patch|delete)\s*\(\s*[`'"]([^`'"]+)[`'"]/g,
    /\b(?:HandleFunc|Handle)\s*\(\s*[`"]([^`"]+)[`"]/g,
    /@(?:Get|Post|Put|Delete|Request)Mapping\s*\(\s*(?:value\s*=\s*)?[`"]([^`"]+)[`"]/g,
    /\brouter\.(?:route)\s*\(\s*[`'"]([^`'"]+)[`'"]/g,
  ];
  const prefixPatterns = [
    /\b(?:app|router|server)\s*\.\s*use\s*\(\s*[`'"](\/[^`'"]*)[`'"]/g,
    /include_router\s*\([^)]*prefix\s*=\s*[`'"]([^`'"]+)[`'"]/g,
    /url_prefix\s*=\s*[`'"]([^`'"]+)[`'"]/g,
    /\bBlueprint\s*\([^)]*[`'"](\/[^`'"]+)[`'"]/g,
    /@(?:Request)Mapping\s*\(\s*(?:value\s*=\s*)?[`"](\/[^`"]+)[`"]\s*\)\s*(?:public\s+)?class/g,
  ];

  for (const rel of backendFiles) {
    const source = read(rel);
    if (!source) continue;

    for (const pattern of routePatterns) {
      let m;
      while ((m = pattern.exec(source)) !== null) {
        const value = m[1].trim();
        if (!value.startsWith('/')) continue;
        routes.add(normalizePath(value));
      }
    }
    for (const pattern of prefixPatterns) {
      let m;
      while ((m = pattern.exec(source)) !== null) {
        const value = normalizePath(m[1].trim());
        if (value !== '/' && !looksStatic(value)) prefixes.add(value);
      }
    }
  }

  return { routes: [...routes], prefixes: [...prefixes] };
}

/**
 * Can the backend answer this call? Either the route is declared with its
 * full path, or it is declared as a suffix under a mount prefix
 * (`app.use('/api/v1', gameRoutes)` + `router.get('/play')`).
 */
function backendServes(callPath, routes, prefixes) {
  if (routes.some((route) => pathMatches(callPath, route))) return true;

  for (const prefix of prefixes) {
    const prefixSegs = segments(prefix);
    const callSegs = segments(callPath);
    if (callSegs.length < prefixSegs.length) continue;
    const head = callSegs.slice(0, prefixSegs.length);
    const matchesPrefix = head.every(
      (seg, i) => seg.toLowerCase() === prefixSegs[i].toLowerCase()
    );
    if (!matchesPrefix) continue;
    const rest = '/' + callSegs.slice(prefixSegs.length).join('/');
    if (routes.some((route) => pathMatches(rest, route))) return true;
  }
  return false;
}

// --------------------------------------------------------------------
// The review
// --------------------------------------------------------------------

/**
 * Inspect the frontend on disk and return { findings, facts }.
 * `findings` are blocking problems phrased for the model; `facts` are for
 * the console and for the smoke runner to probe at runtime.
 */
function analyseFrontend(uiFiles, allFiles, plan) {
  const findings = [];

  const htmlFiles = uiFiles.filter((f) => HTML_EXT.test(f));
  const scriptFiles = uiFiles.filter((f) => SCRIPT_EXT.test(f));
  const styleFiles = uiFiles.filter((f) => STYLE_EXT.test(f));
  const sourceFiles = [...new Set([...htmlFiles, ...scriptFiles, ...styleFiles])];

  const useCaseCount = plan && plan.useCases ? plan.useCases.length : 0;
  const requiredFiles =
    useCaseCount >= MULTI_SCREEN_USE_CASES
      ? MIN_UI_SOURCE_FILES_MULTI_SCREEN
      : MIN_UI_SOURCE_FILES;

  // ---- 1. Is it a real project, or one giant file? -------------------
  if (sourceFiles.length < requiredFiles) {
    findings.push(
      `the interface is only ${sourceFiles.length} file(s). Split it into ` +
      `at least ${requiredFiles}: an entry page, a stylesheet, and separate ` +
      'script files (e.g. frontend/index.html, frontend/css/styles.css, ' +
      'frontend/js/api.js, frontend/js/app.js — plus one file per screen ' +
      'once there is more than one). Do not put the whole application in ' +
      'a single .html file.'
    );
  }

  if (styleFiles.length === 0) {
    findings.push(
      'there is no separate stylesheet file. Move the CSS out of the HTML ' +
      'into its own .css file and link it with <link rel="stylesheet">.'
    );
  }

  if (scriptFiles.length === 0) {
    findings.push(
      'there is no separate script file. Move the JavaScript out of the ' +
      'HTML into its own .js file(s) and load them with <script src="...">.'
    );
  }

  for (const rel of htmlFiles) {
    const html = read(rel);
    const bytes = Buffer.byteLength(html, 'utf8');
    const inlineScript = (html.match(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi) || [])
      .join('').length;

    if (bytes > MAX_SINGLE_HTML_BYTES) {
      findings.push(
        `${rel} is ${Math.round(bytes / 1024)} KB — far too much for one ` +
        'page. Split the screens into separate pages or separate script ' +
        'modules so each file does one job.'
      );
    } else if (inlineScript > MAX_INLINE_SCRIPT_BYTES) {
      findings.push(
        `${rel} carries ${Math.round(inlineScript / 1024)} KB of inline ` +
        '<script>. Move that logic into .js files and load them with ' +
        '<script src="...">.'
      );
    }
  }

  // ---- 2. Does everything the page loads exist? ----------------------
  const lowerAll = new Set(allFiles.map((f) => f.toLowerCase()));
  const assetRefs = [];

  for (const rel of htmlFiles) {
    const dir = path.posix.dirname(rel.replace(/\\/g, '/'));
    for (const ref of extractAssetRefs(read(rel))) {
      const clean = normalizePath(ref);
      const candidates = [
        // relative to the page
        path.posix.normalize(`${dir}/${clean}`).replace(/^\.\//, ''),
        // relative to the UI root, for a server that serves it as static root
        clean.replace(/^\//, ''),
        `${dir}/${clean.replace(/^\//, '')}`,
        // a public/ or static/ root two levels up
        path.posix.normalize(`${dir}/../${clean.replace(/^\//, '')}`),
      ].map((c) => c.replace(/^\/+/, '').toLowerCase());

      const resolved = candidates.some((c) => lowerAll.has(c));
      assetRefs.push({ from: rel, href: ref, resolved });

      if (!resolved) {
        findings.push(
          `${rel} loads "${ref}" but no such file was written. Create it, ` +
          'or correct the path — a missing stylesheet or script means the ' +
          'page renders broken and nothing on it works.'
        );
      }
    }
  }

  // ---- 3. Does the backend answer what the UI calls? -----------------
  const uiSet = new Set(uiFiles);
  const backendFiles = allFiles.filter(
    (f) => !uiSet.has(f) && /\.(js|mjs|cjs|ts|py|go|java|rb|php|cs)$/i.test(f)
  );
  const { routes, prefixes } = extractBackendRoutes(backendFiles);

  const apiCalls = [];
  const derivedCalls = [];
  let callsHttp = false;
  for (const rel of [...htmlFiles, ...scriptFiles]) {
    const source = read(rel);
    if (/fetch\s*\(|axios|XMLHttpRequest|EventSource|WebSocket/.test(source)) callsHttp = true;
    const { strong, derived } = extractApiCalls(source);
    for (const call of strong) {
      if (!apiCalls.some((c) => c.path === call)) apiCalls.push({ path: call, from: rel });
    }
    for (const call of derived) {
      if (!derivedCalls.includes(call)) derivedCalls.push(call);
    }
  }

  // Only cross-check when the backend was parsed well enough to trust,
  // and only against URLs written out literally — a path assembled at
  // runtime is probed by the smoke runner instead of guessed at here.
  const deadCalls = [];
  if (routes.length >= MIN_BACKEND_ROUTES_TO_CROSS_CHECK) {
    for (const call of apiCalls) {
      if (!backendServes(call.path, routes, prefixes)) deadCalls.push(call);
    }
  }

  for (const call of deadCalls) {
    findings.push(
      `${call.from} calls "${call.path}", but no backend route answers that ` +
      'path. Either add the route to the server or fix the URL in the ' +
      'frontend — as written, that button does nothing. Backend routes ' +
      `found: ${routes.slice(0, 8).join(', ')}${routes.length > 8 ? ', …' : ''}` +
      `${prefixes.length ? ` (mounted under ${prefixes.join(', ')})` : ''}.`
    );
  }

  if (!callsHttp) {
    findings.push(
      'no script in the interface calls the backend at all. The screens ' +
      'must fetch real data from your API, not display hardcoded values.'
    );
  }

  return {
    findings,
    facts: {
      htmlFiles,
      scriptFiles,
      styleFiles,
      sourceFileCount: sourceFiles.length,
      assetRefs,
      apiCalls: apiCalls.map((c) => c.path),
      derivedCalls,
      backendRoutes: routes,
      mountPrefixes: prefixes,
      deadCalls: deadCalls.map((c) => c.path),
    },
  };
}

module.exports = {
  analyseFrontend,
  extractApiCalls,
  extractAssetRefs,
  extractBackendRoutes,
  backendServes,
  normalizePath,
  pathMatches,
};
