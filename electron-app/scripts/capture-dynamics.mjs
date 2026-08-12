/** Clonal dynamics views: heatmap, bubbles and isotype tiles, per cohort. */
import { _electron as electron } from 'playwright';
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = process.argv[2]; fs.mkdirSync(OUT, { recursive: true });
const env = { ...process.env, NODE_ENV: 'production', AUTOAB_NO_DEVTOOLS: '1' };
delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
const app = await electron.launch({ args: [appDir], cwd: appDir, env });
let win = null;
for (let i = 0; i < 60 && !win; i++) {
  win = app.windows().find((w) => !w.url().startsWith('devtools://')) || null;
  if (!win) await new Promise((r) => setTimeout(r, 500));
}
await win.waitForLoadState('domcontentloaded');
await win.setViewportSize({ width: 1900, height: 1250 });
for (let i = 0; i < 30; i++) { if (await win.locator('text=History').count()) break; await win.waitForTimeout(1000); }
if (await win.locator('h1:has-text("Setup")').count()) { await win.locator('button:has-text("Continue")').last().click(); await win.waitForTimeout(800); }
await win.locator('text=History').first().click(); await win.waitForTimeout(1500);
const names = await win.locator('.session-card').allInnerTexts();
const idx = names.findIndex((t) => t.includes(process.env.SESSION_NAME || 'run_2026-08-11T00-27-59_bz04'));
await win.locator('.session-card').nth(idx).click();
for (let i = 0; i < 90; i++) { if (await win.locator('text=Analysis Results').count()) break; await win.waitForTimeout(1000); }
await win.waitForTimeout(5000);

await win.locator('button:has-text("Clones")').first().click().catch(() => {});
await win.waitForTimeout(6000);

// Open the collapsed Clonal Dynamics section.
// Expand every collapsed section on the page, the way the dashboard capture
// does -- targeting the dynamics header alone kept leaving it closed.
for (const h of await win.locator('button.section-header').all()) {
  await h.scrollIntoViewIfNeeded().catch(() => {});
  const body = h.locator('xpath=following-sibling::div[1]');
  const hidden = await body.evaluate((el) => el.classList.contains('section-hidden')).catch(() => false);
  if (hidden) { await h.click().catch(() => {}); await win.waitForTimeout(1500); }
}
await win.waitForTimeout(4000);
console.log(await win.locator('button:has-text("Heatmap")').count() ? '  Abschnitt offen' : '  ! Abschnitt weiterhin zu');

for (const cohort of ['Disease', 'Control']) {
  const chip = win.locator(`button:has-text("${cohort}"), .chip:has-text("${cohort}")`).last();
  if (await chip.count()) { await chip.click().catch(() => {}); await win.waitForTimeout(3500); }
  for (const view of ['Heatmap', 'Bubbles', 'Isotype']) {
    const btn = win.locator(`button:has-text("${view}")`).last();
    if (!(await btn.count())) { console.log(`  ! ${view} nicht gefunden`); continue; }
    await btn.click().catch(() => {});
    await win.waitForTimeout(4500);
    const f = `dynamics_${cohort.toLowerCase()}_${view.toLowerCase()}.png`;
    await win.screenshot({ path: path.join(OUT, f) });
    console.log(`  ${f}`);
  }
}
fs.writeFileSync(path.join(OUT, 'dynamics_text.txt'), await win.evaluate(() => document.body.innerText));
await app.close();
console.log('fertig');
