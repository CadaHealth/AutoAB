/**
 * Smoke-test the packaged application, not the checkout.
 *
 * The bundle resolves its tools from Resources/{bin,data} and runs an embedded
 * interpreter under the hardened runtime. None of that is exercised by running
 * from source, and it is where past releases broke, so a release is not done
 * until a real analysis has gone through the .app itself.
 *
 *   node scripts/smoke-packaged.mjs <path/to/Clono.app> <outputDir>
 */
import { _electron as electron } from 'playwright';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const appPath = process.argv[2];
const SHOTS = process.argv[3] || '/tmp/smoke';
const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.mkdirSync(SHOTS, { recursive: true });

const ROOT = '/Users/teichmann/Desktop/LongCovid_Symptom_FASTA';
const DIRS = [path.join(ROOT, 'NonLongCovid_T1'), path.join(ROOT, 'NonLongCovid_T2')];
const LABELS = ['T1', 'T2'];

const step = (m) => console.log(`\n▶ ${m}`);
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { console.log(`  ✗ ${m}`); process.exitCode = 1; };

const exe = path.join(appPath, 'Contents/MacOS/Clono');
if (!fs.existsSync(exe)) throw new Error(`no executable at ${exe}`);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

step(`Launching ${path.basename(appPath)}`);
const app = await electron.launch({ executablePath: exe, args: [], env });
let win = null;
for (let i = 0; i < 90 && !win; i++) {
  win = app.windows().find((w) => !w.url().startsWith('devtools://')) || null;
  if (!win) await new Promise((r) => setTimeout(r, 500));
}
if (!win) throw new Error('no window');
await win.waitForLoadState('domcontentloaded');
await win.setViewportSize({ width: 1600, height: 1100 });
await win.waitForTimeout(3000);
ok('packaged app launched');

// The setup screen is the bundle's own report on where it found its tools.
step('Setup screen');
if (await win.locator('h1:has-text("Setup")').count()) {
  const items = await win.locator('li.item').allInnerTexts();
  for (const i of items) console.log(`    ${i.replace(/\n+/g, ' | ').slice(0, 130)}`);
  await win.screenshot({ path: path.join(SHOTS, 'smoke_01_setup.png') });
  const bad = items.filter((t) => /not found|missing|install/i.test(t));
  if (bad.length) fail(`setup reports problems: ${bad.length}`);
  await win.locator('button:has-text("Continue")').last().click();
  await win.waitForTimeout(1000);
} else {
  console.log('    (no setup screen; all dependencies satisfied)');
}

await win.waitForSelector('text=Define Study', { timeout: 30000 });
// Under Electron the CSV export goes through showSaveDialog + a writeFile IPC
// call, not a browser download, so both dialogs have to be answered or the run
// blocks on a native window nobody can click.
await app.evaluate(({ dialog }, { dirs, saveDir }) => {
  let i = 0;
  let s = 0;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dirs[Math.min(i++, dirs.length - 1)]] });
  dialog.showSaveDialog = async (_win, opts) => ({
    canceled: false,
    filePath: `${saveDir}/export_${s++}_${opts?.defaultPath?.split('/').pop() || 'out.csv'}`,
  });
}, { dirs: DIRS, saveDir: SHOTS });

step('Configuring a two-timepoint run');
await win.fill('input[placeholder*="Memory Loss"]', 'Packaged smoke test');
for (let t = 0; t < LABELS.length; t++) {
  const add = win.locator('button:has-text("Add First Timepoint"), button:has-text("Add Timepoint")').first();
  await add.click();
  await win.waitForTimeout(700);
  await win.locator('input.tp-label-input').nth(t).fill(LABELS[t]);
  await win.locator('button:has-text("Select Folder")').last().click();
  await win.waitForTimeout(3000);
}
ok('two timepoints attached');

const cont = () => win.locator('button:has-text("Continue")').last();
for (let i = 0; i < 30 && (await cont().isDisabled()); i++) await win.waitForTimeout(500);
await cont().click();
await win.waitForTimeout(1200);
if (await win.locator('button:has-text("Human")').count()) {
  await win.locator('button:has-text("Human")').first().click();
  await win.waitForTimeout(600);
}
for (let i = 0; i < 30 && (await cont().isDisabled()); i++) await win.waitForTimeout(500);
await cont().click();
await win.waitForTimeout(1200);

