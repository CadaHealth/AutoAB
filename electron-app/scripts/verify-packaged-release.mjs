/**
 * Verify a packaged Clono.app, not the checkout.
 *
 * Running from source proves the code is right. It does not prove the bundle
 * is: the .app resolves its tools from Resources, runs an embedded interpreter,
 * and is subject to the hardened runtime. This checks that the release actually
 * carries the depth diagnostic and the normalisation mode, with the same
 * assertions used against the source tree.
 *
 *   node scripts/verify-packaged-release.mjs <path/to/Clono.app>
 */
import { _electron as electron } from 'playwright';
import fs from 'fs';
import path from 'path';

const appPath = process.argv[2];
if (!appPath) throw new Error('usage: verify-packaged-release.mjs <path/to/Clono.app>');
const exe = path.join(appPath, 'Contents/MacOS/Clono');
if (!fs.existsSync(exe)) throw new Error(`no executable at ${exe}`);

let failures = 0;
const fail = (m) => { console.log(`  FAIL  ${m}`); failures++; };
const pass = (m) => console.log(`  ok    ${m}`);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
delete env.NODE_ENV;

console.log(`▶ ${appPath}`);
const app = await electron.launch({ executablePath: exe, args: [], env });
let win = null;
for (let i = 0; i < 90 && !win; i++) {
  win = app.windows().find((w) => !w.url().startsWith('devtools://')) || null;
  if (!win) await new Promise((r) => setTimeout(r, 500));
}
if (!win) throw new Error('no application window appeared');
await win.waitForLoadState('domcontentloaded');
await win.setViewportSize({ width: 1700, height: 1150 });
win.on('pageerror', (e) => { console.log(`  [pageerror] ${String(e).slice(0, 200)}`); failures++; });

let ready = false;
for (let i = 0; i < 40 && !ready; i++) {
  for (const probe of ['History', 'Define Study', 'Analysis Results', 'Setup']) {
    if (await win.locator(`text=${probe}`).count()) { ready = true; break; }
  }
  if (!ready) await win.waitForTimeout(1000);
}
if (!ready) throw new Error('renderer stayed blank in the packaged app');
pass('packaged app launched and rendered');

if (await win.locator('h1:has-text("Setup")').count()) {
  await win.locator('button:has-text("Continue")').last().click().catch(() => {});
  await win.waitForTimeout(1000);
}

await win.locator('text=History').first().click();
await win.waitForTimeout(2000);
const cards = win.locator('.session-card');
const names = await cards.allInnerTexts();
const WANT = process.env.SESSION_NAME || 'bz04';
const idx = names.findIndex((t) => t.includes(WANT));
if (idx < 0) {
  console.log('  sessions:'); names.forEach((t, i) => console.log(`    ${i}: ${t.split('\n')[0]}`));
  throw new Error(`no session matching "${WANT}"`);
}
await cards.nth(idx).click();
for (let i = 0; i < 120; i++) {
  if (await win.locator('text=Analysis Results').count()) break;
  await win.waitForTimeout(1000);
}
await win.waitForTimeout(5000);
await win.locator('button:has-text("Dashboard")').first().click();
await win.waitForTimeout(8000);
pass('session restored in the packaged app');

// --- depth diagnostic ------------------------------------------------------
const panel = win.locator('#sequencing-depth-panel');
if (!(await panel.count())) fail('depth panel absent from the packaged build');
else {
  await panel.scrollIntoViewIfNeeded();
  await win.waitForTimeout(1200);
  const table = await panel.locator('.depth-table').innerText().catch(() => '');
  const t3 = table.split('\n').map((l) => l.trim()).find((l) => l.startsWith('T3'));
  const nums = t3 ? [...t3.matchAll(/(\d+)\s*\((\d+)\)/g)].map((m) => Number(m[1])) : [];
  if (nums[0] === 123 && nums[1] === 26) pass(`depth medians ${nums[0]} vs ${nums[1]}`);
  else fail(`depth medians read ${nums.join(' vs ')}, expected 123 vs 26`);
  if (/p\s*[=<]/.test(await panel.innerText())) fail('depth panel shows a p-value');
  else pass('depth panel shows no p-value');
}

// --- normalisation ---------------------------------------------------------
const chart = win.locator('#group-comparison-chart');
await chart.scrollIntoViewIfNeeded();
await win.waitForTimeout(1500);
const before = (await chart.innerText()).replace(/\s+/g, ' ').trim();

const toggle = win.locator('.norm-toggle input[type="checkbox"]');
if (!(await toggle.count())) fail('normalize toggle absent from the packaged build');
else {
  await toggle.check();
  await win.waitForTimeout(3000);
  const depthInput = win.locator('.norm-depth input');
  await depthInput.fill('10');
  await depthInput.dispatchEvent('input');
  await win.waitForTimeout(8000);

  const on = (await chart.innerText()).replace(/\s+/g, ' ').trim();
  if (/unnormalized p/.test(on)) pass('unnormalized p-value stays visible');
  else fail('unnormalized p-value missing');
  if (/max ln\(10\)/.test(on)) pass('ceiling note present');
  else fail('ceiling note missing');

  const retention = await win.locator('.retention-table').innerText().catch(() => '');
  if (/T3\s+19 of 19\s+11 of 11/.test(retention.replace(/\t/g, ' '))) pass('T3 retention 19/19 and 11/11');
  else fail(`retention wrong:\n${retention}`);

  await toggle.uncheck();
  await win.waitForTimeout(5000);
  const after = (await chart.innerText()).replace(/\s+/g, ' ').trim();
  if (after === before) pass('toggling off restores the original output exactly');
  else fail('output changed after toggling off again');
}

await app.close();
console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
