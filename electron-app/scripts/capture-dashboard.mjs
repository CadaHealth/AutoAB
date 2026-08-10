/**
 * Capture the dashboard figures from the most recent saved session.
 *
 * Restores through the session sidebar rather than re-running the pipeline, so
 * the images come from result files already on disk.
 *
 *   node scripts/capture-dashboard.mjs <outputDir>
 */
import { _electron as electron } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHOTS = process.argv[2] || path.join(appDir, 'figures');
fs.mkdirSync(SHOTS, { recursive: true });

const step = (m) => console.log(`\n▶ ${m}`);
const ok = (m) => console.log(`  ✓ ${m}`);

const env = { ...process.env, NODE_ENV: 'production', AUTOAB_NO_DEVTOOLS: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

step('Launching application');
const app = await electron.launch({ args: [appDir], cwd: appDir, env });
let win = null;
for (let i = 0; i < 60 && !win; i++) {
  win = app.windows().find((w) => !w.url().startsWith('devtools://')) || null;
  if (!win) await new Promise((r) => setTimeout(r, 500));
}
await win.waitForLoadState('domcontentloaded');
await win.setViewportSize({ width: 1700, height: 1150 });
await win.waitForTimeout(2500);

if (await win.locator('h1:has-text("Setup")').count()) {
  await win.locator('button:has-text("Continue")').last().click();
  await win.waitForTimeout(800);
  ok('setup dismissed');
}

step('Restoring the most recent session');
await win.locator('text=History').first().click();
await win.waitForTimeout(1500);
const cards = win.locator('.session-card');
const n = await cards.count();
console.log(`  sessions listed: ${n}`);
if (n === 0) throw new Error('no sessions in the sidebar');
await cards.first().click();

for (let i = 0; i < 60; i++) {
  if (await win.locator('text=Analysis Results').count()) break;
  await win.waitForTimeout(1000);
}
if (!(await win.locator('text=Analysis Results').count())) {
  await win.screenshot({ path: path.join(SHOTS, 'ZZ_restore_failed.png') });
  throw new Error('session did not restore:\n' + (await win.evaluate(() => document.body.innerText)).slice(0, 1000));
}
ok('session restored');
await win.waitForTimeout(4000);

step('Opening the Dashboard tab');
await win.locator('button:has-text("Dashboard")').first().click();
await win.waitForTimeout(6000);
await win.screenshot({ path: path.join(SHOTS, '10_dashboard_full.png'), fullPage: true });
ok('full dashboard captured');

step('Capturing individual charts');
const panels = win.locator('section.chart-panel');
const count = await panels.count();
console.log(`  chart panels: ${count}`);
for (let i = 0; i < count; i++) {
  const p = panels.nth(i);
  const heading = (await p.locator('h3.chart-heading').first().innerText().catch(() => `panel${i}`)).trim();
  const slug = heading.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48);
  await p.scrollIntoViewIfNeeded().catch(() => {});
  await win.waitForTimeout(700);
  const file = path.join(SHOTS, `fig_${String(i + 1).padStart(2, '0')}_${slug}.png`);
  await p.screenshot({ path: file }).catch((e) => console.log(`    ! ${slug}: ${e.message.slice(0, 60)}`));
  console.log(`    ${path.basename(file)}  <- "${heading}"`);
}

// The metric cards carry the headline numbers the thesis quotes in text.
const metrics = await win.locator('.metric-card').allInnerTexts().catch(() => []);
fs.writeFileSync(path.join(SHOTS, 'dashboard_metrics.txt'), metrics.join('\n---\n'));
fs.writeFileSync(path.join(SHOTS, 'dashboard_text.txt'), await win.evaluate(() => document.body.innerText));
ok(`written to ${SHOTS}`);
await app.close();
