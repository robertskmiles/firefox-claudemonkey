/**
 * ClaudeMonkey AI bridge (background side).
 *
 * Owns the native-messaging port to the local `claudemonkey.bridge` host, runs
 * one "generate" job at a time, captures a trimmed DOM snapshot of the active
 * tab, looks up the existing userscript for the site, and broadcasts streamed
 * events (`AIEvent`) to the popup/sidebar UI pages.
 *
 * Generation is a verify loop: Claude writes the userscript, then we install it,
 * reload the active tab so it actually runs, capture any console errors and a
 * fresh DOM snapshot, and resume the same Claude session with that feedback so it
 * can confirm the change worked or fix it — up to MAX_VERIFY_ROUNDS times.
 */
import { sendCmd, getActiveTab } from '@/common';
import { addOwnCommands } from './init';
import storage, { S_CODE } from './storage';
import { getScripts, parseScript } from './db';

const HOST_NAME = 'claudemonkey.bridge';
const NS = 'claudemonkey';

// Verify loop tuning.
const MAX_VERIFY_ROUNDS = 3;   // apply/observe/fix rounds after the initial write
const SETTLE_MS = 1500;        // wait after load for document-idle scripts + dynamic DOM
const LOAD_TIMEOUT_MS = 15000; // give up waiting for a reload to complete
const APPLY_SETTLE_MS = 150;   // let Violentmonkey register the updated script before reload

// External-resource capture tuning. We fetch the page's external CSS/JS so Claude
// can read them when a request needs styling/behaviour context, but cap things so a
// heavy page can't balloon the working dir or the native-messaging payload.
const MAX_ASSETS = 24;                         // most external files we'll fetch
const MAX_ASSET_BYTES = 512 * 1024;            // per-file cap (truncated past this)
const MAX_ASSETS_TOTAL_BYTES = 4 * 1024 * 1024; // combined cap across all assets
const ASSET_FETCH_TIMEOUT_MS = 8000;           // per-file fetch timeout

// Bridge liveness. postMessage to a native host is fire-and-forget, so without these a
// host that never answers is indistinguishable from a slow one. The two pass timeouts sit
// deliberately *above* host.js's own stall watchdog (120s by default) so that when the
// host is alive its more specific diagnostic wins; these only catch a host that isn't
// answering at all.
const BRIDGE_PING_TIMEOUT_MS = 8000;    // host must answer a ping this fast
const PASS_FIRST_EVENT_MS = 150000;     // ...then produce its first event
const PASS_IDLE_TIMEOUT_MS = 600000;    // ...and keep going at least this often

let port;
/** @type {Map<string, object>} requestId -> job */
const jobs = new Map();
/** @type {Map<string, {ok: function, fail: function, timer: *}>} in-flight pings */
const pings = new Map();
/** @type {Map<string, string>} domain -> claude sessionId (conversation memory) */
const sessions = new Map();
let activeRequestId = null;

const delay = ms => new Promise(r => setTimeout(r, ms));

// Snippet executed in the page to capture the DOM. Returns a JSON string (the value
// of the last expression is what executeScript resolves to) with:
//   stripped   - DOM with <style>/<link>/<script>/<svg>/etc. removed (clean for
//                grepping structure and selectors; this is page-dom.html)
//   styled     - DOM that KEEPS inline <style> blocks and <link> tags so Claude can
//                see existing CSS rules when a request involves styling
//   resources  - external CSS/JS URLs to be fetched by the background script
// We deliberately do NOT trim the DOM to a context window: the full snapshot is
// written to disk and Claude greps the regions it needs. The MAX guard only avoids
// pathological multi-megabyte pages (native-host messages allow up to 4 GB).
const CAPTURE_SNIPPET = `(function () {
  var MAX = 2000000;
  function serialize(keepStyles) {
    try {
      var root = document.documentElement.cloneNode(true);
      var sel = keepStyles
        ? 'script,noscript,svg,template,iframe'
        : 'script,style,noscript,svg,link,template,iframe';
      root.querySelectorAll(sel).forEach(function (n) { n.remove(); });
      var html = root.outerHTML || '';
      if (html.length > MAX) html = html.slice(0, MAX) + '\\n<!-- ClaudeMonkey: DOM exceeded ' + MAX + ' chars and was truncated here; narrow your search -->';
      return html;
    } catch (e) { return ''; }
  }
  var resources = [];
  try {
    document.querySelectorAll('link[rel~="stylesheet"][href]').forEach(function (n) {
      if (n.href) resources.push({ type: 'css', url: n.href });
    });
    document.querySelectorAll('script[src]').forEach(function (n) {
      if (n.src) resources.push({ type: 'js', url: n.src });
    });
  } catch (e) {}
  return JSON.stringify({ stripped: serialize(false), styled: serialize(true), resources: resources });
})()`;

