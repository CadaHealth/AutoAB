/** Sequence Browser with a sequence actually selected, so the detail panel
 *  (V(D)J calls, CDR3, clone membership) is visible -- expanding the clone
 *  alone leaves the right pane on "No Sequence Selected". */
import { _electron as electron } from 'playwright';
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = process.argv[2];
const CLONE = process.argv[3] || '1166';
const env = { ...process.env, NODE_ENV: 'production', AUTOAB_NO_DEVTOOLS: '1' };
delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
const app = await electron.launch({ args: [appDir], cwd: appDir, env });
let win = null;
for (let i = 0; i < 60 && !win; i++) {
  win = app.windows().find((w) => !w.url().startsWith('devtools://')) || null;
  if (!win) await new Promise((r) => setTimeout(r, 500));
}
await win.waitForLoadState('domcontentloaded');
await win.setViewportSize({ width: 1800, height: 1200 });
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

const clone = win.locator(`text=Clone ${CLONE}`).first();
await clone.scrollIntoViewIfNeeded().catch(() => {});
await clone.click().catch(() => {});
await win.waitForTimeout(3000);

// Sequence ids look like INCOV###_..._contig_#; click the first one listed.
const seq = win.locator('text=/INCOV\\d+_.*contig_\\d+/').first();
if (await seq.count()) {
  await seq.scrollIntoViewIfNeeded().catch(() => {});
  await seq.click().catch(() => {});
  await win.waitForTimeout(3500);
  console.log(`  Sequenz ausgewählt: ${(await seq.innerText().catch(() => '?')).slice(0, 60)}`);
} else {
  console.log('  ! keine Sequenz im Baum gefunden');
}
const txt = await win.evaluate(() => document.body.innerText);
console.log(txt.includes('No Sequence Selected') ? '  !! Detailpanel weiterhin leer' : '  Detailpanel gefüllt');
await win.screenshot({ path: path.join(OUT, `clone_view_sequence_browser_${CLONE}.png`) });
fs.writeFileSync(path.join(OUT, `clone_view_sequence_browser_${CLONE}.txt`), txt);
await app.close();
console.log('fertig');
