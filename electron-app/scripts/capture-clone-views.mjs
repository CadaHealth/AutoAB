/**
 * Capture the three result views that name a specific clone, from the current
 * run: Sequence Browser (clone 1166), Shared Clones at T1 (clone 881) and
 * COVID-DB Matching (clone 5134).
 *
 * Clone identifiers are assigned per run, so these three figures cannot be
 * carried over from an earlier analysis -- the same number means a different
 * clone there.
 *
 *   node scripts/capture-clone-views.mjs <outputDir>
 */
import { _electron as electron } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = process.argv[2];
fs.mkdirSync(OUT, { recursive: true });
const SESSION = process.env.SESSION_NAME || 'run_2026-08-11T00-27-59_bz04';
const step = (m) => console.log(`\n▶ ${m}`);

const env = { ...process.env, NODE_ENV: 'production', AUTOAB_NO_DEVTOOLS: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

const app = await electron.launch({ args: [appDir], cwd: appDir, env });
let win = null;
for (let i = 0; i < 60 && !win; i++) {
  win = app.windows().find((w) => !w.url().startsWith('devtools://')) || null;
  if (!win) await new Promise((r) => setTimeout(r, 500));
}
await win.waitForLoadState('domcontentloaded');
await win.setViewportSize({ width: 1800, height: 1200 });
for (let i = 0; i < 30; i++) {
  if (await win.locator('text=History').count()) break;
  await win.waitForTimeout(1000);
}
if (await win.locator('h1:has-text("Setup")').count()) {
  await win.locator('button:has-text("Continue")').last().click();
  await win.waitForTimeout(800);
}

step('Restoring the study session');
await win.locator('text=History').first().click();
await win.waitForTimeout(1500);
const names = await win.locator('.session-card').allInnerTexts();
const idx = names.findIndex((t) => t.includes(SESSION));
if (idx < 0) throw new Error(`session ${SESSION} not listed`);
await win.locator('.session-card').nth(idx).click();
for (let i = 0; i < 90; i++) {
  if (await win.locator('text=Analysis Results').count()) break;
  await win.waitForTimeout(1000);
}
await win.waitForTimeout(5000);

async function openTab(name) {
  await win.locator(`button:has-text("${name}")`).first().click().catch(() => {});
  await win.waitForTimeout(5000);
}

/** Click the first element whose text contains the clone number. */
async function pickClone(id) {
  for (const sel of [`text=Clone ${id}`, `text=clone ${id}`, `text=${id}`]) {
    const el = win.locator(sel).first();
    if (await el.count()) {
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await el.click().catch(() => {});
      await win.waitForTimeout(3500);
      return true;
    }
  }
  return false;
}

const jobs = [
  { tab: 'Sequence Browser', clone: 1166, file: 'clone_view_sequence_browser_1166.png' },
  { tab: 'Clones',           clone: 881,  file: 'clone_view_shared_clones_881.png' },
  { tab: 'COVID-DB Matching', clone: 5134, file: 'clone_view_covid_5134.png' },
];

for (const j of jobs) {
  step(`${j.tab} -> clone ${j.clone}`);
  await openTab(j.tab);
  const hit = await pickClone(j.clone);
  console.log(hit ? `  clone ${j.clone} selected` : `  ! clone ${j.clone} not found on screen`);
  await win.screenshot({ path: path.join(OUT, j.file) });
  const txt = await win.evaluate(() => document.body.innerText).catch(() => '');
  fs.writeFileSync(path.join(OUT, j.file.replace('.png', '.txt')), txt);
  console.log(`  ${j.file}`);
}

await app.close();
console.log('\ndone');
