'use strict';

const path = require('path');

// ====================================================================
// Configuration constants
// ====================================================================

const MAX_TOKENS = 8192;
const MAX_TURNS = 100; // Total turn cap

// Multi-key rotation pause
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

// --- Runnability check -------------------------------------------------
// Files existing is not the same as a project that works. When the model
// says it is done, the agent installs the dependencies, starts the app and
// requests a page from it. A failure is handed back so the model can fix
// it; after this many attempts the run is allowed to end anyway.
const SMOKE_TEST_ENABLED = true;
const MAX_SMOKE_ATTEMPTS = 2;
const SMOKE_INSTALL_TIMEOUT_MS = 300000; // npm install on a cold cache is slow
const SMOKE_BOOT_TIMEOUT_MS = 20000;     // how long to wait for the first response
const SMOKE_PROBE_ATTEMPTS = 20;
const SMOKE_PROBE_INTERVAL_MS = 750;
const SMOKE_CLI_TIMEOUT_MS = 30000;
const SMOKE_OUTPUT_CHARS = 3000;         // how much crash output to keep

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

// --- Existing-project scan (resume support) ----------------------------
// Every run starts by scanning PROJECT_DIR. When it is not empty the tree,
// per-file sizes and the contents of key manifest files are handed to the
// model up front, so it continues the existing project rather than
// scaffolding it a second time.
const MAX_TREE_LINES = 400;          // cap the tree handed to the model
const CONSOLE_TREE_LINES = 40;       // cap the tree printed to the terminal
const MAX_MANIFEST_CHARS = 1500;     // per manifest file excerpt
const MAX_LINE_COUNT_BYTES = 1024 * 1024; // don't line-count huge/binary files

// Files worth showing the model verbatim on a resume: they pin down the
// stack, the dependencies and the contract the previous run committed to.
// --- Desktop shell -----------------------------------------------------
// A generated web project is delivered as a desktop application: the same
// Express/HTTP backend, with an Electron main process that starts it,
// waits for it, shows it in a window and shuts it down again. Launch mode
// (lib/runner/launch.js) runs that shell instead of opening a browser, so
// every web build has to ship it. The plain browser route keeps working.
const DESKTOP_SHELL_REQUIRED = true;
const DESKTOP_SHELL_ENTRY = 'electron/main.js';
const DESKTOP_SHELL_SCRIPT = 'electron';
// Markers that separate a real main process from an empty placeholder.
// Case-insensitive: the scanned project text is lowercased.
const DESKTOP_SHELL_SIGNATURE = /browserwindow/i;
const DESKTOP_SHELL_LOAD_SIGNATURE = /loadurl|loadfile/i;

// --- Build-plan sizing -------------------------------------------------
// A spec can name far more things than one run can build. These caps keep
// the checklist finishable rather than letting a huge document produce a
// plan that can never be satisfied.
const MAX_PLAN_COMPONENTS = 24;
const MAX_PLAN_DELIVERABLES = 40;
const MAX_PLAN_USE_CASES = 30;

// Words that describe a thing's architectural ROLE rather than its
// identity. Used both to spot component names in prose (OrderService,
// PaymentGateway, ReportWorker) and to match them loosely on disk, so
// "GameComponent" is satisfied by a game/ directory.
const ROLE_SUFFIXES = new Set([
  'component', 'service', 'module', 'subsystem', 'gateway', 'engine',
  'worker', 'daemon', 'server', 'api', 'store', 'repository', 'broker',
  'scheduler', 'pipeline', 'manager', 'controller', 'handler', 'processor',
  'adapter', 'client', 'app', 'application', 'system', 'layer', 'container',
  'database', 'cache', 'queue', 'frontend', 'backend', 'microservice',
]);

// A component and its deployment do not need building twice. These
// suffixes describe WHERE something runs (GameServer, UserClient,
// OrderContainer) rather than WHAT it is, so a name carrying one is
// folded into the logical component that shares its stem.
const LAYER_SUFFIXES = new Set([
  'server', 'container', 'client', 'node', 'instance', 'pod', 'vm', 'host',
  'deployment', 'process', 'app', 'application', 'system', 'tier', 'layer',
  'machine', 'box', 'cluster',
]);

