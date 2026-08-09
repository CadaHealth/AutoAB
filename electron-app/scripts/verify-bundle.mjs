/**
 * Launch a packaged AutoAB build and assert it is actually self-contained.
 *
 * Packaging can succeed while producing an app that falls back to whatever
 * Python happens to be on the build machine, which then fails on a clean one.
 * This drives the real bundle and reads the dependency report the Setup screen
 * uses, so "bundled" means bundled.
 *
 * Usage: node scripts/verify-bundle.mjs [path/to/App.app]
 */
import { _electron as electron } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function findPackagedApp() {
  if (process.argv[2]) return process.argv[2];
  const releaseDir = path.join(appDir, 'release');
  if (!fs.existsSync(releaseDir)) throw new Error('no release/ directory; run npm run package:mac first');
  for (const entry of fs.readdirSync(releaseDir)) {
    const dir = path.join(releaseDir, entry);
    if (!fs.statSync(dir).isDirectory()) continue;
    const app = fs.readdirSync(dir).find(f => f.endsWith('.app'));
    if (app) return path.join(dir, app);
  }
  throw new Error(`no .app found under ${releaseDir}`);
}

const appPath = findPackagedApp();
const executable = path.join(appPath, 'Contents', 'MacOS',
  fs.readdirSync(path.join(appPath, 'Contents', 'MacOS'))[0]);

console.log(`▶ ${path.basename(appPath)}`);

// The parent process may carry variables that would defeat the point: an
// inherited AUTOAB_PYTHON would override the bundled interpreter, and
// ELECTRON_RUN_AS_NODE stops Electron being Electron at all.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
delete env.AUTOAB_PYTHON;

const app = await electron.launch({ executablePath: executable, env });

let win = null;
for (let i = 0; i < 40 && !win; i++) {
  win = app.windows().find(w => !w.url().startsWith('devtools://')) || null;
  if (!win) await new Promise(r => setTimeout(r, 500));
}
if (!win) throw new Error('no application window appeared');
await win.waitForLoadState('domcontentloaded');

const report = await win.evaluate(() => window.electronAPI.checkDependencies());
await app.close();

const failures = [];
const python = report.items.find(i => i.id === 'python');
const igblast = report.items.find(i => i.id === 'igblast');

for (const item of report.items) {
  const mark = item.status === 'ok' ? '✓' : '✗';
  console.log(`  ${mark} ${item.label}: ${item.detail || item.problem}`);
}

if (!python || python.status !== 'ok') {
  failures.push('the bundled Python runtime is missing or broken');
} else if (!/bundled with/i.test(python.detail || '')) {
  failures.push(`Python came from the system, not the bundle: ${python.detail}`);
}
if (!igblast || igblast.status !== 'ok') {
  failures.push('IgBLAST is missing from the bundle');
}

// R is deliberately not bundled, so it is reported but never fatal here.
if (failures.length) {
  console.error('\n✗ Bundle is not self-contained:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('\n✓ Bundle carries its own Python and IgBLAST.');
