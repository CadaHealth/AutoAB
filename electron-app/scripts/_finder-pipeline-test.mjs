/**
 * The realistic test: run a whole analysis through the packaged app started
 * with the environment a Finder double-click actually provides.
 *
 * Usage: node scripts/_finder-pipeline-test.mjs <App.app> <fasta-dir>
 */
import { _electron as electron } from 'playwright';
import path from 'path';
import fs from 'fs';

const appPath = process.argv[2];
const FASTA_DIR = process.argv[3];
const executable = path.join(appPath, 'Contents', 'MacOS',
  fs.readdirSync(path.join(appPath, 'Contents', 'MacOS'))[0]);

const step = (m) => console.log(`\n▶ ${m}`);
const ok = (m) => console.log(`  ✓ ${m}`);

// launchd's environment, nothing from the shell profile.
const env = {
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  HOME: process.env.HOME,
  USER: process.env.USER,
  TMPDIR: process.env.TMPDIR,
  NODE_ENV: 'production',
};

const fastaFiles = fs.readdirSync(FASTA_DIR).filter((f) => /\.(fasta|fa)$/i.test(f));

step('Launching the packaged app as Finder would');
const app = await electron.launch({ executablePath: executable, env });

let win = null;
for (let i = 0; i < 40 && !win; i++) {
  win = app.windows().find(w => !w.url().startsWith('devtools://')) || null;
  if (!win) await new Promise(r => setTimeout(r, 500));
}
if (!win) throw new Error('no application window appeared');
await win.waitForLoadState('domcontentloaded');

step('Dependency report as the user would see it');
const report = await win.evaluate(() => window.electronAPI.checkDependencies());
for (const i of report.items) {
  console.log(`  ${i.status === 'ok' ? '✓' : '✗'} ${i.label}: ${i.detail || i.problem}`);
}
if (!report.ok) {
  await win.locator('button:has-text("Continue")').last().click().catch(() => {});
}

await app.evaluate(({ ipcMain }, { dir, files }) => {
  for (const channel of ['dialog:selectDirectory', 'dialog:selectFile']) ipcMain.removeHandler(channel);
  ipcMain.handle('dialog:selectDirectory', () => ({
    canceled: false, path: dir, files, mode: 'flat', detectedTimepoints: []
  }));
  ipcMain.handle('dialog:selectFile', () => ({ canceled: false, path: dir + '/' + files[0], files }));
}, { dir: FASTA_DIR, files: fastaFiles });

await win.waitForSelector('text=Define Study', { timeout: 30000 });

step('Driving the wizard');
await win.fill('input[placeholder*="Memory Loss"]', 'Finder Launch Test');
await win.click('button:has-text("Add First Timepoint")');
await win.waitForTimeout(1500);
await win.locator('button', { hasText: /select folder|choose folder|browse|select directory|add files/i }).first().click();
await win.waitForTimeout(3000);
const c1 = win.locator('button:has-text("Continue")').last();
for (let i = 0; i < 20 && await c1.isDisabled(); i++) await win.waitForTimeout(500);
await c1.click();
await win.waitForSelector('text=Species', { timeout: 15000 });
await win.locator('button:has-text("Human")').first().click();
await win.waitForTimeout(800);
const c2 = win.locator('button:has-text("Continue")').last();
for (let i = 0; i < 20 && await c2.isDisabled(); i++) await win.waitForTimeout(500);
await c2.click();
await win.locator('button:has-text("Start Analysis")').last().click();
ok('analysis started');

step('Waiting for the pipeline');
const deadline = Date.now() + 15 * 60 * 1000;
let acceptedThreshold = false, finished = false;
const pipelineLog = [];

// Everything the app says about the run, so a failure is diagnosable rather
// than just "it did not finish".
win.on('console', (m) => {
  const t = m.text();
  if (/pipeline|error|failed|database|threshold|igblast/i.test(t)) pipelineLog.push(t.slice(0, 300));
});

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

  // Only the results view states a sequence count. Matching softer words let
  // the untouched "Review & Start" screen pass as a success.
  if (/\d+\s+sequences analyzed/i.test(body)) { finished = true; break; }

  if (/analysis (stopped|failed)/i.test(body)) {
    console.log('  ! the app reports the analysis stopped');
    break;
  }
  await win.waitForTimeout(5000);
}

if (pipelineLog.length) {
  console.log('\n--- what the app logged ---');
  for (const l of pipelineLog.slice(-25)) console.log(`  ${l}`);
}

const final = await win.evaluate(() => document.body.innerText).catch(() => '');
await win.screenshot({ path: 'finder-pipeline-final.png' });
await app.close();

console.log(`\n=== final screen ===\n${final.replace(/\s+/g, ' ').slice(0, 400)}`);
console.log(`\n=== RESULT: ${finished ? 'PASS' : 'FAIL'} ===`);
process.exit(finished ? 0 : 1);