// Injected at document_start (before the userscript runs) to record uncaught
// errors for the upcoming page load into sessionStorage, where we read them back
// after the page has settled.
const ERROR_COLLECTOR_CODE = `(function () {
  try {
    var KEY = '__cmErrors';
    try { sessionStorage.setItem(KEY, '[]'); } catch (e) {}
    function push(o) {
      try {
        var a = JSON.parse(sessionStorage.getItem(KEY) || '[]');
        a.push(o);
        sessionStorage.setItem(KEY, JSON.stringify(a.slice(-50)));
      } catch (e) {}
    }
    window.addEventListener('error', function (ev) {
      push({ type: 'error', message: (ev && (ev.message || (ev.error && ev.error.message))) || 'error', file: ev && ev.filename, line: ev && ev.lineno });
    }, true);
    window.addEventListener('unhandledrejection', function (ev) {
      push({ type: 'unhandledrejection', message: String((ev && ev.reason && (ev.reason.message || ev.reason)) || 'rejection') });
    });
  } catch (e) {}
})()`;

// Reads back the captured errors plus a fresh DOM snapshot once the script has run.
const READ_OBSERVATION_SNIPPET = `(function () {
  var errors = [];
  try { errors = JSON.parse(sessionStorage.getItem('__cmErrors') || '[]'); } catch (e) {}
  var MAX = 2000000;
  function serialize(keepStyles) {
    try {
      var root = document.documentElement.cloneNode(true);
      var sel = keepStyles
        ? 'script,noscript,svg,template,iframe'
        : 'script,style,noscript,svg,link,template,iframe';
      root.querySelectorAll(sel).forEach(function (n) { n.remove(); });
      var html = root.outerHTML || '';
      if (html.length > MAX) html = html.slice(0, MAX) + '\\n<!-- ClaudeMonkey: DOM truncated; narrow your search -->';
      return html;
    } catch (e) { return ''; }
  }
  return JSON.stringify({ errors: errors, dom: serialize(false), domStyled: serialize(true) });
})()`;

function ensurePort() {
  if (port) return port;
  port = browser.runtime.connectNative(HOST_NAME);
  port.onMessage.addListener(onPortMessage);
  port.onDisconnect.addListener(() => {
    const err = browser.runtime.lastError;
    const emsg = (err && err.message) || 'Native bridge disconnected. Is it installed? See bridge/install.sh';
    // Unblock any pass waiting on `done`, and fail any still-running jobs.
    for (const job of jobs.values()) {
      const resolve = job._resolveDone;
      job._resolveDone = null;
      if (resolve) { resolve({ error: emsg }); continue; }
      if (job.status === 'running') {
        job.status = 'error';
        job.error = emsg;
        broadcast(job, { type: 'done', error: job.error });
      }
    }
    for (const p of [...pings.values()]) p.fail(new Error(emsg));
    port = null;
  });
  return port;
}

/**
 * Ask the host to identify itself before sending it a request. A dead or unreachable
 * host is otherwise indistinguishable from a slow one: `postMessage` is fire-and-forget,
 * so without this a host that never answers just leaves the sidebar spinning. The reply
 * also reports which `claude` binary and profile the host resolved, which is worth
 * showing — it's the #1 thing that differs between your shell and Firefox's environment.
 */
