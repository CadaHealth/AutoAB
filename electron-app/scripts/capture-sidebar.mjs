/** Sequence Browser sidebar showing clones 1166, 255 and 1541 (appendix figure).
 *  1166 sits under INCOV022, the other two under INCOV013, so both files have
 *  to be expanded before the three ids appear together. */
import { _electron as electron } from 'playwright';
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = process.argv[2];
const env = { ...process.env, NODE_ENV: 'production', AUTOAB_NO_DEVTOOLS: '1' };
delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
const app = await electron.launch({ args: [appDir], cwd: appDir, env });
let win = null;
for (let i = 0; i < 60 && !win; i++) {
  win = app.windows().find((w) => !w.url().startsWith('devtools://')) || null;
  if (!win) await new Promise((r) => setTimeout(r, 500));
}
await win.waitForLoadState('domcontentloaded');
await win.setViewportSize({ width: 1800, height: 1400 });
for (let i = 0; i < 30; i++) { if (await win.locator('text=History').count()) break; await win.waitForTimeout(1000); }
if (await win.locator('h1:has-text("Setup")').count()) { await win.locator('button:has-text("Continue")').last().click(); await win.waitForTimeout(800); }
await win.locator('text=History').first().click(); await win.waitForTimeout(1500);
const names = await win.locator('.session-card').allInnerTexts();
const idx = names.findIndex((t) => t.includes(process.env.SESSION_NAME || 'run_2026-08-11T00-27-59_bz04'));
await win.locator('.session-card').nth(idx).click();
for (let i = 0; i < 90; i++) { if (await win.locator('text=Analysis Results').count()) break; await win.waitForTimeout(1000); }
await win.waitForTimeout(5000);
await win.locator('button:has-text("Sequence Browser")').first().click().catch(() => {});
await win.waitForTimeout(5000);

for (const file of ['T1_INCOV022_filtered.fasta']) {
  const node = win.locator(`text=${file}`).first();
  if (await node.count()) {
    await node.scrollIntoViewIfNeeded().catch(() => {});
    await node.click().catch(() => {});
    await win.waitForTimeout(2500);
    console.log(`  ${file} aufgeklappt`);
  } else {
    console.log(`  ! ${file} nicht im Baum`);
  }
}
await win.waitForTimeout(2000);

const txt = await win.evaluate(() => document.body.innerText);
for (const id of ['1166', '270', '1535']) {
  console.log(`  Klon ${id}: ${txt.includes('Clone ' + id) ? 'sichtbar' : 'NICHT sichtbar'}`);
}
await win.screenshot({ path: path.join(OUT, 'fig_appendix_sequence_sidebar.png'),
                       clip: { x: 40, y: 120, width: 400, height: 1250 } });
fs.writeFileSync(path.join(OUT, 'fig_appendix_sequence_sidebar.txt'), txt);
await app.close();
console.log('fertig');
