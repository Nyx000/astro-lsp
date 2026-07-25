// Smoke test for the Astro language server under the exact configuration
// .claude-plugin/plugin.json declares: cwd pinned to the project root, and a
// RELATIVE typescript.tsdk that therefore resolves against that cwd.
//
// Usage: node scripts/verify-lsp.js <projectRoot> [--server <path to nodeServer.js>]
// Default server resolution (matches the README's global-install instructions):
// tries the global npm install first (via `npm root -g`), falls back to a
// project-local install under <projectRoot>/node_modules, and only fails if
// neither exists. --server overrides both and is used as-is.
// Exit 0 = all assertions passed.
const { spawn, execSync } = require('child_process');
const { pathToFileURL } = require('url');
const fs = require('fs');
const path = require('path');

const ROOT = (process.argv[2] || '').replace(/\\/g, '/').replace(/\/$/, '');
if (!ROOT) {
  console.error('usage: node scripts/verify-lsp.js <projectRoot> [--server <nodeServer.js>]');
  process.exit(1);
}
// Build file URIs with pathToFileURL, not string concatenation. A POSIX root
// already begins with '/', so 'file:///' + ROOT yields four slashes; and a path
// containing a space needs percent-encoding on every platform.
const ROOT_URI = pathToFileURL(ROOT).href;

function resolveGlobalServer() {
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim().replace(/\\/g, '/');
    return globalRoot ? globalRoot + '/@astrojs/language-server/bin/nodeServer.js' : null;
  } catch {
    return null; // npm not on PATH, or `npm root -g` failed — fall back to project-local.
  }
}

const serverFlag = process.argv.indexOf('--server');
const localServer = ROOT + '/node_modules/@astrojs/language-server/bin/nodeServer.js';
const globalServer = serverFlag === -1 ? resolveGlobalServer() : null;

let SERVER;
if (serverFlag !== -1) {
  SERVER = process.argv[serverFlag + 1].replace(/\\/g, '/');
} else if (globalServer && fs.existsSync(globalServer)) {
  SERVER = globalServer;
} else {
  SERVER = localServer;
}

if (!fs.existsSync(SERVER)) {
  const checked = serverFlag !== -1
    ? SERVER
    : 'global (' + (globalServer || 'npm root -g failed') + ') or project-local (' + localServer + ')';
  console.error('FAIL: language server not found — checked ' + checked);
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, 'node_modules/typescript/lib/typescript.js'))) {
  console.error('FAIL: no local TypeScript at ' + ROOT + '/node_modules/typescript/lib');
  process.exit(1);
}

function findAstroFile(dir) {
  const out = [];
  (function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.astro')) out.push(p);
    }
  })(dir);
  return out;
}

const candidates = findAstroFile(ROOT);
if (!candidates.length) {
  console.error('FAIL: no .astro files found under ' + ROOT);
  process.exit(1);
}
// Prefer a file with a frontmatter import — gives us an identifier to hover.
const TARGET = candidates.find((f) => /^---[\s\S]*?import\s/m.test(fs.readFileSync(f, 'utf8'))) || candidates[0];
const text = fs.readFileSync(TARGET, 'utf8');

const child = spawn(process.execPath, [SERVER, '--stdio'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: ROOT, // this is what `workspaceFolder` produces at runtime
});

let buf = Buffer.alloc(0);
const pending = new Map();
const diagnostics = [];
let nextId = 1;

child.stdout.on('data', (d) => { buf = Buffer.concat([buf, d]); drain(); });
child.stderr.on('data', () => {});
child.on('error', (e) => { console.error('FAIL: could not spawn server: ' + e.message); process.exit(1); });