function pingBridge() {
  return new Promise((resolve, reject) => {
    const id = `ping-${Date.now()}-${Math.random()}`;
    const entry = {
      ok: msg => { clearTimeout(entry.timer); pings.delete(id); resolve(msg); },
      fail: err => { clearTimeout(entry.timer); pings.delete(id); reject(err); },
      timer: null,
    };
    entry.timer = setTimeout(() => {
      entry.fail(new Error(
        `The native bridge did not respond within ${Math.round(BRIDGE_PING_TIMEOUT_MS / 1000)}s.`
        + ' The host manifest is registered (or connecting would have failed outright), so'
        + ' the host process is likely starting and dying, or never starting. Check that'
        + ' the path in claudemonkey.bridge.json exists and is executable, and that `node`'
        + " is on the PATH Firefox itself inherits — a GUI-launched Firefox doesn't see"
        + ' your shell profile, so a Homebrew/nvm/nix node is typically missing. Re-run'
        + ' bridge/install.sh: it now pins an absolute node path, which fixes that case.'));
    }, BRIDGE_PING_TIMEOUT_MS);
    pings.set(id, entry);
    try {
      ensurePort().postMessage({ type: 'ping', requestId: id });
    } catch (e) {
      entry.fail(e);
    }
  });
}

function broadcast(job, event) {
  sendCmd('AIEvent', { requestId: job.requestId, domain: job.domain, status: job.status, event });
}

function onPortMessage(msg) {
  const ping = msg && msg.type === 'pong' && pings.get(msg.requestId);
  if (ping) { ping.ok(msg); return; }
  const job = msg && jobs.get(msg.requestId);
  if (!job) return;
  // Any traffic for this job means the host is alive and working: hold off the watchdog.
  if (job._bumpPass) job._bumpPass();
  switch (msg.type) {
    case 'session':
      if (msg.sessionId) {
        job.sessionId = msg.sessionId;
        sessions.set(job.domain, msg.sessionId);
      }
      break;
    case 'narration':
      job.events.push({ type: 'narration', text: msg.text });
      break;
    case 'tool':
      job.events.push({ type: 'tool', name: msg.name, summary: msg.summary });
      break;
    case 'done': {
      // End of one Claude pass. Accumulate its output and hand control back to the
      // verify loop, which decides whether to apply/test/resume or finalize.
      job.script = msg.script || job.script;
      job.cost = (job.cost || 0) + (msg.cost || 0);
      if (msg.summary) job.events.push({ type: 'narration', text: msg.summary });
      const resolve = job._resolveDone;
      job._resolveDone = null;
      if (resolve) {
        broadcast(job, { type: 'progress' });
        resolve(msg);
        return;
      }
      // No loop waiting (shouldn't normally happen): finalize directly.
      job.status = msg.error ? 'error' : 'done';
      job.error = msg.error || null;
      break;
    }
    default:
      return;
  }
  broadcast(job, msg);
}

function findScript(domain) {
  for (const s of getScripts()) {
    if (s.config?.removed) continue;
    if (s.meta?.namespace === NS && s.meta?.name === `ClaudeMonkey - ${domain}`) return s;
  }
  return null;
}

async function getCurrentCode(domain) {
  const s = findScript(domain);
  if (!s) return '';
  try {
    return (await storage[S_CODE].getOne(s.props.id)) || '';
  } catch {
    return '';
  }
}

/**
 * Capture both DOM variants for the tab, fetch the page's external CSS/JS, and grab
 * a viewport screenshot so Claude has them on disk if a request needs styling/
 * behaviour/visual context.
 * @return {Promise<{domSnapshot: string, domSnapshotStyled: string, assets: object[], screenshot: string}>}
 */
async function captureContext(tab) {
  let parsed = { stripped: '', styled: '', resources: [] };
  try {
    const res = await browser.tabs.executeScript(tab.id, { code: CAPTURE_SNIPPET });
    const raw = (Array.isArray(res) ? res[0] : res) || '';
    parsed = JSON.parse(raw) || parsed;
  } catch { /* keep empty defaults */ }
  const [assets, screenshot] = await Promise.all([
    fetchAssets(parsed.resources || []),
    captureScreenshot(tab.windowId),
  ]);
  return {
    domSnapshot: parsed.stripped || '',
    domSnapshotStyled: parsed.styled || '',
    assets,
    screenshot,
  };
}

/** Capture a PNG screenshot of the visible tab; returns base64 (no data: prefix) or ''. */
async function captureScreenshot(windowId) {
  try {
    const dataUrl = await browser.tabs.captureVisibleTab(
      windowId != null ? windowId : undefined,
      { format: 'png' },
    );
    if (typeof dataUrl !== 'string') return '';
    const comma = dataUrl.indexOf(',');
    return comma >= 0 ? dataUrl.slice(comma + 1) : '';
  } catch {
    return '';
  }
}

