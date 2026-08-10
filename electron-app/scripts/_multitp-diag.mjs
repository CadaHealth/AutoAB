/** Diagnose why step 1 will not advance with two timepoints. */
import { _electron as electron } from 'playwright';
import fs from 'fs';

const target = process.argv[2], T1 = process.argv[3], T2 = process.argv[4];
const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME, USER: process.env.USER, TMPDIR: process.env.TMPDIR, NODE_ENV: 'production' };

const app = await electron.launch({ args: [target], cwd: target, env });
let win = null;
for (let i = 0; i < 40 && !win; i++) { win = app.windows().find(w => !w.url().startsWith('devtools://')) || null; if (!win) await new Promise(r => setTimeout(r, 500)); }
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(1500);
if (await win.locator('h1:has-text("Setup")').count()) await win.locator('button:has-text("Continue")').last().click();

const calls = [];
await app.evaluate(({ ipcMain }, dirs) => {
  globalThis.__pickCount = 0;
  for (const ch of ['dialog:selectDirectory']) ipcMain.removeHandler(ch);
  ipcMain.handle('dialog:selectDirectory', () => {
    const d = dirs[Math.min(globalThis.__pickCount++, dirs.length - 1)];
    const files = require('fs').readdirSync(d).filter(f => /\.(fasta|fa)$/i.test(f));
    console.log('[stub] selectDirectory ->', d, files.length, 'files');
    return { canceled: false, path: d, files, mode: 'flat', detectedTimepoints: [] };
  });
}, [T1, T2]);

await win.waitForSelector('text=Define Study', { timeout: 30000 });
await win.fill('input[placeholder*="Memory Loss"]', 'diag');

const dumpButtons = async (tag) => {
  const texts = await win.locator('button').allInnerTexts();
  console.log(`\n[${tag}] buttons:`, JSON.stringify(texts.map(t => t.replace(/\s+/g, ' ').trim().slice(0, 34)).filter(Boolean)));
};

await win.click('button:has-text("Add First Timepoint")');
await win.waitForTimeout(1200);
await dumpButtons('nach Add First');

await win.locator('button', { hasText: /select folder|choose folder|browse|select directory|add files/i }).first().click();
await win.waitForTimeout(2500);
console.log('\n[nach Ordner 1] Kartentext:', (await win.locator('body').innerText()).replace(/\s+/g, ' ').match(/Timepoint.{0,220}/)?.[0]);

await win.click('button:has-text("Add Timepoint")');
await win.waitForTimeout(1500);
await dumpButtons('nach Add Timepoint');

const pickers = await win.locator('button', { hasText: /select folder|choose folder|browse|select directory|add files/i }).all();
console.log(`\n[picker] ${pickers.length} Kandidaten`);
for (let i = 0; i < pickers.length; i++) console.log(`   ${i}: "${(await pickers[i].innerText()).replace(/\s+/g, ' ').trim()}"`);

if (pickers.length > 1) { await pickers[pickers.length - 1].click(); await win.waitForTimeout(2500); }

console.log('\n[nach Ordner 2] Body:', (await win.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 700));
const cont = win.locator('button:has-text("Continue")').last();
console.log('\nContinue disabled:', await cont.isDisabled());

await win.screenshot({ path: 'multitp-diag.png' });
await app.close();
