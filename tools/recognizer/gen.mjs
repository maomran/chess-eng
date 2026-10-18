// Usage: node gen.mjs OUT_PREFIX TOTAL CHUNK SEED "set1,set2,font:DejaVu Sans" CHECK_DETECT(0|1) [SAVE_N_SCREENSHOTS]
import { chromium } from 'playwright';
import fs from 'fs';
const [,, out, total, chunk, seed0, setsArg, checkDetect, saveShots] = process.argv;
const sets = setsArg.split(',');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('pageerror', e.message));
await page.goto(process.env.SYNTH_URL || 'http://localhost:8766/app/tools/recognizer/synth.html');
await page.waitForFunction(() => window.synthReady);
if (saveShots) {
  for (let i = 0; i < +saveShots; i++) {
    const url = await page.evaluate(async ([sets, i]) => { synth.seed(1000 + i); const s = await synth.makeScreenshot(sets); return s.canvas.toDataURL('image/png'); }, [sets, i]);
    fs.writeFileSync(`${out}-shot${i}.png`, Buffer.from(url.split(',')[1], 'base64'));
  }
}
const fd = fs.openSync(`${out}.u8`, 'w');
const labels = [];
let det = 0, n = 0;
for (let done = 0, k = 0; done < +total; done += +chunk, k++) {
  const r = await page.evaluate(([n, sets, seed, cd]) => synth.batch(n, sets, seed, 0.25, cd), [+chunk, sets, +seed0 + k * 7919, checkDetect === '1']);
  fs.writeSync(fd, Buffer.from(r.feats, 'base64'));
  labels.push(...r.labels);
  det += r.detected; n += r.n;
  if (r.misses.length && checkDetect === '1') console.error('misses', JSON.stringify(r.misses.slice(0, 3)));
}
fs.closeSync(fd);
fs.writeFileSync(`${out}.labels.json`, JSON.stringify(labels));
console.log(JSON.stringify({ screenshots: n, samples: labels.length, detectRate: checkDetect === '1' ? det / n : null }));
await browser.close();