/** Fetch external resources (deduped + capped) from the background page. */
async function fetchAssets(resources) {
  const seen = new Set();
  const list = [];
  for (const r of resources) {
    if (!r || !r.url || seen.has(r.url) || !/^https?:/i.test(r.url)) continue;
    seen.add(r.url);
    list.push(r);
    if (list.length >= MAX_ASSETS) break;
  }
  // Fetch in parallel, then fold into the output sequentially so filenames and the
  // shared byte budget are applied deterministically.
  const fetched = await Promise.all(list.map(r => fetchText(r.url).then(
    content => ({ r, content }),
    e => ({ r, error: String((e && e.message) || e) }),
  )));

  const out = [];
  let total = 0;
  fetched.forEach(({ r, content, error }, i) => {
    const name = assetName(r, i);
    if (content == null) {
      out.push({ name, url: r.url, type: r.type, error: error || 'fetch failed' });
      return;
    }
    let truncated = false;
    if (content.length > MAX_ASSET_BYTES) { content = content.slice(0, MAX_ASSET_BYTES); truncated = true; }
    if (total + content.length > MAX_ASSETS_TOTAL_BYTES) {
      out.push({ name, url: r.url, type: r.type, error: 'skipped (total asset budget exceeded)' });
      return;
    }
    total += content.length;
    out.push({ name, url: r.url, type: r.type, content, truncated });
  });
  return out;
}

function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ASSET_FETCH_TIMEOUT_MS);
  return fetch(url, { credentials: 'omit', signal: ctrl.signal })
    .then(resp => {
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp.text();
    })
    .finally(() => clearTimeout(timer));
}

