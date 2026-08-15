/**
 * Verify the sequencing-depth diagnostic against known ground truth.
 *
 * The T3 medians computed straight from the clone-pass tables of
 * run_2026-08-11T00-21-47_35nw / _bz04 are 123 clone-assigned sequences for
 * Disease and 26 for Control. If the panel shows those, then clonedSequences
 * is wired to the right quantity; if it shows something larger, it is reading
 * totalSequences and counting light chains.
 *
 *   node scripts/capture-depth-panel.mjs <outputDir>
 */
import { _electron as electron } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = process.argv[2] || path.join(appDir, 'figures');
fs.mkdirSync(OUT, { recursive: true });

const EXPECT = { Disease: 123, Control: 26, tp: 'T3' };

// NODE_ENV=production or the main process serves the renderer from the Vite
// dev server and the window stays blank with no console error.
const env = { ...process.env, NODE_ENV: 'production', AUTOAB_NO_DEVTOOLS: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

const app = await electron.launch({ args: [appDir], cwd: appDir, env });
let win = null;
for (let i = 0; i < 60 && !win; i++) {
  win = app.windows().find((w) => !w.url().startsWith('devtools://')) || null;
  if (!win) await new Promise((r) => setTimeout(r, 500));
}
if (!win) throw new Error('no application window appeared');
await win.waitForLoadState('domcontentloaded');
await win.setViewportSize({ width: 1800, height: 1200 });
win.on('pageerror', (e) => console.log(`  [pageerror] ${String(e).slice(0, 200)}`));

let ready = false;
for (let i = 0; i < 30 && !ready; i++) {
  for (const probe of ['History', 'Define Study', 'Analysis Results']) {
    if (await win.locator(`text=${probe}`).count()) { ready = true; break; }
  }
  if (!ready) await win.waitForTimeout(1000);
}
if (!ready) throw new Error('renderer stayed blank');

console.log('▶ restoring session');
await win.locator('text=History').first().click();
await win.waitForTimeout(1500);
const cards = win.locator('.session-card');
const names = await cards.allInnerTexts();
const WANT = process.env.SESSION_NAME || 'LC MP vs NLC';
const idx = names.findIndex((t) => t.includes(WANT));
if (idx < 0) {
  names.forEach((t, i) => console.log(`   ${i}: ${t.split('\n').slice(0, 2).join(' / ').slice(0, 90)}`));
  throw new Error(`no session matching "${WANT}"`);
}
await cards.nth(idx).click();
for (let i = 0; i < 90; i++) {
  if (await win.locator('text=Analysis Results').count()) break;
  await win.waitForTimeout(1000);
}
await win.waitForTimeout(4000);
await win.locator('button:has-text("Dashboard")').first().click();
await win.waitForTimeout(6000);

const panel = win.locator('#sequencing-depth-panel');
if (!(await panel.count())) throw new Error('depth panel not rendered');
await panel.scrollIntoViewIfNeeded();
await win.waitForTimeout(1200);
await panel.screenshot({ path: path.join(OUT, 'depth_panel.png') });

// Read the summary table back out of the DOM rather than trusting the picture.
const table = await panel.locator('.depth-table').innerText();
console.log('\n--- panel table ---');
console.log(table);

const rows = table.split('\n').map((l) => l.trim()).filter(Boolean);
const t3 = rows.find((l) => l.startsWith(EXPECT.tp));
if (!t3) throw new Error(`no ${EXPECT.tp} row in the panel table`);
const nums = [...t3.matchAll(/(\d+)\s*\((\d+)\)/g)].map((m) => Number(m[1]));
console.log(`\n${EXPECT.tp} medians read from the panel: ${nums.join(' vs ')}`);

let bad = 0;
for (const [i, want] of [EXPECT.Disease, EXPECT.Control].entries()) {
  const got = nums[i];
  const ok = got === want;
  if (!ok) bad++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} expected ${want}, panel shows ${got}`);
}

// The failure mode worth naming: totalSequences instead of clonedSequences.
if (bad) console.log('\n  a larger value here means the panel is counting light chains too');

const hasP = /p\s*[=<]/.test(await panel.innerText());
console.log(`  ${hasP ? 'FAIL' : 'OK  '} panel contains no p-value`);

await app.close();
process.exit(bad || hasP ? 1 : 0);
