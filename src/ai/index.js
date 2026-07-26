/**
 * ClaudeMonkey toolbar popup: a compact textbox where you describe how you want
 * the current site changed. Submitting opens the sidebar (the live working view)
 * and kicks off a background job; the popup then closes.
 */
import '@/common/browser';
import { sendCmdDirectly } from '@/common';

const root = document.body;
root.style.cssText = 'margin:0;width:340px;font:13px/1.45 system-ui,sans-serif;color:#202124;background:#fff';
root.innerHTML = `
  <div style="padding:12px 14px">
    <div style="font-weight:600;font-size:14px;margin-bottom:2px">ClaudeMonkey</div>
    <div id="cm-site" style="color:#5f6368;font-size:12px;margin-bottom:10px">…</div>
    <textarea id="cm-prompt" rows="4" placeholder="Describe how you want this site changed&#10;e.g. hide the sidebar and widen the article"
      style="width:100%;box-sizing:border-box;resize:vertical;padding:8px;border:1px solid #dadce0;border-radius:6px;font:inherit"></textarea>
    <div id="cm-error" style="color:#d32f2f;font-size:12px;margin-top:6px;display:none"></div>
    <div style="display:flex;gap:8px;align-items:center;margin-top:10px">
      <button id="cm-go" style="flex:1;padding:8px 10px;border:0;border-radius:6px;background:#1a73e8;color:#fff;font:inherit;font-weight:600;cursor:pointer">Ask Claude</button>
      <a id="cm-dash" href="#" style="font-size:12px;color:#1a73e8;text-decoration:none">Manage scripts</a>
    </div>
    <div style="color:#80868b;font-size:11px;margin-top:8px">Claude writes the userscript locally via your subscription. Progress shows in the sidebar.</div>
  </div>`;

const $ = id => document.getElementById(id);
const promptEl = $('cm-prompt');
const errEl = $('cm-error');

(async () => {
  try {
    const tab = (await browser.tabs.query({ active: true, currentWindow: true }))[0];
    const host = tab && tab.url && /^https?:/.test(tab.url) ? new URL(tab.url).hostname : null;
    $('cm-site').textContent = host ? `Editing ${host}` : 'Open an http(s) page to use ClaudeMonkey';
    if (!host) { $('cm-go').disabled = true; $('cm-go').style.background = '#9aa0a6'; }
  } catch { /* ignore */ }
})();

$('cm-dash').addEventListener('click', e => {
  e.preventDefault();
  browser.runtime.openOptionsPage();
  window.close();
});

function showError(msg) {
  errEl.textContent = msg;
  errEl.style.display = 'block';
}

async function submit() {
  const prompt = promptEl.value.trim();
  if (!prompt) { promptEl.focus(); return; }
  const btn = $('cm-go');
  btn.disabled = true;
  btn.textContent = 'Starting…';
  // Open the sidebar first, while we still have the user gesture.
  try { await browser.sidebarAction.open(); } catch { /* not fatal */ }
  // Wait for the job to be registered before closing. AIGenerate returns as soon as the
  // job exists (capture and generation continue in the background), and until it does
  // this popup is the only place a startup failure can be shown — closing first would
  // hand the error to a window that no longer exists.
  try {
    await sendCmdDirectly('AIGenerate', { prompt });
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Ask Claude';
    showError(String((err && err.message) || err));
    return;
  }
  window.close();
}

$('cm-go').addEventListener('click', submit);
promptEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
});
promptEl.focus();
