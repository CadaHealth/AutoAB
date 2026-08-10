import { _electron as electron } from 'playwright';
const [,, target, T1, T2] = process.argv;
const env = { PATH:'/usr/bin:/bin:/usr/sbin:/sbin', HOME:process.env.HOME, USER:process.env.USER, TMPDIR:process.env.TMPDIR, NODE_ENV:'production' };
const app = await electron.launch({ args:[target], cwd:target, env });
app.process().stdout.on('data', d => { const s=d.toString(); if(/stub|selectDirectory|IPC/i.test(s)) process.stdout.write('[main] '+s); });
let win=null; for(let i=0;i<40&&!win;i++){win=app.windows().find(w=>!w.url().startsWith('devtools://'))||null; if(!win)await new Promise(r=>setTimeout(r,500));}
await win.waitForLoadState('domcontentloaded'); await win.waitForTimeout(1500);
if (await win.locator('h1:has-text("Setup")').count()) await win.locator('button:has-text("Continue")').last().click();
win.on('console', m => { const t=m.text(); if(/select|folder|timepoint|error/i.test(t)) console.log('[renderer]', t.slice(0,180)); });
await app.evaluate(({ipcMain}, dirs) => {
  globalThis.__n=0;
  ipcMain.removeHandler('dialog:selectDirectory');
  ipcMain.handle('dialog:selectDirectory', () => {
    const d = dirs[Math.min(globalThis.__n++, dirs.length-1)];
    const files = require('fs').readdirSync(d).filter(f=>/\.(fasta|fa)$/i.test(f));
    console.log('[IPC stub] ->', d, files.length);
    return { canceled:false, path:d, files, mode:'flat', detectedTimepoints:[] };
  });
}, [T1,T2]);
await win.waitForSelector('text=Define Study', {timeout:30000});
await win.fill('input[placeholder*="Memory Loss"]', 'diag');
await win.click('button:has-text("Add First Timepoint")'); await win.waitForTimeout(1200);
await win.locator('button:has-text("Select Folder")').first().click();
await win.waitForTimeout(3000);
console.log('KARTE:', (await win.locator('body').innerText()).replace(/\s+/g,' ').match(/TIMEPOINTS.{0,180}/)?.[0]);
await app.close();
