/** Capture the Group Comparison boxplots, the source of thesis Figures 4.15/4.16. */
import { _electron as electron } from 'playwright';
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHOTS = process.argv[2]; fs.mkdirSync(SHOTS, { recursive: true });
const env = { ...process.env, NODE_ENV: 'production', AUTOAB_NO_DEVTOOLS: '1' };
delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;

const app = await electron.launch({ args: [appDir], cwd: appDir, env });
let win = null;
for (let i = 0; i < 60 && !win; i++) {
  win = app.windows().find(w => !w.url().startsWith('devtools://')) || null;
  if (!win) await new Promise(r => setTimeout(r, 500));
}
await win.waitForLoadState('domcontentloaded');
await win.setViewportSize({ width: 1700, height: 1150 });
await win.waitForTimeout(2500);
if (await win.locator('h1:has-text("Setup")').count()) {
  await win.locator('button:has-text("Continue")').last().click(); await win.waitForTimeout(800);
}
await win.locator('text=History').first().click(); await win.waitForTimeout(1500);
await win.locator('.session-card').first().click();
for (let i = 0; i < 60; i++) {
  if (await win.locator('text=Analysis Results').count()) break;
  await win.waitForTimeout(1000);
}
await win.waitForTimeout(4000);
await win.locator('button:has-text("Dashboard")').first().click();
await win.waitForTimeout(6000);

// The section starts collapsed; its header toggles it.
const header = win.locator('button.section-header', { has: win.locator('h3:has-text("Group Comparison")') }).first();
await header.scrollIntoViewIfNeeded();
const body = win.locator('section.collapsible-section', { has: win.locator('h3:has-text("Group Comparison")') }).locator('.section-body').first();
if (await body.evaluate(el => el.classList.contains('section-hidden')).catch(() => false)) {
  await header.click(); await win.waitForTimeout(2500);
  console.log('  section expanded');
}
await win.waitForTimeout(4000);

const section = win.locator('section.collapsible-section', { has: win.locator('h3:has-text("Group Comparison")') }).first();
await section.screenshot({ path: path.join(SHOTS, 'fig_19_Group_Comparison_all.png') });
console.log('  fig_19_Group_Comparison_all.png');

// Each metric renders its own chart block inside the section.
const blocks = section.locator('.chart-block, .comparison-chart, svg');
const n = await blocks.count();
console.log(`  blocks: ${n}`);
for (let i = 0; i < Math.min(n, 12); i++) {
  await blocks.nth(i).screenshot({ path: path.join(SHOTS, `fig_20_groupcmp_${String(i).padStart(2, '0')}.png`) }).catch(() => {});
}
fs.writeFileSync(path.join(SHOTS, 'group_comparison_text.txt'), await section.innerText());
await app.close();
console.log('done');
