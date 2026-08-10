/**
 * Drive a two-timepoint analysis through the packaged app.
 *
 * This is the path that has never been exercised: per-timepoint splitting,
 * a separate threshold per timepoint, and trees built per timepoint.
 *
 * Usage: node scripts/_multitp-test.mjs <App-or-appDir> <T1-dir> <T2-dir>
 */
import { _electron as electron } from 'playwright';
import path from 'path';
import fs from 'fs';

const target = process.argv[2];
const T1 = process.argv[3];
const T2 = process.argv[4];

const step = (m) => console.log(`\n▶ ${m}`);
const ok = (m) => console.log(`  ✓ ${m}`);

const env = {
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  HOME: process.env.HOME,
  USER: process.env.USER,
  TMPDIR: process.env.TMPDIR,
  NODE_ENV: 'production',
};

const isBundle = target.endsWith('.app');
const launchOpts = isBundle
  ? { executablePath: path.join(target, 'Contents', 'MacOS', fs.readdirSync(path.join(target, 'Contents', 'MacOS'))[0]), env }
  : { args: [target], cwd: target, env };

step('Launching');
const app = await electron.launch(launchOpts);
let win = null;
for (let i = 0; i < 40 && !win; i++) {
  win = app.windows().find(w => !w.url().startsWith('devtools://')) || null;
  if (!win) await new Promise(r => setTimeout(r, 500));
}
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(1500);
if (await win.locator('h1:has-text("Setup")').count()) {
  await win.locator('button:has-text("Continue")').last().click();
}

// The picker is called once per timepoint card, so hand back a different
// directory each time rather than a fixed one. The listings are computed here,
// not inside evaluate(): that context has no `require`, and reading the
// directory there fails with "require is not defined".
const listing = [T1, T2].map(dir => ({
  dir,
  files: fs.readdirSync(dir).filter(f => /\.(fasta|fa)$/i.test(f)),
}));
if (listing.some(l => l.files.length === 0)) throw new Error('a timepoint directory has no FASTA files');

await app.evaluate(({ ipcMain }, dirs) => {
  let n = 0;
  for (const ch of ['dialog:selectDirectory', 'dialog:selectFile']) ipcMain.removeHandler(ch);
  ipcMain.handle('dialog:selectDirectory', () => {
    const { dir, files } = dirs[Math.min(n++, dirs.length - 1)];
    return { canceled: false, path: dir, files, mode: 'flat', detectedTimepoints: [] };
  });
}, listing);

await win.waitForSelector('text=Define Study', { timeout: 30000 });

step('Step 1: two timepoints');
await win.fill('input[placeholder*="Memory Loss"]', 'INCOV two-timepoint');
await win.click('button:has-text("Add First Timepoint")');
await win.waitForTimeout(1200);
await win.locator('button', { hasText: /select folder|choose folder|browse|select directory|add files/i }).first().click();
await win.waitForTimeout(2500);
ok('timepoint 1 folder selected');

await win.click('button:has-text("Add Timepoint")');
await win.waitForTimeout(1200);
const pickers = await win.locator('button', { hasText: /select folder|choose folder|browse|select directory|add files/i }).all();
await pickers[pickers.length - 1].click();
await win.waitForTimeout(2500);
ok(`timepoint 2 folder selected (${pickers.length} pickers on screen)`);

const c1 = win.locator('button:has-text("Continue")').last();
for (let i = 0; i < 20 && await c1.isDisabled(); i++) await win.waitForTimeout(500);
if (await c1.isDisabled()) throw new Error('Continue disabled after selecting both timepoints');
await c1.click();

step('Step 2: species');
await win.waitForSelector('text=Species', { timeout: 15000 });
await win.locator('button:has-text("Human")').first().click();
await win.waitForTimeout(800);
const c2 = win.locator('button:has-text("Continue")').last();
for (let i = 0; i < 20 && await c2.isDisabled(); i++) await win.waitForTimeout(500);
await c2.click();

step('Step 3: start');
await win.locator('button:has-text("Start Analysis")').last().click();
ok('started');

step('Running');
const deadline = Date.now() + 25 * 60 * 1000;
let acceptedThreshold = false, finished = false;
const logLines = [];
win.on('console', (m) => {
  const t = m.text();
  if (/threshold|trees|Neighbor|IQ-TREE|error|failed|timepoint/i.test(t)) logLines.push(t.slice(0, 260));
});

while (Date.now() < deadline) {
  const body = await win.evaluate(() => document.body.innerText).catch(() => '');
  if (!acceptedThreshold && /threshold/i.test(body)) {
    const confirm = win.locator('button', { hasText: /confirm|accept|apply|use this/i });
    if (await confirm.count()) {
      await confirm.last().click().catch(() => {});
      acceptedThreshold = true;
      ok('threshold dialog confirmed');
    }
  }
  if (/\d+\s+sequences analyzed/i.test(body)) { finished = true; break; }
  if (/analysis (stopped|failed)/i.test(body)) { console.log('  ! analysis stopped'); break; }
  await win.waitForTimeout(5000);
}

if (logLines.length) {
  console.log('\n--- app log (last 20) ---');
  for (const l of logLines.slice(-20)) console.log(`  ${l}`);
}

const final = await win.evaluate(() => document.body.innerText).catch(() => '');
await win.screenshot({ path: 'multitp-final.png' });
await app.close();

console.log(`\n=== final screen ===\n${final.replace(/\s+/g, ' ').slice(0, 500)}`);
console.log(`\n=== RESULT: ${finished ? 'PASS' : 'FAIL'} ===`);
process.exit(finished ? 0 : 1);
