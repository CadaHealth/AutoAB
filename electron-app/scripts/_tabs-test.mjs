/**
 * Run an analysis, then walk every results tab and report what each shows.
 *
 * The pipeline has been tested; the views built on top of it have not. A tab
 * that throws, stays blank, or shows a number that contradicts another tab is
 * exactly what a supervisor would hit first.
 *
 * Usage: node scripts/_tabs-test.mjs <appDir-or-App.app> <fasta-dir>
 */
import { _electron as electron } from 'playwright';
import path from 'path';
import fs from 'fs';

const target = process.argv[2];
const FASTA_DIR = process.argv[3];

const step = (m) => console.log(`\n▶ ${m}`);
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);

const env = {
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  HOME: process.env.HOME, USER: process.env.USER, TMPDIR: process.env.TMPDIR,
  NODE_ENV: 'production',
};

const isBundle = target.endsWith('.app');
const launchOpts = isBundle
  ? { executablePath: path.join(target, 'Contents', 'MacOS', fs.readdirSync(path.join(target, 'Contents', 'MacOS'))[0]), env }
  : { args: [target], cwd: target, env };

const app = await electron.launch(launchOpts);
let win = null;
for (let i = 0; i < 40 && !win; i++) {
  win = app.windows().find(w => !w.url().startsWith('devtools://')) || null;
  if (!win) await new Promise(r => setTimeout(r, 500));
}
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(1500);
if (await win.locator('h1:has-text("Setup")').count()) await win.locator('button:has-text("Continue")').last().click();

// Anything the renderer throws while we click around.
const pageErrors = [];
win.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
win.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(`console.error: ${m.text().slice(0, 200)}`);
});

const files = fs.readdirSync(FASTA_DIR).filter(f => /\.(fasta|fa)$/i.test(f));
await app.evaluate(({ ipcMain }, d) => {
  for (const ch of ['dialog:selectDirectory', 'dialog:selectFile']) ipcMain.removeHandler(ch);
  ipcMain.handle('dialog:selectDirectory', () => ({ canceled: false, path: d.dir, files: d.files, mode: 'flat', detectedTimepoints: [] }));
  ipcMain.handle('dialog:selectFile', () => ({ canceled: false, path: `${d.dir}/${d.files[0]}`, files: d.files }));
}, { dir: FASTA_DIR, files });

await win.waitForSelector('text=Define Study', { timeout: 30000 });

step('Running an analysis');
await win.fill('input[placeholder*="Memory Loss"]', 'Tab tour');
await win.click('button:has-text("Add First Timepoint")');
await win.waitForTimeout(1200);
await win.locator('button:has-text("Select Folder")').first().click();
await win.waitForTimeout(2500);
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

const deadline = Date.now() + 20 * 60 * 1000;
let acceptedThreshold = false, finished = false;
while (Date.now() < deadline) {
  const body = await win.evaluate(() => document.body.innerText).catch(() => '');
  if (!acceptedThreshold && /threshold/i.test(body)) {
    const cf = win.locator('button', { hasText: /confirm|accept|apply|use this/i });
    if (await cf.count()) { await cf.last().click().catch(() => {}); acceptedThreshold = true; }
  }
  if (/\d+\s+sequences analyzed/i.test(body)) { finished = true; break; }
  if (/analysis (stopped|failed)/i.test(body)) break;
  await win.waitForTimeout(5000);
}
if (!finished) { console.log('\n=== RESULT: FAIL (analysis did not finish) ==='); await app.close(); process.exit(1); }
ok('analysis finished');

const TABS = ['Sequence Browser', 'Dashboard', 'Phylogenetic Trees', 'Clones', 'COVID-DB Matching'];
const report = [];

for (const tab of TABS) {
  step(`Tab: ${tab}`);
  const before = pageErrors.length;
  const btn = win.locator(`button:has-text("${tab}"), [role=tab]:has-text("${tab}")`).first();
  if (!await btn.count()) { bad('tab not found'); report.push({ tab, status: 'missing' }); continue; }
  await btn.click().catch(() => {});
  await win.waitForTimeout(4000);

  const text = (await win.evaluate(() => document.body.innerText).catch(() => '')).replace(/\s+/g, ' ');
  const canvases = await win.locator('canvas, svg').count();
  const newErrors = pageErrors.slice(before);

  // Crude but telling: does the panel show anything beyond its own chrome?
  const empty = /no data|nothing to show|not available|select a/i.test(text) && canvases < 2;

  console.log(`  text: ${text.slice(text.indexOf(tab) >= 0 ? text.indexOf(tab) : 0, 260)}`);
  console.log(`  svg/canvas elements: ${canvases}`);
  if (newErrors.length) { bad(`${newErrors.length} renderer errors`); newErrors.forEach(e => console.log(`     ${e}`)); }
  else ok('no renderer errors');

  report.push({ tab, status: newErrors.length ? 'errors' : empty ? 'empty' : 'ok', canvases, errors: newErrors.length });
  await win.screenshot({ path: `tab-${tab.replace(/\W+/g, '-').toLowerCase()}.png` });
}

step('Summary');
for (const r of report) console.log(`  ${r.status.padEnd(8)} ${r.tab}  (${r.canvases ?? 0} graphics, ${r.errors ?? 0} errors)`);

await app.close();
const failed = report.filter(r => r.status === 'errors' || r.status === 'missing');
console.log(`\n=== RESULT: ${failed.length ? 'ATTENTION' : 'PASS'} ===`);
process.exit(0);