// Suffixes that DO name a distinct thing to build.
const LOGICAL_SUFFIXES = new Set([
  'component', 'service', 'module', 'subsystem', 'gateway', 'engine',
  'worker', 'daemon', 'broker', 'scheduler', 'pipeline', 'manager',
  'controller', 'handler', 'processor', 'adapter', 'repository', 'store',
  'api', 'cache', 'queue', 'database', 'microservice',
]);

const NAME_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'and', 'for', 'in', 'on', 'with', 'this',
  'that', 'its', 'their', 'is', 'are', 'be',
]);

// Words that are a category, a table header or a heading — never the name
// of something to build.
const GENERIC_NAMES = new Set([
  'system', 'service', 'component', 'components', 'module', 'server',
  'client', 'user', 'admin', 'database', 'api', 'application', 'app',
  'overview', 'architecture', 'summary', 'deliverables', 'requirements',
  'requirement id', 'short text', 'diagram s', 'component s', 'rationale',
  'artifact filename s', 'risk', 'mitigation', 'test type', 'name',
  'description', 'type', 'id', 'note', 'notes', 'todo', 'tbd', 'none',
  'yes', 'no', 'n a', 'example', 'examples', 'option', 'options', 'step',
  'steps', 'phase', 'decision', 'technology', 'stack', 'language',
  'framework', 'endpoint', 'endpoints', 'table', 'column', 'field',
]);

// Words that mark a table row or bullet as being about process, quality
// or paperwork rather than about a piece of the system to build.
const NON_COMPONENT_WORDS = new Set([
  'test', 'tests', 'testing', 'matrix', 'strategy', 'plan', 'policy',
  'risk', 'risks', 'mitigation', 'metric', 'metrics', 'slo', 'sla', 'rto',
  'rpo', 'runbook', 'dashboard', 'migration', 'rollout', 'tradeoff',
  'assumption', 'assumptions', 'summary', 'review', 'rationale',
  'justification', 'diagram', 'diagrams', 'requirement', 'requirements',
  'threat', 'secret', 'secrets', 'step', 'steps', 'note', 'notes',
]);

// Quality attributes are constraints on the system, not features a user
// performs, so they never become use cases.
// Prefixes, not whole words: "durabil" has to match "durability".
const QUALITY_WORDS = /\b(performance|latency|throughput|scalab|availab|durabil|secur|reliab|maintainab|usabilit|portabilit|complian|backup|encrypt|uptime|recovery|monitor|observab|logging|audit|resilien|testab)/i;

// File extensions a deliverable can plausibly have, plus the handful of
// deliverables that carry no extension at all.
const KNOWN_FILE_EXT = new Set([
  'md', 'markdown', 'txt', 'rst', 'adoc', 'json', 'yaml', 'yml', 'toml',
  'ini', 'cfg', 'conf', 'env', 'xml', 'csv', 'tsv', 'sql', 'ddl', 'proto',
  'graphql', 'gql', 'avsc', 'thrift', 'js', 'mjs', 'cjs', 'jsx', 'ts',
  'tsx', 'vue', 'svelte', 'py', 'rb', 'php', 'java', 'kt', 'kts', 'go',
  'rs', 'cs', 'c', 'cc', 'cpp', 'h', 'hpp', 'swift', 'dart', 'scala',
  'ex', 'exs', 'sh', 'bash', 'ps1', 'bat', 'html', 'htm', 'css', 'scss',
  'sass', 'less', 'tf', 'tfvars', 'lock', 'gradle', 'properties', 'pom',
  'dockerfile', 'service', 'svg', 'png', 'pdf',
]);
const NAMED_FILES = new Set([
  'dockerfile', 'makefile', 'procfile', 'jenkinsfile', 'vagrantfile',
  'gemfile', 'rakefile', 'caddyfile', '.gitignore', '.dockerignore',
  '.env', '.env.example', '.editorconfig',
]);

