/**
 * ClaudeMonkey sidebar: the live "Claude is working" view.
 *
 * Renders the current job as a readable transcript (your request, tool-use
 * chips, Claude's narration), then the resulting userscript with an Apply
 * button and a follow-up box to keep refining in the same conversation.
 *
 * It re-pulls full state via `AIGetState` whenever an `AIEvent` arrives, so
 * reopening the sidebar mid-run simply replays everything accumulated so far.
 */
import '@/common/browser';
import { sendCmdDirectly } from '@/common';

const root = document.body;
root.style.cssText = 'margin:0;font:13px/1.5 system-ui,sans-serif;color:#202124;background:#f6f7f9;height:100vh;display:flex;flex-direction:column;user-select:text;-webkit-user-select:text';
// Make transcript/result text selectable so it can be copied, but keep the buttons
// behaving like buttons (no accidental text selection on click).
const selStyle = document.createElement('style');
selStyle.textContent = 'button{user-select:none;-webkit-user-select:none}';
document.head.appendChild(selStyle);
root.innerHTML = `
  <div style="padding:10px 12px;border-bottom:1px solid #e0e0e0;background:#fff;display:flex;align-items:center;gap:8px">
    <div style="font-weight:600">ClaudeMonkey</div>
    <div id="cm-status" style="color:#5f6368;font-size:12px;margin-left:auto"></div>
  </div>
  <div id="cm-log" style="flex:1;overflow:auto;padding:12px"></div>
  <div id="cm-result" style="border-top:1px solid #e0e0e0;background:#fff"></div>
  <div style="border-top:1px solid #e0e0e0;background:#fff;padding:8px 10px">
    <textarea id="cm-followup" rows="2" placeholder="Refine further… (Ctrl/Cmd+Enter)"
      style="width:100%;box-sizing:border-box;resize:vertical;padding:6px;border:1px solid #dadce0;border-radius:6px;font:inherit"></textarea>
    <button id="cm-send" style="margin-top:6px;width:100%;padding:7px;border:0;border-radius:6px;background:#1a73e8;color:#fff;font:inherit;font-weight:600;cursor:pointer">Send</button>
  </div>`;

const $ = id => document.getElementById(id);
const logEl = $('cm-log');
const statusEl = $('cm-status');
const resultEl = $('cm-result');
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function render(job) {
  if (!job) {
    statusEl.textContent = '';
    logEl.innerHTML = `<div style="color:#80868b">No active request. Open the toolbar popup and describe a change.</div>`;
    resultEl.innerHTML = '';
    return;
  }
  const running = job.status === 'running';
  statusEl.innerHTML = running
    ? `<span style="color:#1a73e8">● working on ${esc(job.domain)}…</span>`
    : job.status === 'error'
      ? `<span style="color:#d32f2f">● error</span>`
      : `<span style="color:#188038">● done${job.cost ? ` · $${job.cost.toFixed(3)}` : ''}</span>`;

  logEl.innerHTML = (job.events || []).map(ev => {
    if (ev.type === 'user') {
      return `<div style="background:#e8f0fe;border-radius:8px;padding:8px 10px;margin:0 0 10px auto;max-width:90%;width:fit-content">${esc(ev.text)}</div>`;
    }
    if (ev.type === 'tool') {
      return `<div style="display:inline-block;background:#fff;border:1px solid #e0e0e0;border-radius:12px;padding:3px 10px;margin:0 0 8px;color:#5f6368;font-size:12px">⚙ ${esc(ev.summary || ev.name)}</div><div></div>`;
    }
    if (ev.type === 'narration') {
      return `<div style="background:#fff;border:1px solid #ececec;border-radius:8px;padding:8px 10px;margin:0 0 10px;max-width:95%;white-space:pre-wrap;word-break:break-word">${esc(ev.text)}</div>`;
    }
    return '';
  }).join('');
  if (job.error) {
    logEl.innerHTML += `<div style="background:#fce8e6;color:#c5221f;border-radius:8px;padding:8px 10px;margin-top:8px;white-space:pre-wrap">${esc(job.error)}</div>`;
  }
  logEl.scrollTop = logEl.scrollHeight;

  if (job.script && job.status !== 'running') {
    resultEl.innerHTML = `
      <div style="padding:8px 10px 0;display:flex;align-items:center;gap:8px">
        <div style="font-weight:600;font-size:12px">Resulting userscript</div>
        <button id="cm-apply" style="margin-left:auto;padding:6px 12px;border:0;border-radius:6px;background:#188038;color:#fff;font:inherit;font-weight:600;cursor:pointer">Apply &amp; reload</button>
      </div>
      <pre id="cm-code" style="margin:8px 10px 10px;max-height:340px;overflow:auto;background:#1e1e1e;color:#d4d4d4;padding:10px;border-radius:6px;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre;tab-size:2;-moz-tab-size:2">${esc(job.script)}</pre>`;
    $('cm-apply').addEventListener('click', async () => {
      const btn = $('cm-apply');
      btn.disabled = true; btn.textContent = 'Applying…';
      try {
        await sendCmdDirectly('ParseScript', { code: job.script, url: job.url, reloadTab: true });
        btn.textContent = 'Applied ✓';
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Apply & reload';
        statusEl.innerHTML = `<span style="color:#d32f2f">apply failed: ${esc(e)}</span>`;
      }
    });
  } else {
    resultEl.innerHTML = '';
  }
}

async function refresh() {
  try {
    render(await sendCmdDirectly('AIGetState'));
  } catch (e) {
    statusEl.textContent = String(e);
  }
}

browser.runtime.onMessage.addListener(msg => {
  if (msg && msg.cmd === 'AIEvent') refresh();
});

async function sendFollowup() {
  const el = $('cm-followup');
  const prompt = el.value.trim();
  if (!prompt) return;
  el.value = '';
  try {
    await sendCmdDirectly('AIGenerate', { prompt });
    refresh();
  } catch (e) {
    statusEl.innerHTML = `<span style="color:#d32f2f">${esc(e)}</span>`;
  }
}
$('cm-send').addEventListener('click', sendFollowup);
$('cm-followup').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendFollowup(); }
});

refresh();