step('Running the pipeline inside the bundle');
await win.locator('button:has-text("Start Analysis")').last().click();
const deadline = Date.now() + 20 * 60 * 1000;
const t0 = Date.now();
let answered = 0;
let ticks = 0;
let done = false;
while (Date.now() < deadline) {
  const confirm = win.locator('.modal-actions button.btn-primary:has-text("Apply")');
  if (await confirm.count()) {
    await win.screenshot({ path: path.join(SHOTS, 'smoke_02_threshold.png') }).catch(() => {});
    await confirm.last().click().catch(() => {});
    answered++;
    console.log(`    threshold applied (${answered})`);
    await win.waitForTimeout(2500);
    continue;
  }
  if (await win.locator('text=Analysis Results').count()) { done = true; break; }
  // Keep a rolling picture of the screen. A run that stalls is otherwise
  // invisible until the deadline, and by then the interesting moment is gone.
  ticks += 1;
  if (ticks % 8 === 0) {
    await win.screenshot({ path: path.join(SHOTS, 'smoke_LIVE.png') }).catch(() => {});
    const line = (await win.evaluate(() => document.body.innerText).catch(() => ''))
      .split('\n').map((s) => s.trim()).filter(Boolean).slice(-4).join(' | ');
    console.log(`    [${Math.round((Date.now() - t0) / 1000)}s] ${line.slice(0, 150)}`);
  }
  await win.waitForTimeout(4000);
}
if (!done) {
  await win.screenshot({ path: path.join(SHOTS, 'smoke_ZZ_timeout.png') }).catch(() => {});
  throw new Error('no results:\n' + (await win.evaluate(() => document.body.innerText)).slice(0, 1000));
}
ok('analysis completed inside the packaged app');
await win.waitForTimeout(5000);

step('Checking the result views');
const header = await win.locator('text=Analysis Results').first().innerText().catch(() => '');
console.log(`    ${header}`);
await win.locator('button:has-text("Dashboard")').first().click().catch(() => {});
await win.waitForTimeout(6000);
await win.screenshot({ path: path.join(SHOTS, 'smoke_03_dashboard.png'), fullPage: true });

const text = await win.evaluate(() => document.body.innerText);
fs.writeFileSync(path.join(SHOTS, 'smoke_dashboard.txt'), text);
// Case varies by layout: the cross-cohort cards shout "TOTAL SEQUENCES", the
// single-cohort ones say "Total Sequences". Match on either.
const flat = text.toUpperCase();
for (const needle of ['TOTAL SEQUENCES', 'UNIQUE CLONES', 'SHANNON']) {
  if (flat.includes(needle)) ok(`dashboard shows ${needle}`);
  else fail(`dashboard missing ${needle}`);
}

// Exports: never exercised before, and the first thing a reviewer clicks.
step('Exports');
for (const label of ['Export Aggregated', 'Export Per-Sample']) {
  const btn = win.locator(`button:has-text("${label}")`).first();
  if (!(await btn.count())) { fail(`no "${label}" button`); continue; }
  const before = new Set(fs.readdirSync(SHOTS).filter((f) => f.startsWith('export_')));
  await btn.click().catch(() => {});
  await win.waitForTimeout(6000);
  const written = fs.readdirSync(SHOTS).filter((f) => f.startsWith('export_') && !before.has(f));
  if (written.length === 0) {
    fail(`${label} wrote no file`);
  } else {
    for (const f of written) {
      const p = path.join(SHOTS, f);
      const size = fs.statSync(p).size;
      const rows = fs.readFileSync(p, 'utf8').trim().split('\n').length;
      if (size > 0 && rows > 1) ok(`${label} -> ${f} (${size} bytes, ${rows} Zeilen)`);
      else fail(`${label} -> ${f} is empty (${size} bytes, ${rows} rows)`);
    }
  }
}

await win.screenshot({ path: path.join(SHOTS, 'smoke_04_final.png') });
await app.close();

// A run must leave the bundle exactly as it shipped.
//
// The interpreter lives inside the .app, so anything Python writes lands in a
// signed, sealed bundle. Nine __pycache__ directories from a single launch
// were enough to make codesign report "a sealed resource is missing or
// invalid" and to kill the app mid-pipeline. None of that is visible on an
// unsigned build, which is exactly why the check belongs here rather than in
// the release step where it would be remembered only when someone thinks of it.
step('Bundle integrity after the run');
const caches = execSync(`find ${JSON.stringify(appPath)} -name __pycache__ -type d`, { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean);
if (caches.length === 0) ok('no bytecode written into the bundle');
else {
  fail(`${caches.length} __pycache__ directories written into the bundle`);
  caches.slice(0, 5).forEach((c) => console.log(`      ${c.replace(appPath + '/', '')}`));
}

try {
  execSync(`codesign --verify --deep --strict ${JSON.stringify(appPath)}`, { stdio: 'pipe' });
  ok('code signature still valid after the run');
} catch (e) {
  const msg = String(e.stderr || e).trim().split('\n').pop();
  if (/not signed|code object is not signed/i.test(msg)) console.log('    (unsigned build, signature check skipped)');
  else fail(`code signature broken by the run: ${msg}`);
}

console.log(process.exitCode ? '\nSMOKE TEST: problems above' : '\nSMOKE TEST: clean');
