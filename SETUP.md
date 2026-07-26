# ClaudeMonkey setup & testing

ClaudeMonkey = Violentmonkey's full userscript engine + an AI textbox. You describe a
change to the current site; a local **Claude Code** process writes/edits the userscript,
streaming progress into the Firefox sidebar. It uses your Claude **subscription** (the
bridge strips `ANTHROPIC_API_KEY` so `claude -p` never falls back to a metered API key).

## One-time setup

```bash
pnpm i            # install deps (Node >= 24)
pnpm build        # or `pnpm dev` for a watch build -> dist/
bash bridge/install.sh   # registers the native-messaging host with Firefox
```

`bridge/install.sh` resolves your `claude` binary into `bridge/config.json` and writes
`~/.mozilla/native-messaging-hosts/claudemonkey.bridge.json` (allowlisted to the extension
id `claudemonkey@local`). On macOS the manifest goes to
`~/Library/Application Support/Mozilla/NativeMessagingHosts/` instead. It needs `node` on
PATH (host.js is a Node script) and generates `bridge/host-launcher.sh`, which execs that
exact node against `host.js`; the manifest points at the launcher. This is deliberate:
`#!/usr/bin/env node` resolves against the PATH of whoever launched Firefox, and a
GUI-launched Firefox has a minimal one (`/usr/bin:/bin:/usr/sbin:/sbin` on macOS) with no
Homebrew/nvm/nix node in it — the host would die at startup with exit 127. Both the
launcher and the manifest hard-code absolute paths, so **re-run the installer if you move
the checkout or change node**.

### Using a specific Claude account profile

Shell aliases that run `claude` with a custom `CLAUDE_CONFIG_DIR` aren't visible to the
native-messaging host, since Firefox launches it via `spawn`, not a shell. To run
generations under a specific account profile, set `claudeConfigDir` in
`bridge/config.json` (host.js exports it as `CLAUDE_CONFIG_DIR` for the `claude` process):

```json
{
  "claudeBin": "/home/you/.local/bin/claude",
  "claudeConfigDir": "/home/you/.claude-accounts/work/.claude"
}
```

`bridge/install.sh` picks this up automatically if `CLAUDEMONKEY_CLAUDE_CONFIG_DIR`
(or your current `CLAUDE_CONFIG_DIR`) is set when you run it. You can also override at
runtime with the `CLAUDEMONKEY_CLAUDE_CONFIG_DIR` env var.

### `claude` is logged in in my terminal but says "Not logged in" here

Firefox launches the native host from the GUI session, so **nothing your shell profile
sets is present** — no aliases, no exported variables. If your credential lives in an
environment variable (e.g. `CLAUDE_CODE_OAUTH_TOKEN`), `claude` is authenticated when you
run it yourself and unauthenticated when the bridge runs it.

`bridge/install.sh` captures `CLAUDE_CODE_OAUTH_TOKEN` from the environment you run it in
and records it under `env` in `bridge/config.json`; host.js merges that into the
environment of the `claude` process. To forward other variables:

```bash
CLAUDEMONKEY_ENV_PASSTHROUGH="CLAUDE_CODE_OAUTH_TOKEN,HTTPS_PROXY" bash bridge/install.sh
```

They must be **exported** to be visible to the script. `ANTHROPIC_API_KEY` is never
forwarded, even if you list it: host.js strips it after applying `env`, so generations
always bill against the subscription. To reproduce what the bridge sees, strip your
environment the same way Firefox does:

```bash
env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  "$(command -v claude)" -p 'Reply with the single word OK' < /dev/null
```

### Reading a failed run

Each run narrates where it got to, so a failure tells you which layer broke:

| Last line you see | What it means |
|---|---|
| nothing at all | the job never started — the error is in the popup, not the sidebar |
| `Capturing <domain>…` | DOM/asset/screenshot capture is stuck or threw |
| (no `Bridge ready`) | the native host isn't answering a ping — host not launching, wrong path in the manifest, or node missing from Firefox's PATH |
| `Bridge ready — claude: …` | the host is alive; the path and profile shown are what it will actually use |
| `Sending N MB of page context…` | request handed to the host; if nothing follows, the host isn't processing messages (watch that N — a huge page makes a huge message) |
| `claude produced no output for …` | the host is fine and `claude` itself is wedged |

To check the host by hand, without Firefox:

```bash
node bridge/test-client.js "hide all images" example.com https://example.com/
```

### When `claude` gets stuck

