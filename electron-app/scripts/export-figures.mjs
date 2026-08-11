/**
 * Export every publication figure through the application's own exporter.
 *
 * Going through the app matters: exportPublicationFigure() switches the charts
 * into publication mode, which redraws them at a larger size with adjusted
 * layout before serialising. Lifting the SVG straight out of the dashboard DOM
 * gives the on-screen layout instead, which is not the same figure.
 *
 * The only thing standing in the way of automating it is the native save sheet,
 * so the dialog:saveFile IPC handler is replaced with one that answers a path.
 * Everything downstream -- publication mode, the styled clone, the 3x PNG
 * rasterisation, the file write -- stays the application's own code.
 *
 *   node scripts/export-figures.mjs <outputDir>
 */
import { _electron as electron } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = process.argv[2];
if (!OUT) throw new Error('usage: export-figures.mjs <outputDir>');
fs.mkdirSync(OUT, { recursive: true });
const MARKER = path.join(OUT, '_savedialog_calls.log');

const step = (m) => console.log(`\n▶ ${m}`);

// Without NODE_ENV=production the main process serves the renderer from the
// Vite dev server on :5173 and the window stays blank with no console error.
const env = { ...process.env, NODE_ENV: 'production', AUTOAB_NO_DEVTOOLS: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

step('Launching');
const app = await electron.launch({ args: [appDir], cwd: appDir, env });
let win = null;
for (let i = 0; i < 60 && !win; i++) {
  win = app.windows().find((w) => !w.url().startsWith('devtools://')) || null;
  if (!win) await new Promise((r) => setTimeout(r, 500));
}
await win.waitForLoadState('domcontentloaded');
win.on('pageerror', (e) => console.log(`    [pageerror] ${String(e).slice(0, 200)}`));
await win.setViewportSize({ width: 1800, height: 1200 });

let ready = false;
for (let i = 0; i < 30 && !ready; i++) {
  for (const probe of ['History', 'Define Study', 'Analysis Results']) {
    if (await win.locator(`text=${probe}`).count()) { ready = true; break; }
  }
  if (!ready) await win.waitForTimeout(1000);
}
if (!ready) throw new Error('renderer stayed blank');
console.log('  ✓ renderer ready');

step('Restoring the most recent session');
await win.locator('text=History').first().click();
await win.waitForTimeout(1500);
const cards = win.locator('.session-card');
const n = await cards.count();
if (n === 0) throw new Error('no sessions listed');
const names = await cards.allInnerTexts();
// "Newest" is whatever ran last, which after a smoke test is a one-cohort,
// two-timepoint run -- not the study these figures belong to. Match by name.
const WANT = process.env.SESSION_NAME || 'LC MP vs NLC';
let idx = names.findIndex((t) => t.includes(WANT));
if (idx < 0) {
  console.log('  sessions found:');
  names.forEach((t, i) => console.log(`    ${i}: ${t.split('\n').slice(0, 2).join(' / ').slice(0, 90)}`));
  throw new Error(`no session matching "${WANT}"`);
}
console.log(`  using session ${idx}: ${names[idx].split('\n').slice(0, 2).join(' / ').slice(0, 80)}`);
await cards.nth(idx).click();
for (let i = 0; i < 90; i++) {
  if (await win.locator('text=Analysis Results').count()) break;
  await win.waitForTimeout(1000);
}
await win.waitForTimeout(4000);
await win.locator('button:has-text("Dashboard")').first().click();
await win.waitForTimeout(6000);
console.log('  ✓ dashboard open');

// The figure exporter does NOT go through the dialog:saveFile IPC channel --
// that is the CSV path. publication-export.ts builds a Blob and clicks an
// <a download>, so what pops up is Chromium's download prompt. Stubbing
// dialog.showSaveDialog or the IPC handler therefore changed nothing. The hook
// that governs a download is will-download on the session.
step('Answering downloads automatically');
await app.evaluate(({ session }, out) => {
  globalThis.__downloads = [];
  session.defaultSession.on('will-download', (_event, item) => {
    const p = `${out}/${item.getFilename()}`;
    item.setSavePath(p);
    globalThis.__downloads.push(p);
  });
  return true;
}, OUT);
console.log('  ✓ will-download handler installed');

step('Exporting through the app');
const openMenu = async () => {
  const btn = win.locator('button:has-text("Publication Figure")').first();
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  await win.waitForTimeout(900);
};

await openMenu();
const labels = await win.locator('.export-dropdown-group .export-dropdown-label').allInnerTexts();
console.log(`  figures offered: ${labels.length}`);
await win.keyboard.press('Escape').catch(() => {});
await win.waitForTimeout(400);

const stamps = () => Object.fromEntries(fs.readdirSync(OUT).filter((f) => !f.startsWith('_'))
  .map((f) => [f, fs.statSync(path.join(OUT, f)).mtimeMs]));

for (let i = 0; i < labels.length; i++) {
  for (const fmt of ['SVG', 'PNG']) {
    let done = false;
    // The very first entry failed on two consecutive runs: the menu is already
    // open from reading the labels, so the next open() closes it and the click
    // lands on nothing. Close it first, and give every export a second try.
    for (let attempt = 0; attempt < 2 && !done; attempt++) {
      await win.keyboard.press('Escape').catch(() => {});
      await win.waitForTimeout(500);
      const before = stamps();
      await openMenu();
      const group = win.locator('.export-dropdown-group').nth(i);
      await group.locator(`button.export-dropdown-item:has-text("${fmt}")`).click().catch(() => {});
      for (let t = 0; t < 20; t++) {
        await win.waitForTimeout(1000);
        const now = stamps();
        if (Object.keys(now).some((f) => !(f in before) || now[f] !== before[f])) break;
      }
      const now = stamps();
      const touched = Object.keys(now).filter((f) => !(f in before) || now[f] !== before[f]);
      if (touched.length) {
        touched.forEach((f) => console.log(`    ${labels[i]} ${fmt} -> ${f} (${Math.round(fs.statSync(path.join(OUT, f)).size / 1024)} KB)`));
        done = true;
      } else if (attempt === 0) {
        console.log(`    . ${labels[i]} ${fmt} no file, retrying`);
      } else {
        console.log(`    ! ${labels[i]} ${fmt} produced nothing`);
      }
    }
  }
}

const dl = await app.evaluate(() => globalThis.__downloads || []);
console.log(`\ndownloads intercepted: ${dl.length}`);
console.log(`files: ${fs.readdirSync(OUT).filter((f) => !f.startsWith('_')).length} -> ${OUT}`);
await app.close();
