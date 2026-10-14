// 走査の帯の値 q = ΔE · k / π の分布(8 bit の符号化のレンジを決める材料)。手順 10-3。
//
//   node tools/render-lab-screen-space-band-range.mjs   .render-lab-shots/ssd-10/a-range/summary.md を書く
//
// 解像度 1・帯の数 8・既定の半精度の通しで、4 撮影 × seedOf(0..3) の 4 パス。面の画素(深度 > 0)だけを、撮影 × 帯 × 成分ごとに数える。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tierOf } from './screen-space-chain-setup.mjs';
import { fixed, seedOf, selectedEntries, shotsDir, table, withLab } from './screen-space-lab.mjs';

const SHOTS = ['bay-earth-open', 'cornell-box', 'bay-dark', 'angled-bounce'];
const BANDS = 8;
const PASSES = 4;
const PERCENTILES = [1, 10, 50, 90, 99, 99.9, 99.99];
const OVER = [1, 2, 4, 8, 16];
const UNDER = [1e-4, 1e-3];
const COMPONENTS = ['R', 'G', 'B'];

// 並べ替えた絶対値 sorted の百分位 p。
const percentileOf = (sorted, p) => (sorted.length === 0 ? NaN : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p / 100))]);

// 1 撮影・1 帯・1 成分の統計。values は面の画素の q。
function statsOf(values) {
  const nonzero = values.filter((v) => v !== 0);
  const sorted = Float32Array.from(nonzero, Math.abs).sort();
  const n = values.length;
  return {
    n, zero: (n - nonzero.length) / n,
    percentiles: PERCENTILES.map((p) => percentileOf(sorted, p)), max: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
    positive: nonzero.filter((v) => v > 0).length / n, negative: nonzero.filter((v) => v < 0).length / n,
    over: OVER.map((t) => sorted.filter((v) => v > t).length / n), under: UNDER.map((t) => sorted.filter((v) => v < t).length / n),
  };
}

const stats = {};
const factors = {};
await withLab(async (lab) => {
  for (const shot of SHOTS) {
    await lab.show(selectedEntries({ entries: shot })[0]);
    await lab.setTier({ ...tierOf(0.38), scale: 1, bandCount: BANDS });
    // [帯][成分] の q の列(面の画素だけ)。
    const columns = Array.from({ length: BANDS }, () => COMPONENTS.map(() => []));
    for (let pass = 0; pass < PASSES; pass++) {
      await lab.setSeed(seedOf(pass));
      await lab.render();
      await lab.render();
      factors[shot] = await lab.exposureFactor();
      const surface = await lab.readFloat('scan-surface-0', 3);
      for (let band = 0; band < BANDS; band++) {
        const delta = await lab.readBand(band);
        for (let p = 0; 3 * p < surface.length; p++) {
          if (surface[3 * p + 2] <= 0) continue;
          for (let c = 0; c < 3; c++) columns[band][c].push(delta[3 * p + c] * factors[shot] / Math.PI);
        }
      }
    }
    stats[shot] = columns.map((band) => band.map((values) => statsOf(values)));
    console.log(shot, 'k', factors[shot], 'surface pixels per band/component', columns[0][0].length);
  }
});

const sci = (v) => (Number.isNaN(v) ? '—' : v.toExponential(2));
const pct = (v) => fixed(100 * v, 4) + '%';
const lines = ['# 走査の帯の値 q = ΔE·k/π の分布(解像度 1・帯の数 8・半精度の通し、4 パス、面の画素のみ)', '',
  `露出係数 k: ${SHOTS.map((s) => `${s} = ${fixed(factors[s], 4)}`).join('、')}`, ''];
for (const shot of SHOTS) {
  lines.push(`## ${shot}`, '');
  const rows = [];
  for (let band = 0; band < BANDS; band++) {
    for (const [c, name] of COMPONENTS.entries()) {
      const s = stats[shot][band][c];
      rows.push([band, name, pct(s.zero), ...s.percentiles.map(sci), sci(s.max), pct(s.positive), pct(s.negative),
        ...s.over.map(pct), ...s.under.map(pct)]);
    }
  }
  lines.push(...table(['帯', '成分', '0', ...PERCENTILES.map((p) => `abs(q) p${p}`), 'abs(q) 最大', '正', '負',
    ...OVER.map((t) => `>${t}`), ...UNDER.map((t) => `<${t}(0 除く)`)], rows), '');
}
const dir = path.join(shotsDir, 'ssd-10', 'a-range');
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, 'summary.md'), lines.join('\n'));
console.log('wrote', path.join(dir, 'summary.md'));
