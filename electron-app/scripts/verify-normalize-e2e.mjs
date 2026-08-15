/**
 * Close the gaps the other checks do not cover, and capture the UI.
 *
 * verify-normalize-ui.mjs proves the toggle and the invariant. This one covers
 * what was written but never exercised: the CSV provenance line, the
 * clone-assigned depth column, session persistence of the setting, and the
 * trajectory chart under normalisation. It also writes the screenshots.
 *
 *   node scripts/verify-normalize-e2e.mjs <outputDir>
 */
import { _electron as electron } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = process.argv[2] || path.join(appDir, 'figures');
fs.mkdirSync(OUT, { recursive: true });

const env = { ...process.env, NODE_ENV: 'production', AUTOAB_NO_DEVTOOLS: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

let failures = 0;
const fail = (m) => { console.log(`  FAIL  ${m}`); failures++; };
const pass = (m) => console.log(`  ok    ${m}`);
const shot = async (loc, name) => {
  await loc.scrollIntoViewIfNeeded();
  await loc.page().waitForTimeout(900);
  await loc.screenshot({ path: path.join(OUT, name) });
  console.log(`  shot  ${name}`);
};

const app = await electron.launch({ args: [appDir], cwd: appDir, env });
let win = null;
for (let i = 0; i < 60 && !win; i++) {
  win = app.windows().find((w) => !w.url().startsWith('devtools://')) || null;
  if (!win) await new Promise((r) => setTimeout(r, 500));
}
await win.waitForLoadState('domcontentloaded');
await win.setViewportSize({ width: 1700, height: 1150 });
win.on('pageerror', (e) => { console.log(`  [pageerror] ${String(e).slice(0, 200)}`); failures++; });

let ready = false;
for (let i = 0; i < 30 && !ready; i++) {
  if (await win.locator('text=History').count()) { ready = true; break; }
  await win.waitForTimeout(1000);
}
if (!ready) throw new Error('renderer stayed blank');

// Two different save paths, and they need two different stubs.
//
// Figure export builds a Blob and clicks an <a download>, so it is governed by
// will-download on the session. CSV export calls window.electronAPI.saveFile,
// which reaches dialog.showSaveDialog in the main process and puts a real,
// native save sheet on the user's screen. Stubbing only the first one leaves
// that sheet sitting there waiting for a human.
await app.evaluate(({ session, dialog }, out) => {
  globalThis.__dl = [];
  session.defaultSession.on('will-download', (_e, item) => {
    const p = `${out}/${item.getFilename()}`;
    item.setSavePath(p);
    globalThis.__dl.push(p);
  });
  let n = 0;
  dialog.showSaveDialog = async (_win, opts) => {
    const name = (opts && opts.defaultPath) || `export_${n++}.csv`;
    return { canceled: false, filePath: `${out}/${name.split('/').pop()}` };
  };
}, OUT);

await win.locator('text=History').first().click();
await win.waitForTimeout(1500);
const cards = win.locator('.session-card');
const names = await cards.allInnerTexts();
const WANT = process.env.SESSION_NAME || 'bz04';
const idx = names.findIndex((t) => t.includes(WANT));
if (idx < 0) throw new Error(`no session matching "${WANT}"`);
await cards.nth(idx).click();
for (let i = 0; i < 90; i++) {
  if (await win.locator('text=Analysis Results').count()) break;
  await win.waitForTimeout(1000);
}
await win.waitForTimeout(4000);
await win.locator('button:has-text("Dashboard")').first().click();
await win.waitForTimeout(6000);

// ---------------------------------------------------------------- normalized off
console.log('\n=== export with normalization OFF ===');
const exportBtn = win.locator('button[title*="per-sample metrics"]');
const csvBefore = fs.readdirSync(OUT).filter((f) => f.endsWith('.csv'));
await exportBtn.click();
for (let i = 0; i < 20; i++) {
  await win.waitForTimeout(1000);
  if (fs.readdirSync(OUT).filter((f) => f.endsWith('.csv')).length > csvBefore.length) break;
}
let csvPath = fs.readdirSync(OUT).filter((f) => f.endsWith('.csv')).map((f) => path.join(OUT, f))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
if (!csvPath) { fail('no CSV was produced'); }
else {
  const head = fs.readFileSync(csvPath, 'utf8').split('\n').slice(0, 4);
  console.log(head.map((l) => `        ${l.slice(0, 110)}`).join('\n'));
  if (/^# Depth normalization: off/.test(head[0])) pass('provenance line says off');
  else fail(`provenance line wrong: ${head[0]}`);
  if (/Clone-Assigned Sequences/.test(head[2])) pass('clone-assigned depth column present');
  else fail('clone-assigned depth column missing from header');
  fs.rmSync(csvPath);
}

await shot(win.locator('#sequencing-depth-panel'), 'ui_1_depth_panel.png');
await shot(win.locator('.norm-bar'), 'ui_2_toggle_off.png');

// ---------------------------------------------------------------- normalized on
console.log('\n=== normalization ON at depth 10 ===');
await win.locator('.norm-toggle input[type="checkbox"]').check();
await win.waitForTimeout(2500);
const depthInput = win.locator('.norm-depth input');
await depthInput.fill('10');
await depthInput.dispatchEvent('input');
await win.waitForTimeout(7000);

await shot(win.locator('.norm-bar'), 'ui_3_toggle_on.png');
await shot(win.locator('.norm-detail'), 'ui_4_retention.png');
await shot(win.locator('.metric-card-box').first(), 'ui_5_shannon_card.png');
await shot(win.locator('#per-patient-trajectory-chart'), 'ui_6_trajectory.png');

const traj = await win.locator('#per-patient-trajectory-chart').innerText();
if (/Depth-normalized to 10 sequences per patient/.test(traj)) pass('trajectory chart declares the depth');
else fail('trajectory chart does not declare that it is normalized');
if (/SEM between patients/.test(traj)) pass('SEM band is labelled as between-patient spread');
else fail('SEM band label missing');

console.log('\n=== export with normalization ON ===');
const before2 = fs.readdirSync(OUT).filter((f) => f.endsWith('.csv'));
await exportBtn.scrollIntoViewIfNeeded();
await exportBtn.click();
for (let i = 0; i < 20; i++) {
  await win.waitForTimeout(1000);
  if (fs.readdirSync(OUT).filter((f) => f.endsWith('.csv')).length > before2.length) break;
}
csvPath = fs.readdirSync(OUT).filter((f) => f.endsWith('.csv')).map((f) => path.join(OUT, f))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
if (!csvPath) fail('no CSV produced with normalization on');
else {
  const head = fs.readFileSync(csvPath, 'utf8').split('\n').slice(0, 2);
  console.log(head.map((l) => `        ${l.slice(0, 130)}`).join('\n'));
  if (/depth=10/.test(head[0]) && /replicates=500/.test(head[0]) && /seed=42/.test(head[0])) {
    pass('provenance line carries depth, replicates and seed');
  } else fail(`provenance line incomplete: ${head[0]}`);
  fs.rmSync(csvPath);
}

// ---------------------------------------------------------------- persistence
console.log('\n=== session history carries the setting ===');
const stored = await win.evaluate(() => {
  const raw = localStorage.getItem('bcr_sessions');
  if (!raw) return null;
  return JSON.parse(raw).map((s) => ({ dir: s.outputDir, dn: s.depthNormalization }))
    .filter((s) => s.dn);
});
console.log(`        ${JSON.stringify(stored)}`);
if (stored && stored.some((s) => s.dn.enabled && s.dn.depth === 10 && s.dn.replicates === 500 && s.dn.seed === 42)) {
  pass('depthNormalization persisted with depth, replicates and seed');
} else fail('depthNormalization not persisted to session history');

// ---------------------------------------------------------------- publication mode
console.log('\n=== publication figure export while normalized ===');
const pubBtn = win.locator('button:has-text("Publication Figure")').first();
if (await pubBtn.count()) {
  const dlBefore = (await app.evaluate(() => globalThis.__dl.length));
  await pubBtn.scrollIntoViewIfNeeded();
  await pubBtn.click();
  await win.waitForTimeout(900);
  const group = win.locator('.export-dropdown-group').filter({ hasText: 'Group Comparison' }).first();
  const target = (await group.count()) ? group : win.locator('.export-dropdown-group').first();
  await target.locator('button.export-dropdown-item:has-text("PNG")').click().catch(() => {});
  for (let i = 0; i < 25; i++) {
    await win.waitForTimeout(1000);
    if ((await app.evaluate(() => globalThis.__dl.length)) > dlBefore) break;
  }
  const dl = await app.evaluate(() => globalThis.__dl);
  if (dl.length > dlBefore) {
    const f = dl[dl.length - 1];
    const kb = fs.existsSync(f) ? Math.round(fs.statSync(f).size / 1024) : 0;
    if (kb > 20) pass(`publication export produced ${path.basename(f)} (${kb} KB)`);
    else fail(`publication export produced a suspiciously small file (${kb} KB)`);
  } else fail('publication export produced nothing while normalized');
} else fail('publication figure button not found');

await app.close();
console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
