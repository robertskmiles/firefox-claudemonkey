/**
 * Package dist/ into an installable .xpi.
 *
 * An .xpi is a plain zip with manifest.json at its root, so this walks dist/ and zips it
 * with fflate (already a runtime dependency) rather than shelling out to `zip`, which
 * isn't present everywhere.
 *
 * The gecko id baked into the manifest (`claudemonkey@local`) is what the native-messaging
 * host allowlists, and it survives packing — so the packaged extension talks to the same
 * bridge as the temporary add-on, with no need to re-run bridge/install.sh.
 *
 * Release/Beta Firefox refuse unsigned extensions no matter what; install this in
 * Developer Edition, Nightly or ESR with xpinstall.signatures.required=false, or run it
 * through `web-ext sign --channel=unlisted` first. See SETUP.md.
 */
const fs = require('fs');
const path = require('path');
const { zipSync } = require('fflate');

const DIST = 'dist';
const OUT_DIR = 'dist-assets';
const OUT = path.join(OUT_DIR, 'claudemonkey.xpi');

/** Collect dist/ into fflate's { 'relative/path': bytes } shape, skipping dotfiles. */
function collect(dir, base = '', files = {}) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    // Zip entries are always '/'-separated, whatever the host platform uses.
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) collect(full, rel, files);
    else files[rel] = fs.readFileSync(full);
  }
  return files;
}

function main() {
  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
    console.error(`No ${DIST}/manifest.json — run \`pnpm build\` first.`);
    process.exit(1);
  }
  const files = collect(DIST);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, zipSync(files, { level: 9 }));

  const { version, name } = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
  const kb = Math.round(fs.statSync(OUT).size / 1024);
  console.log(`${OUT} — ${name} ${version}, ${Object.keys(files).length} files, ${kb} KB`);
}

main();