/** Derive a safe, unique-by-index local filename for a fetched asset. */
function assetName(r, i) {
  let base = 'asset';
  try {
    const u = new URL(r.url);
    base = u.pathname.split('/').pop() || u.hostname || 'asset';
  } catch { /* use default */ }
  base = base.replace(/[?#].*$/, '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60) || 'asset';
  if (!/\.(css|js|mjs)$/i.test(base)) base += r.type === 'css' ? '.css' : '.js';
  return `${String(i + 1).padStart(2, '0')}-${base}`;
}

addOwnCommands({
  /** Start (or continue) a generation for the active tab. @return {Promise<object>} job header */
  async AIGenerate({ prompt } = {}) {
    const tab = await getActiveTab();
    if (!tab || !tab.url || !/^https?:/.test(tab.url)) {
      throw 'ClaudeMonkey only works on http(s) pages.';
    }
    const url = tab.url;
    let domain;
    try { domain = new URL(url).hostname; } catch { domain = 'unknown'; }

    const requestId = (crypto.randomUUID && crypto.randomUUID()) || `r${Date.now()}-${Math.random()}`;
    const job = {
      requestId,
      domain,
      url,
      tabId: tab.id,
      windowId: tab.windowId,
      prompt,
      status: 'running',
      events: [{ type: 'user', text: prompt }],
      script: null,
      sessionId: sessions.get(domain) || null,
      error: null,
      cost: 0,
      _resolveDone: null,
    };
    // Register and publish the job BEFORE any of the fallible work below. The sidebar
    // renders whatever job exists, so a job that doesn't exist yet is indistinguishable
    // from one that is still working — and the popup, our only other error channel,
    // closes itself moments after calling us. Anything that goes wrong from here on
    // lands on the job and is therefore visible.
    jobs.set(requestId, job);
    activeRequestId = requestId;
    broadcast(job, { type: 'progress' });

    // Page capture + the write -> apply -> observe -> fix loop run in the background;
    // the command returns immediately and the UI follows along via broadcast AIEvents.
    (async () => {
      const currentScript = await getCurrentCode(domain);
      job.script = currentScript || null;
      broadcastNote(job, `Capturing ${domain}…`);
      const context = await captureContext(tab);
      broadcastNote(job, `Done capturing ${domain}.`);
      await runVerifyLoop(job, { prompt, context, currentScript });
    })().catch(e => {
      finalize(job, { error: String((e && (e.stack || e.message)) || e) });
    });

    return jobHeader(job);
  },

  /** Snapshot of the active/most-recent job for the sidebar to render on open. */
  AIGetState() {
    const job = activeRequestId && jobs.get(activeRequestId);
    return job ? fullJob(job) : null;
  },
});

// ---------------------------------------------------------------------------
// Verify loop
// ---------------------------------------------------------------------------

/** Send one generate request and resolve with the bridge's `done` message. */
function runPass(job, { prompt, domSnapshot, domSnapshotStyled, assets, screenshot, currentScript, sessionId }) {
  return new Promise(resolve => {
    let timer;
    const settle = res => {
      clearTimeout(timer);
      job._bumpPass = null;
      job._resolveDone = null;
      resolve(res);
    };
    const arm = (ms, why) => {
      clearTimeout(timer);
      timer = setTimeout(() => settle({ error: why }), ms);
    };
    job._resolveDone = settle;
    job._bumpPass = () => arm(PASS_IDLE_TIMEOUT_MS,
      `The bridge went quiet for ${Math.round(PASS_IDLE_TIMEOUT_MS / 60000)} minutes mid-run.`);
    arm(PASS_FIRST_EVENT_MS,
      `The bridge accepted the request but sent nothing back within`
      + ` ${Math.round(PASS_FIRST_EVENT_MS / 1000)}s — not even the stall report host.js`
      + ' makes when claude itself is wedged, so the host process is probably not'
      + ' handling messages. Run `node bridge/test-client.js "test" example.com` to'
      + ' exercise the same path outside Firefox.');

    const payload = {
      type: 'generate',
      requestId: job.requestId,
      domain: job.domain,
      url: job.url,
      prompt,
      domSnapshot,
      domSnapshotStyled,
      assets,
      screenshot,
      currentScript,
      sessionId: sessionId || null,
    };
    // Page context can run to many megabytes; report it, since an oversized message is
    // one of the few ways postMessage can fail without any error reaching us.
    const mb = (() => {
      try { return JSON.stringify(payload).length / 1048576; } catch { return 0; }
    })();
    broadcastNote(job, `Sending ${mb.toFixed(1)} MB of page context to Claude…`);
    try {
      ensurePort().postMessage(payload);
    } catch (e) {
      settle({ error: `Could not send the request to the bridge: ${(e && e.message) || e}` });
    }
  });
}

async function runVerifyLoop(job, { prompt, context, currentScript }) {
  // Pass 0: write/edit the userscript from the initial snapshot. This pass carries
  // the fetched asset *content*; the host writes those files to disk once. Later
  // verify rounds resend only asset metadata (name/url) so the manifest persists
  // without re-fetching unchanged external files every reload.
  const assetsMeta = (context.assets || []).map(
    ({ name, url, type, truncated, error }) => ({ name, url, type, truncated, error }),
  );
  // Confirm the host is actually there and see which claude it resolved, before handing
  // it a multi-megabyte request. A failure here throws and is reported by the caller.
  const pong = await pingBridge();
  broadcastNote(job, `Bridge ready — claude: ${pong.claudeBin || '(default)'}`
    + `${pong.claudeConfigDir ? `, profile: ${pong.claudeConfigDir}` : ''}`);

  let res = await runPass(job, {
    prompt,
    domSnapshot: context.domSnapshot,
    domSnapshotStyled: context.domSnapshotStyled,
    assets: context.assets,
    screenshot: context.screenshot,
    currentScript,
    sessionId: job.sessionId,
  });
  if (res.error) return finalize(job, res);
  if (!job.script) return finalize(job, res); // nothing to test

  for (let round = 1; round <= MAX_VERIFY_ROUNDS; round++) {
    broadcastNote(job, `Installing the script and reloading ${job.domain} to test it (round ${round}/${MAX_VERIFY_ROUNDS})…`);
    const obs = await applyAndObserve(job);
    broadcastObservation(job, obs);

    res = await runPass(job, {
      prompt: buildFeedbackPrompt(obs),
      domSnapshot: obs.domSnapshot,
      domSnapshotStyled: obs.domSnapshotStyled,
      assets: assetsMeta,
      screenshot: obs.screenshot,
      currentScript: job.script,
      sessionId: job.sessionId,
    });
    if (res.error) return finalize(job, res);
    if (!res.sawEdit) break; // Claude changed nothing -> it considers the script correct.
  }
  finalize(job, res);
}

/** Install the current script, reload the tab, and capture errors + fresh DOM. */
async function applyAndObserve(job) {
  const code = job.script || '';
  const errors = [];
  let dom = '';
  let domStyled = '';
  let screenshot = '';
  let reg;
  try { reg = await registerErrorCollector(job.url); } catch { /* best effort */ }
  try {
    await parseScript({ [S_CODE]: code, url: job.url, reloadTab: false });
    await delay(APPLY_SETTLE_MS);
  } catch (e) {
    errors.push({ type: 'install', message: `Userscript failed to install: ${e}` });
  }
  try {
    await reloadAndWait(job.tabId);
    await delay(SETTLE_MS);
    const out = await readObservation(job.tabId);
    if (out && Array.isArray(out.errors)) errors.push(...out.errors);
    dom = (out && out.dom) || '';
    domStyled = (out && out.domStyled) || '';
    screenshot = await captureScreenshot(job.windowId);
  } catch (e) {
    errors.push({ type: 'observe', message: String(e) });
  } finally {
    if (reg) { try { await reg.unregister(); } catch { /* ignore */ } }
  }
  return { errors, domSnapshot: dom, domSnapshotStyled: domStyled, screenshot };
}

function registerErrorCollector(url) {
  return browser.contentScripts.register({
    matches: [originMatchPattern(url)],
    js: [{ code: ERROR_COLLECTOR_CODE }],
    runAt: 'document_start',
    allFrames: false,
  });
}

function originMatchPattern(url) {
  try { const u = new URL(url); return `${u.protocol}//${u.host}/*`; } catch { return '<all_urls>'; }
}

function reloadAndWait(tabId) {
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      browser.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve();
    };
    const onUpdated = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    browser.tabs.onUpdated.addListener(onUpdated);
    const timer = setTimeout(finish, LOAD_TIMEOUT_MS);
    Promise.resolve(browser.tabs.reload(tabId)).catch(finish);
  });
}

