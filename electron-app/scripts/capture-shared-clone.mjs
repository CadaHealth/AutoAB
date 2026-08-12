/** Shared Clones view at T1, scrolled to the clone the thesis highlights.
 *  The ranked list shows CDR3 sequences rather than clone numbers, so the
 *  clone is located by its junction instead of its id. */
import { _electron as electron } from 'playwright';
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = process.argv[2]; const CDR3 = process.argv[3] || 'ARDPDNWNYEGDAFDI';
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
await win.locator('button:has-text("Clones")').first().click().catch(() => {});
await win.waitForTimeout(6000);

const hit = win.locator(`text=${CDR3}`).first();
if (await hit.count()) {
  await hit.scrollIntoViewIfNeeded();
  await hit.click().catch(() => {});
  await win.waitForTimeout(3000);
  console.log(`  ${CDR3} gefunden und ausgewählt`);
} else {
  console.log(`  ! ${CDR3} nicht in der Liste`);
  // Fall back to showing the Shared Clones section itself.
  // The section is collapsed on arrival; its header toggles it open.
  for (const sel of ['text=Shared Clones per timepoint', 'text=Shared Clones']) {
    const sec = win.locator(sel).first();
    if (await sec.count()) {
      await sec.scrollIntoViewIfNeeded().catch(() => {});
      await sec.click().catch(() => {});
      await win.waitForTimeout(3000);
      break;
    }
  }
  const again = win.locator(`text=${CDR3}`).first();
  if (await again.count()) {
    await again.scrollIntoViewIfNeeded(); await again.click().catch(() => {});
    await win.waitForTimeout(2500);
    console.log(`  ${CDR3} nach Aufklappen gefunden`);
  } else {
    console.log('  Abschnitt aufgeklappt, Klon weiterhin nicht als Text auffindbar');
  }
}
await win.screenshot({ path: path.join(OUT, 'clone_view_shared_clones_881.png') });
fs.writeFileSync(path.join(OUT, 'clone_view_shared_clones_881.txt'), await win.evaluate(() => document.body.innerText));
await app.close();
console.log('fertig');