// --- Frontend quality --------------------------------------------------
// One enormous index.html with the stylesheet, every screen and every bit
// of logic inlined is the default failure mode of a generated UI: it looks
// finished and is impossible to extend or debug. These thresholds define
// what "a real frontend project" means on disk.
const MIN_UI_SOURCE_FILES = 3;               // page + stylesheet + script
const MIN_UI_SOURCE_FILES_MULTI_SCREEN = 5;  // once the spec has several use cases
const MULTI_SCREEN_USE_CASES = 3;
const MAX_SINGLE_HTML_BYTES = 20000;         // beyond this, split the page
const MAX_INLINE_SCRIPT_BYTES = 4000;        // beyond this, move it to a .js file

// The UI's fetch() calls are cross-checked against the backend's declared
// routes, but only when enough routes were parsed for the comparison to
// mean something — an unfamiliar framework must not cause false failures.
const MIN_BACKEND_ROUTES_TO_CROSS_CHECK = 2;

// Extensions that mark a URL as a static asset rather than an API call.
const STATIC_ASSET_EXT = new Set([
  'html', 'htm', 'css', 'js', 'mjs', 'map', 'png', 'jpg', 'jpeg', 'gif',
  'svg', 'ico', 'webp', 'avif', 'woff', 'woff2', 'ttf', 'eot', 'mp3',
  'mp4', 'webm', 'ogg', 'wav', 'pdf', 'txt',
]);