function raw(obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  child.stdin.write('Content-Length: ' + b.length + '\r\n\r\n');
  child.stdin.write(b);
}
function send(method, params) {
  const id = nextId++;
  raw({ jsonrpc: '2.0', id, method, params });
  return new Promise((r) => pending.set(id, r));
}
function notify(method, params) { raw({ jsonrpc: '2.0', method, params }); }
function drain() {
  for (;;) {
    const s = buf.toString('utf8');
    const m = s.match(/Content-Length: (\d+)\r\n\r\n/);
    if (!m) return;
    const rest = Buffer.from(s.slice(m.index + m[0].length), 'utf8');
    const len = parseInt(m[1], 10);
    if (rest.length < len) return;
    const payload = rest.slice(0, len).toString('utf8');
    buf = rest.slice(len);
    let msg;
    try { msg = JSON.parse(payload); } catch { continue; }
    if (msg.method === 'textDocument/publishDiagnostics') diagnostics.push(msg.params);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.id !== undefined && msg.method) {
      // Server-to-client request. Answer minimally so it does not block.
      raw({
        jsonrpc: '2.0',
        id: msg.id,
        result: msg.method === 'workspace/configuration' ? (msg.params.items || []).map(() => ({})) : null,
      });
    }
  }
}
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((r) => setTimeout(() => r({ TIMEOUT: label }), ms))]);

const results = [];
function assert(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
}

(async () => {
  const init = await withTimeout(send('initialize', {
    processId: process.pid,
    rootUri: ROOT_URI,
    workspaceFolders: [{ uri: ROOT_URI, name: path.basename(ROOT) }],
    initializationOptions: { typescript: { tsdk: 'node_modules/typescript/lib' } },
    capabilities: {
      workspace: { configuration: true },
      textDocument: {
        hover: { contentFormat: ['markdown', 'plaintext'] },
        publishDiagnostics: {},
      },
    },
  }), 30000, 'initialize');

  assert('initialize succeeds with relative tsdk',
    !!(init.result && init.result.capabilities),
    init.error ? init.error.message : (init.TIMEOUT ? 'timed out' : Object.keys(init.result.capabilities).length + ' capabilities'));
  if (!init.result) return done();

  notify('initialized', {});

  const uri = pathToFileURL(TARGET).href;
  notify('textDocument/didOpen', { textDocument: { uri, languageId: 'astro', version: 1, text } });
  await new Promise((r) => setTimeout(r, 8000)); // let Volar build the project

  // Assertion 2: hover on the first frontmatter import identifier returns a type.
  const lines = text.split('\n');
  let hovered = null;
  for (let i = 0; i < lines.length && !hovered; i++) {
    const m = lines[i].match(/import\s+\{?\s*([A-Za-z_$][\w$]*)/);
    if (!m) continue;
    const ch = lines[i].indexOf(m[1]) + 1;
    const h = await withTimeout(send('textDocument/hover', { textDocument: { uri }, position: { line: i, character: ch } }), 15000, 'hover');
    if (h.result && h.result.contents) hovered = JSON.stringify(h.result.contents);
  }
  assert('hover on a frontmatter import returns type information',
    !!hovered,
    hovered ? hovered.slice(0, 90).replace(/\s+/g, ' ') : 'no hover content');

  // Assertion 3: an injected type error produces a diagnostic.
  diagnostics.length = 0;
  notify('textDocument/didChange', {
    textDocument: { uri, version: 2 },
    contentChanges: [{ text: text + '\n<script>const __probe: number = "not a number";</script>\n' }],
  });
  await new Promise((r) => setTimeout(r, 10000));
  const latest = diagnostics[diagnostics.length - 1];
  const hasTypeError = !!(latest && latest.diagnostics.some((d) => /not assignable/i.test(d.message)));
  assert('injected type error produces a diagnostic',
    hasTypeError,
    latest ? latest.diagnostics.length + ' diagnostic(s)' : 'none received');

  done();
})();

function done() {
  const failed = results.filter((r) => !r.ok).length;
  console.log('\n' + (failed ? failed + ' of ' + results.length + ' assertions FAILED' : 'all ' + results.length + ' assertions passed'));
  try { child.kill(); } catch {}
  process.exit(failed ? 1 : 0);
}

setTimeout(() => { console.error('FAIL: hard timeout (90s)'); try { child.kill(); } catch {} process.exit(1); }, 90000);