If the `claude` process emits nothing for 120s, host.js kills it and reports the stall
(with any stderr) instead of leaving the sidebar spinning forever. Tune or disable it
with `stallTimeoutMs` in `bridge/config.json` (0 disables), or `CLAUDEMONKEY_STALL_MS`
at runtime. Long generations are unaffected — any output resets the timer.

## Load the extension in Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on…** → pick `dist/manifest.json`.
   (The fixed gecko id `claudemonkey@local` must match the native-host allowlist, so always
   load from `dist/manifest.json`, not a repacked zip with a different id.)

## End-to-end test

1. Open a normal site (e.g. `https://example.com`).
2. Click the ClaudeMonkey toolbar button → a textbox appears. Type e.g.
   *"add a fixed red banner at the top that says ClaudeMonkey works"* → **Ask Claude**.
3. The **sidebar** opens and streams a transcript: your request, ⚙ tool chips
   (Grep/Read DOM, Read/Edit `userscript.user.js`, Ran `curl …`), and Claude's narration.
   Watch the working dir `~/.claudemonkey/sites/example.com/` (see [Files & logs](#files--logs)).
4. **Verify loop:** after the first draft, ClaudeMonkey installs the script, **reloads the
   tab so it actually runs**, captures any console errors and a fresh DOM snapshot, and
   resumes the same Claude session with that feedback so it can confirm the change worked
   or fix it — up to 3 rounds (so the tab may reload a few times). When it converges the
   final, verified userscript is shown and left installed (a Violentmonkey script named
   `ClaudeMonkey - example.com`); **Apply & reload** re-applies it if you want.
5. **Refine:** type a follow-up in the sidebar (*"make it blue"*) → it edits the same
   script in the same Claude session.
6. **Subscription check:** generation should succeed with no `ANTHROPIC_API_KEY` set and
   not consume API credits (the `init` event reports `apiKeySource: "none"`).
7. The normal Violentmonkey dashboard/editor is still available via **Manage scripts** in
   the popup (the options page).

## CLI smoke test (no browser)

Exercises the whole bridge → claude → userscript path without Firefox:

```bash
node bridge/test-client.js "hide all images" example.com https://example.com/
```

## Files & logs

Everything ClaudeMonkey writes lives under `~/.claudemonkey/`:

```
~/.claudemonkey/
├─ sites/<domain>/          per-site working dir (the cwd of the claude process)
│  ├─ userscript.user.js    THE script Claude edits; overwritten each pass
│  ├─ page-context.md       generated notes: what each file is + how to use it
│  ├─ page-dom.html         DOM snapshot, styles stripped (default view)
│  ├─ page-dom-styled.html  DOM keeping <style>/<link> so existing CSS is visible
│  ├─ page-screenshot.png   PNG of the visible viewport (refreshed post-run)
│  └─ assets/               the page's fetched external CSS/JS (+ manifest in page-context.md)
└─ logs/
   ├─ feedback.md           Claude appends friction notes here (missing context, etc.)
   └─ runs/<domain>/*.md    distilled per-pass log: prompt, transcript, result, cost, final script
```

- The per-site files are **overwritten each pass** — they always reflect the latest
  state, not history. Script/run history lives in `logs/runs/` instead.
- The DOM snapshots and assets are capped (≤24 assets, ≤512 KB each, ≤4 MB total; ~2 MB
  per DOM file). Tune in `src/background/utils/ai.js`. Claude reads short files whole and
  greps large ones; the screenshot costs vision tokens so it's only read on demand.
- **`logs/` is the only extra directory exposed to the `claude` process** (`--add-dir`),
  so it can append to `feedback.md` without reaching into other sites' working dirs.
  Run logs in `logs/runs/` are written by the bridge, not Claude.
- Both logs **accumulate unbounded** — prune them yourself if they grow large.

## Notes / limits

- Firefox-only for now: the live view uses `sidebar_action` (Chrome uses `sidePanel`).
- The page context and your prompt are sent only to your local Claude Code instance. The
  exceptions: Claude may run **`curl`** (the one allowed shell command) to fetch external
  resources it needs (docs, a CDN URL, a resource not already in `assets/`), so those
  requests go out to wherever Claude points them.
- One generation runs at a time; the per-site working dir + Claude session id give
  conversational refinement and survive background restarts.
- The verify loop reloads the **active tab** up to 3 times per request and installs the
  in-progress (possibly broken) script as it converges. Console-error capture is
  best-effort: uncaught errors and unhandled rejections from `@grant none` userscripts are
  caught via a `document_start` collector; the refreshed DOM snapshot is the primary signal
  Claude uses to confirm the change is actually present. Tune rounds via `MAX_VERIFY_ROUNDS`
  in `src/background/utils/ai.js`.