// --- End-user surfaces -------------------------------------------------
// A specification is only satisfied when the people it describes can
// actually reach the system. What that means depends on the system: a web
// UI, a mobile app, a desktop app, a command-line tool — or nothing at
// all, for a library or a service-to-service backend.
//
// Each kind below says how to recognise it in the spec, what to build,
// and how to tell — from the files on disk — whether it was really built
// or only stubbed. Add a kind here and the whole agent understands it;
// nothing else is hardcoded to any one of them.
const SURFACE_KINDS = [
  {
    id: 'web',
    label: 'web user interface',
    detect: /\b(web[- ]?based|web ?app(?:lication)?|web ?site|web portal|browser|single[- ]page|spa|html5?|css|react|angular|vue(?:\.js)?|svelte|next\.js|nuxt|jquery|bootstrap|tailwind|front[- ]?end|web ui|web client|dashboard|landing page|responsive)\b/,
    primary: /\.(html?|jsx|tsx|vue|svelte)$/i,
    primaryDesc: '.html/.jsx/.tsx/.vue/.svelte',
    supporting: /\.(css|scss|sass|less|js|mjs|ts)$/i,
    entry: /(^|\/)(index\.html?|main\.(jsx|tsx|vue|svelte)|app\.(html?|jsx|tsx|vue|svelte))$/i,
    entryDesc: 'index.html, App.jsx, main.vue, …',
    wiring: /fetch\s*\(|axios|XMLHttpRequest|EventSource|WebSocket|\$\.(get|post|ajax)|\/api\//i,
    wiringDesc: 'calls the backend (no fetch/axios/WebSocket request in any UI file)',
    minFiles: 2,
    minBytes: 1200,
    checklist: [
      'a frontend entry point a browser can open (e.g. frontend/index.html)',
      'a SEPARATE stylesheet file (frontend/css/styles.css) — no inlined <style> blob',
      'SEPARATE script files (frontend/js/api.js for the fetch layer, frontend/js/app.js for the shell)',
      'one script module (or one page) PER SCREEN — never the whole app in one .html file',
      'a real screen for every use case listed above — markup, styling, state',
      'client-side code that calls the backend API and renders the response',
      'navigation between screens, plus visible loading, empty and error states',
      'forms that validate input and show the server error when a request fails',
      'the backend serving the frontend (static middleware) or a documented dev-server command',
    ],
  },
  {
    id: 'mobile',
    label: 'mobile application',
    detect: /\b(mobile app|android|ios|react native|flutter|swiftui|jetpack compose|xamarin|ionic|play store|app store|smartphone|tablet app)\b/,
    primary: /\.(dart|swift|kt)$|(^|\/)(screens?|views?|pages?|lib|app)\/.*\.(jsx|tsx)$/i,
    primaryDesc: '.dart/.swift/.kt screen files (or React Native screens)',
    supporting: /\.(dart|swift|kt|jsx|tsx|xml|json)$/i,
    entry: /(^|\/)(main\.dart|App\.(jsx|tsx)|MainActivity\.(kt|java)|AppDelegate\.swift|index\.(js|tsx))$/i,
    entryDesc: 'main.dart, App.tsx, MainActivity.kt, AppDelegate.swift',
    wiring: /http\.|dio|retrofit|URLSession|fetch\s*\(|axios|okhttp|api(client|service)/i,
    wiringDesc: 'calls the backend (no HTTP client call in any app file)',
    minFiles: 2,
    minBytes: 1200,
    checklist: [
      'an app entry point (main.dart, App.tsx, MainActivity.kt, …)',
      'a screen for every use case listed above, with real layout and state',
      'an API client that calls the backend and renders the response',
      'navigation between the screens',
      'the exact command that builds and runs the app, documented in the README',
    ],
  },
  {
    id: 'desktop',
    label: 'desktop application',
    detect: /\b(desktop app(?:lication)?|electron|wpf|winforms|javafx|qt |gtk|tauri|swing|tkinter|native window)\b/,
    primary: /\.(html?|xaml|fxml|qml|ui|jsx|tsx)$/i,
    primaryDesc: '.html/.xaml/.fxml/.qml window files',
    supporting: /\.(css|js|mjs|ts|py|cs|java)$/i,
    entry: /(^|\/)(index\.html?|main\.(js|py|cs|java)|MainWindow\.(xaml|fxml)|app\.(js|py))$/i,
    entryDesc: 'index.html + main.js, MainWindow.xaml, app.py, …',
    wiring: /ipcRenderer|ipcMain|fetch\s*\(|axios|requests\.|HttpClient|http\./i,
    wiringDesc: 'talks to its backend or data layer',
    minFiles: 2,
    minBytes: 1200,
    checklist: [
      'a window/entry point the app opens on launch',
      'a view for every use case listed above',
      'the code that connects those views to the backend or data layer',
      'navigation between views',
      'the exact command that runs the app, documented in the README',
    ],
  },
  {
    id: 'cli',
    label: 'command-line interface',
    detect: /\b(command[- ]line|cli tool|cli app|terminal (?:app|tool|ui)|argparse|commander|yargs|cobra|click\b|stdin|shell tool|console app)\b/,
    primary: /(^|\/)(bin|cmd|cli)\/|(^|\/)(cli|main|__main__|index)\.(js|mjs|ts|py|go|rb|sh)$/i,
    primaryDesc: 'a bin/ or cli/main entry script',
    supporting: /\.(js|mjs|ts|py|go|rb|sh)$/i,
    entry: /(^|\/)(bin\/|cmd\/|cli\.|main\.|__main__\.)/i,
    entryDesc: 'bin/<name>, cli.js, main.py, cmd/<name>/main.go',
    wiring: /argparse|commander|yargs|click|cobra|flag\.|process\.argv|sys\.argv|os\.Args|OptionParser|getopt/i,
    wiringDesc: 'parses arguments (no argv/argparse/commander/cobra handling found)',
    minFiles: 1,
    minBytes: 400,
    checklist: [
      'an executable entry point (bin/<name>, cli.js, main.py, …)',
      'a subcommand or flag for every use case listed above',
      'argument parsing, --help output, and non-zero exit codes on failure',
      'the command wired to the real logic, not printing placeholder text',
      'usage examples in the README',
    ],
  },
];

// Directory names that mark a user-facing surface, wherever it lives.
// Deliberately NOT "src" or "app": those are where the SERVER usually
// lives, and counting src/index.js as part of the interface both flatters
// the file count and hides the backend's routes from the cross-check.
const UI_DIR = /(^|\/)(frontend|front-end|client|clients|ui|web|www|public|static|views|templates|pages|screens|components|assets)(\/|$)/i;

// A file that boots a server is not part of the user interface, whatever
// directory it sits in.
const SERVER_SIGNATURE = /\b(?:app|server)\.listen\s*\(|require\(['"]express['"]\)|from\s+['"]express['"]|createServer\s*\(|app\.use\s*\(\s*express\.|FastAPI\s*\(|Flask\s*\(__name__|http\.ListenAndServe/;

// Files whose text is searched when checking coverage. Anything bigger
// than this is skipped rather than pulled into memory.
const TEXT_FILE_EXT = /\.(js|mjs|cjs|jsx|ts|tsx|vue|svelte|py|java|go|rb|php|cs|json|md|ya?ml|sql|html?|css|scss|sass|less|proto|csv|txt|env|example|sh)$/i;
const MAX_SCAN_FILE_BYTES = 512 * 1024;

const MANIFEST_FILENAMES = new Set([
  'package.json',
  'requirements.txt',
  'pyproject.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'composer.json',
  'cargo.toml',
  'docker-compose.yml',
  'docker-compose.yaml',
  '.env.example',
  'openapi.yaml',
  'openapi.yml',
  'openapi.json',
]);

module.exports = {
  MAX_TOKENS,
  MAX_TURNS,
  KEY_CYCLE_PAUSE_MS,
  RUN_BASH_BUDGET,
  RUN_BASH_TIMEOUT_MS,
  RUN_BASH_MAX_OUTPUT_CHARS,
  PREVIEW_CHARS,
  WORKDIR,
  PROJECT_DIR,
  MAX_COMPLETION_REJECTIONS,
  SMOKE_TEST_ENABLED,
  MAX_SMOKE_ATTEMPTS,
  SMOKE_INSTALL_TIMEOUT_MS,
  SMOKE_BOOT_TIMEOUT_MS,
  SMOKE_PROBE_ATTEMPTS,
  SMOKE_PROBE_INTERVAL_MS,
  SMOKE_CLI_TIMEOUT_MS,
  SMOKE_OUTPUT_CHARS,
  KEEP_FULL_TOOL_RESULTS_FOR_LAST_N_MESSAGES,
  ELIDED_RESULT_MAX_CHARS,
  INPUT_ARTIFACTS,
  MAX_TREE_LINES,
  CONSOLE_TREE_LINES,
  MAX_MANIFEST_CHARS,
  MAX_LINE_COUNT_BYTES,
  MAX_PLAN_COMPONENTS,
  MAX_PLAN_DELIVERABLES,
  MAX_PLAN_USE_CASES,
  ROLE_SUFFIXES,
  LAYER_SUFFIXES,
  LOGICAL_SUFFIXES,
  NAME_STOPWORDS,
  GENERIC_NAMES,
  NON_COMPONENT_WORDS,
  QUALITY_WORDS,
  KNOWN_FILE_EXT,
  NAMED_FILES,
  SURFACE_KINDS,
  DESKTOP_SHELL_REQUIRED,
  DESKTOP_SHELL_ENTRY,
  DESKTOP_SHELL_SCRIPT,
  DESKTOP_SHELL_SIGNATURE,
  DESKTOP_SHELL_LOAD_SIGNATURE,
  MIN_UI_SOURCE_FILES,
  MIN_UI_SOURCE_FILES_MULTI_SCREEN,
  MULTI_SCREEN_USE_CASES,
  MAX_SINGLE_HTML_BYTES,
  MAX_INLINE_SCRIPT_BYTES,
  MIN_BACKEND_ROUTES_TO_CROSS_CHECK,
  STATIC_ASSET_EXT,
  UI_DIR,
  SERVER_SIGNATURE,
  TEXT_FILE_EXT,
  MAX_SCAN_FILE_BYTES,
  MANIFEST_FILENAMES,
};
