/**
 * Drive the depth-normalisation toggle in the real UI.
 *
 * Three things are checked, in order of how much damage they would do:
 *
 *  1. With the toggle off the group comparison is byte-identical to what it
 *     was before the feature existed. This is the promise that no published
 *     number can move, and it is checked by round-tripping off -> on -> off
 *     and comparing the rendered text to itself.
 *  2. The unnormalised p-value stays on screen once normalisation is on.
 *  3. The ceiling note appears when both groups sit against the attainable
 *     maximum, which is the case in the reference study at depth 10.
 *
 *   node scripts/verify-normalize-ui.mjs <outputDir>
 */
import { _electron as electron } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = process.argv[2] || path.join(appDir, 'figures');
fs.mkdirSync(OUT, { recursive: true });

const env = { ...process.env, NODE_ENV: 'production', AUTOAB_NO_DEVTOOLS: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

let failures = 0;
const fail = (m) => { console.log(`  FAIL  ${m}`); failures++; };
const pass = (m) => console.log(`  ok    ${m}`);

const app = await electron.launch({ args: [appDir], cwd: appDir, env });
let win = null;
for (let i = 0; i < 60 && !win; i++) {
  win = app.windows().find((w) => !w.url().startsWith('devtools://')) || null;
  if (!win) await new Promise((r) => setTimeout(r, 500));
}
await win.waitForLoadState('domcontentloaded');
await win.setViewportSize({ width: 1800, height: 1300 });
win.on('pageerror', (e) => console.log(`  [pageerror] ${String(e).slice(0, 200)}`));

let ready = false;
for (let i = 0; i < 30 && !ready; i++) {
  for (const probe of ['History', 'Define Study', 'Analysis Results']) {
    if (await win.locator(`text=${probe}`).count()) { ready = true; break; }
  }
  if (!ready) await win.waitForTimeout(1000);
}
if (!ready) throw new Error('renderer stayed blank');

await win.locator('text=History').first().click();
await win.waitForTimeout(1500);
const cards = win.locator('.session-card');
const names = await cards.allInnerTexts();
const WANT = process.env.SESSION_NAME || 'bz04';
const idx = names.findIndex((t) => t.includes(WANT));
if (idx < 0) throw new Error(`no session matching "${WANT}"`);
await cards.nth(idx).click();
for (let i = 0; i < 90; i++) {
  if (await win.locator('text=Analysis Results').count()) break;
  await win.waitForTimeout(1000);
}
await win.waitForTimeout(4000);
await win.locator('button:has-text("Dashboard")').first().click();
await win.waitForTimeout(6000);

const chart = win.locator('#group-comparison-chart');
await chart.scrollIntoViewIfNeeded();
await win.waitForTimeout(1500);

const readChart = async () => (await chart.innerText()).replace(/\s+/g, ' ').trim();

console.log('\n=== 1. toggle off is the untouched code path ===');
const before = await readChart();
await win.screenshot({ path: path.join(OUT, 'norm_off.png'), fullPage: false });
const shannonOff = before.match(/p [=<] [\d.]+/);
console.log(`  first p-value with toggle off: ${shannonOff ? shannonOff[0] : '(none found)'}`);

const toggle = win.locator('.norm-toggle input[type="checkbox"]');
if (!(await toggle.count())) throw new Error('normalize toggle not rendered');

await toggle.check();
await win.waitForTimeout(3000);
const depthInput = win.locator('.norm-depth input');
console.log(`  suggested depth on open: ${await depthInput.inputValue()}`);
await depthInput.fill('10');
await depthInput.dispatchEvent('input');
await win.waitForTimeout(6000);
const appliedDepth = await depthInput.inputValue();
console.log(`  depth field after setting 10: ${appliedDepth}`);
if (appliedDepth !== '10') fail(`depth field did not take the value, still ${appliedDepth}`);

console.log('\n=== 2. normalized view ===');
const on = await readChart();
await chart.scrollIntoViewIfNeeded();
await win.screenshot({ path: path.join(OUT, 'norm_on.png'), fullPage: false });

if (/unnormalized p/.test(on)) pass('unnormalized p-value stays visible');
else fail('unnormalized p-value is gone, it must stay next to the normalized one');

if (/D=10/.test(on)) pass('normalized p-value is labelled with the depth');
else fail('no depth label on the normalized p-value');

if (/max ln\(10\)/.test(on)) pass('Shannon ceiling ln(10) is shown');
else fail('Shannon ceiling not shown');

if (/% of it/.test(on)) pass('ceiling proximity warning fired, as expected at depth 10');
else fail('ceiling warning did not fire, both groups sit at ~99% of ln(10) here');

if (/Chao1 is largely fixed by depth/.test(on)) pass('Chao1 flagged as depth-determined at small D');
else fail('Chao1 not flagged at depth 10');

const retention = await win.locator('.retention-table').innerText().catch(() => '');
console.log('\n  retention per group and timepoint:');
retention.split('\n').forEach((l) => l.trim() && console.log(`    ${l.trim()}`));
if (/T3\s+19 of 19\s+11 of 11/.test(retention.replace(/\t/g, ' '))) pass('T3 retention 19/19 and 11/11 at depth 10');
else fail('T3 retention does not match the reference study');

console.log('\n=== 3. switching back restores the original exactly ===');
await toggle.uncheck();
await win.waitForTimeout(4000);
const after = await readChart();
if (after === before) pass('chart text identical to before the toggle was ever used');
else {
  fail('chart changed after toggling off again');
  const b = before.split(' ');
  const a = after.split(' ');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) { console.log(`        first difference at token ${i}: "${b[i]}" -> "${a[i]}"`); break; }
  }
}

await app.close();
console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