async function readObservation(tabId) {
  try {
    const res = await browser.tabs.executeScript(tabId, { code: READ_OBSERVATION_SNIPPET });
    const raw = Array.isArray(res) ? res[0] : res;
    return JSON.parse(raw || '{}');
  } catch (e) {
    return { errors: [{ type: 'observe', message: `Could not read the page after reload: ${e}` }], dom: '' };
  }
}

function buildFeedbackPrompt(obs) {
  const errs = (obs.errors && obs.errors.length)
    ? obs.errors.map(e => `- [${e.type}] ${e.message}${e.file ? ` (${e.file}:${e.line ?? '?'})` : ''}`).join('\n')
    : '(no console errors or uncaught exceptions detected)';
  return [
    'Your userscript was installed and the page was RELOADED, so it has now actually run in the browser.',
    '',
    'Errors captured during that run:',
    errs,
    '',
    'page-dom.html and page-context.md have been refreshed to the DOM as it looks NOW, after your script ran. Grep page-dom.html to verify your intended change is actually present and correct (e.g. the element you added or modified exists with the expected text/attributes/styles).',
    '',
    'If the original request is now fully satisfied AND your script caused no errors, reply with exactly DONE and make no further edits. Otherwise, fix userscript.user.js and briefly say what you changed.',
  ].join('\n');
}

async function finalize(job, res) {
  job._resolveDone = null;
  if (res && res.error) {
    job.status = 'error';
    job.error = res.error;
  } else {
    job.status = 'done';
    job.error = null;
    // Ensure the converged script is the one actually installed and live.
    try { await parseScript({ [S_CODE]: job.script || '', url: job.url, reloadTab: true }); } catch { /* leave last-applied */ }
  }
  broadcast(job, { type: 'done', error: job.error, script: job.script });
}

function broadcastNote(job, text) {
  job.events.push({ type: 'narration', text });
  broadcast(job, { type: 'narration', text });
}

function broadcastObservation(job, obs) {
  const n = obs.errors ? obs.errors.length : 0;
  broadcastNote(job, n
    ? `⚠ Detected ${n} error${n === 1 ? '' : 's'} after running the script; feeding them back to Claude.`
    : '✓ No errors detected after running; checking the result against your request.');
}

function jobHeader(job) {
  return { requestId: job.requestId, domain: job.domain, url: job.url, status: job.status };
}

function fullJob(job) {
  return {
    ...jobHeader(job),
    events: job.events,
    script: job.script,
    error: job.error,
    cost: job.cost || 0,
  };
}
