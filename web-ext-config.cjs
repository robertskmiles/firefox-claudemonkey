// Config for `web-ext run` (https://github.com/mozilla/web-ext).
// Launches Firefox with the built extension preloaded and auto-reloads it
// whenever the `dist/` build output changes (pair with `pnpm dev`).
module.exports = {
  // The built extension; `pnpm dev` / `pnpm build` write here.
  sourceDir: './dist',
  run: {
    target: ['firefox-desktop'],
    // Reuse a persistent dev profile so installed userscripts, granted
    // permissions, etc. survive across `web-ext run` sessions.
    firefoxProfile: './.web-ext-profile',
    profileCreateIfMissing: true,
    keepProfileChanges: true,
    // Open the extension's sidebar on launch (ClaudeMonkey is sidebar-based).
    // Comment out if you prefer to open it manually.
    startUrl: ['https://example.com'],
  },
};
