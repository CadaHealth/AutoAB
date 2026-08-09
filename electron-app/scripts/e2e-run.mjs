/**
 * End-to-end GUI test: drives the wizard from an empty study to a finished
 * analysis, through the real application window.
 *
 * The wizard picks input files through native OS dialogs, which cannot be
 * automated. Instead the dialog IPC handlers are replaced in the main process
 * with ones that return a fixed directory, so everything downstream, store
 * updates, staging, pipeline spawn, result rendering, runs for real.
 *
 * Usage: node scripts/e2e-run.mjs <fasta-dir> [human|mouse]
 */
import { _electron as electron } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FASTA_DIR = process.argv[2];
const SPECIES = (process.argv[3] || 'mouse').toLowerCase();
if (!FASTA_DIR) throw new Error('usage: e2e-run.mjs <fasta-dir> [species]');

const step = (m) => console.log(`\n▶ ${m}`);
const ok = (m) => console.log(`  ✓ ${m}`);

const env = { ...process.env, NODE_ENV: 'production', AUTOAB_NO_DEVTOOLS: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

step('Launching application');
const app = await electron.launch({ args: [appDir], cwd: appDir, env });

// Replace the native file dialogs before the renderer can call them.
const fastaFiles = fs.readdirSync(FASTA_DIR).filter((f) => /\.(fasta|fa)$/i.test(f));
if (fastaFiles.length === 0) throw new Error(`no FASTA files in ${FASTA_DIR}`);

ok('native file dialogs stubbed');

let win = null;
for (let i = 0; i < 40 && !win; i++) {
  win = app.windows().find(w => !w.url().startsWith('devtools://')) || null;
  if (!win) await new Promise(r => setTimeout(r, 500));
}
if (!win) throw new Error('no application window appeared');
await win.waitForLoadState('domcontentloaded');
await win.waitForSelector('text=Define Study', { timeout: 30000 });
ok('wizard step 1 rendered');

// Stub AFTER setupIpcHandlers has registered the real handlers, or it wins.
await app.evaluate(({ ipcMain }, { dir, files }) => {
  // Mirror the shape the real handler returns: { path, files, mode }.
  for (const channel of ['dialog:selectDirectory', 'dialog:selectFile']) {
    ipcMain.removeHandler(channel);
  }
  ipcMain.handle('dialog:selectDirectory', () => ({
    canceled: false, path: dir, files, mode: 'flat', detectedTimepoints: []
  }));
  ipcMain.handle('dialog:selectFile', () => ({
    canceled: false, path: dir + '/' + (files[0] || ''), files
  }));
}, { dir: FASTA_DIR, files: fastaFiles });

win.on('console', (m) => {
  const t = m.text();
  if (/error|failed|Pipeline|complete/i.test(t)) console.log(`    [renderer] ${t.slice(0, 160)}`);
});

// ---------------------------------------------------------------- step 1
step('Step 1, Define Study');
await win.fill('input[placeholder*="Memory Loss"]', 'E2E Mouse Study');
ok('study name entered');

await win.click('button:has-text("Add First Timepoint")');
await win.waitForTimeout(1500);

// The timepoint card exposes a button that opens the directory picker.
const pickers = await win.locator('button', { hasText: /select folder|choose folder|browse|select directory|add files/i }).all();
if (pickers.length === 0) {
  const all = await win.locator('button').allInnerTexts();
  throw new Error('no folder picker button found; buttons were: ' + JSON.stringify(all.map(t => t.slice(0, 40))));
}
await pickers[0].click();
await win.waitForTimeout(3000);
ok('FASTA directory selected via stubbed dialog');

const continue1 = win.locator('button:has-text("Continue")').last();
await continue1.waitFor({ state: 'visible' });
for (let i = 0; i < 20 && await continue1.isDisabled(); i++) await win.waitForTimeout(500);
if (await continue1.isDisabled()) throw new Error('Continue still disabled after selecting files');
await continue1.click();
ok('advanced to step 2');

// ---------------------------------------------------------------- step 2
step('Step 2, Choose Database');
await win.waitForSelector('text=Species', { timeout: 15000 });
const speciesLabel = SPECIES === 'mouse' ? 'Mouse' : 'Human';
await win.locator(`button:has-text("${speciesLabel}")`).first().click();
ok(`species set to ${speciesLabel}`);
await win.waitForTimeout(800);

const continue2 = win.locator('button:has-text("Continue")').last();
for (let i = 0; i < 20 && await continue2.isDisabled(); i++) await win.waitForTimeout(500);
await continue2.click();
ok('advanced to step 3');

// ---------------------------------------------------------------- step 3
step('Step 3, Review & Start');
const start = win.locator('button:has-text("Start Analysis")').last();
await start.waitFor({ state: 'visible', timeout: 15000 });
await start.click();
ok('analysis started');

// ---------------------------------------------------------------- run
step('Waiting for the pipeline (threshold prompt is auto-accepted)');
const deadline = Date.now() + 15 * 60 * 1000;
let acceptedThreshold = false;
let finished = false;

while (Date.now() < deadline) {
  const body = await win.evaluate(() => document.body.innerText).catch(() => '');

  if (!acceptedThreshold && /threshold/i.test(body)) {
    const confirm = win.locator('button', { hasText: /confirm|accept|continue|apply|use this/i });
    if (await confirm.count()) {
      await confirm.last().click().catch(() => {});
      acceptedThreshold = true;
      ok('threshold dialog confirmed');
    }
  }

  if (/analysis complete|results|dashboard|repertoire/i.test(body)
      && !/starting analysis|running/i.test(body)) {
    const done = await win.locator('text=/clone|diversity|isotype/i').count();
    if (done > 0) { finished = true; break; }
  }
  if (/error|failed/i.test(body) && /pipeline/i.test(body)) {
    console.log('  ! error text on screen:', body.replace(/\s+/g, ' ').slice(0, 300));
  }
  await win.waitForTimeout(5000);
}

const finalText = await win.evaluate(() => document.body.innerText).catch(() => '');
console.log('\n=== final screen ===');
console.log(finalText.replace(/\s+/g, ' ').slice(0, 700));

await win.screenshot({ path: path.join(appDir, 'e2e-final.png'), fullPage: false }).catch(() => {});
await app.close();

console.log(`\n=== RESULT: ${finished ? 'PASS, results rendered' : 'INCOMPLETE'} ===`);
process.exit(finished ? 0 : 1);
