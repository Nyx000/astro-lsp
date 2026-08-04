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
if (serverFlag !== -1 && !process.argv[serverFlag + 1]) {
  console.error('usage: --server needs a path to nodeServer.js');
  process.exit(1);
}
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

// Walk for a .astro file, preferring one with a frontmatter import — that gives
// an identifier to hover. Stops at the first such file instead of collecting
// every match, so a large project doesn't pay for a full-tree scan.
function findAstroTarget(dir) {
  let fallback = null;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(cur, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!e.name.endsWith('.astro')) continue;
      if (/^---[\s\S]*?import\s/m.test(fs.readFileSync(p, 'utf8'))) return p;
      if (!fallback) fallback = p;
    }
  }
  return fallback;
}

const TARGET = findAstroTarget(ROOT);
if (!TARGET) {
  console.error('FAIL: no .astro files found under ' + ROOT);
  process.exit(1);
}
const text = fs.readFileSync(TARGET, 'utf8');

const child = spawn(process.execPath, [SERVER, '--stdio'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: ROOT, // this is what `workspaceFolder` produces at runtime
});

let buf = Buffer.alloc(0);
const pending = new Map();
const diagnostics = [];
let nextId = 1;
let stderrTail = '';

child.stdout.on('data', (d) => { buf = Buffer.concat([buf, d]); drain(); });
// Keep the last of stderr rather than discarding it — when an assertion fails,
// the server's own complaint is the first thing worth seeing.
child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString('utf8')).slice(-2000); });
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

// Frame on the Buffer, never on a decoded string. Content-Length is a BYTE
// count, and decoding a buffer that ends mid-UTF-8-sequence yields U+FFFD —
// re-encoding that loses the original bytes, so any message left in the
// remainder after a complete one is consumed comes back corrupt.
function drain() {
  for (;;) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep < 0) return;
    const header = buf.slice(0, sep).toString('ascii');
    const m = /Content-Length: (\d+)/i.exec(header);
    if (!m) { buf = buf.slice(sep + 4); continue; } // unframeable header; skip it
    const len = parseInt(m[1], 10);
    if (buf.length < sep + 4 + len) return;
    const payload = buf.slice(sep + 4, sep + 4 + len).toString('utf8');
    buf = buf.slice(sep + 4 + len);
    let msg;
    try { msg = JSON.parse(payload); } catch { continue; }
    if (msg.method) {
      // A message carrying `method` is a request or notification from the
      // server, never a response. Test this BEFORE looking in `pending`: the
      // server numbers its own requests from 0, so its ids collide with ours
      // (confirmed: client/registerCapability id 0, workspace/configuration id 1).
      if (msg.method === 'textDocument/publishDiagnostics') diagnostics.push(msg.params);
      if (msg.id !== undefined) {
        raw({
          jsonrpc: '2.0',
          id: msg.id,
          result: msg.method === 'workspace/configuration' ? (msg.params.items || []).map(() => ({})) : null,
        });
      }
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((r) => setTimeout(() => r({ TIMEOUT: label }), ms))]);

// Poll until `check()` returns something truthy, or the cap elapses. Replaces
// fixed sleeps: Volar's project build and its diagnostic pass both finish well
// inside the old budgets, so waiting on the actual signal is faster and the cap
// still bounds a genuinely stuck server.
async function waitFor(check, capMs, stepMs = 250) {
  const deadline = Date.now() + capMs;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await sleep(stepMs);
  }
}

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

  // Assertion 2: hover on a frontmatter import identifier returns a type.
  // Retry rather than sleeping a flat 8s for Volar to build the project — an
  // empty hover is exactly the signal that the build isn't ready yet.
  const importSites = [];
  text.split('\n').forEach((line, i) => {
    const m = line.match(/import\s+\{?\s*([A-Za-z_$][\w$]*)/);
    if (m) importSites.push({ line: i, character: line.indexOf(m[1]) + 1 });
  });
  const hovered = await waitFor(async () => {
    for (const position of importSites) {
      const h = await withTimeout(send('textDocument/hover', { textDocument: { uri }, position }), 15000, 'hover');
      if (h.result && h.result.contents) return JSON.stringify(h.result.contents);
    }
    return null;
  }, 25000, 500);
  assert('hover on a frontmatter import returns type information',
    !!hovered,
    hovered ? hovered.slice(0, 90).replace(/\s+/g, ' ') : 'no hover content');

  // Assertion 3: an injected type error produces a diagnostic.
  diagnostics.length = 0;
  notify('textDocument/didChange', {
    textDocument: { uri, version: 2 },
    contentChanges: [{ text: text + '\n<script>const __probe: number = "not a number";</script>\n' }],
  });
  const hit = await waitFor(
    async () => diagnostics.find((p) => p.diagnostics.some((d) => /not assignable/i.test(d.message))),
    20000);
  const latest = hit || diagnostics[diagnostics.length - 1];
  assert('injected type error produces a diagnostic',
    !!hit,
    latest ? latest.diagnostics.length + ' diagnostic(s)' : 'none received');

  done();
})();

function done() {
  const failed = results.filter((r) => !r.ok).length;
  console.log('\n' + (failed ? failed + ' of ' + results.length + ' assertions FAILED' : 'all ' + results.length + ' assertions passed'));
  if (failed && stderrTail.trim()) console.error('\n--- server stderr (last 2KB) ---\n' + stderrTail.trim());
  try { child.kill(); } catch {}
  process.exit(failed ? 1 : 0);
}

setTimeout(() => {
  console.error('FAIL: hard timeout (90s)');
  if (stderrTail.trim()) console.error('\n--- server stderr (last 2KB) ---\n' + stderrTail.trim());
  try { child.kill(); } catch {}
  process.exit(1);
}, 90000);
