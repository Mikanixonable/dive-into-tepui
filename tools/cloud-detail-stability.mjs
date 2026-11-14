// 視点を動かしただけで雲の形が変わらないかの計測。render-lab の撮影の組(基準・直下点を数画素ずらした
// 構図・高度を変えた構図。CLOUD_DETAIL_STABILITY_SHOTS)を .cloud-detail/stability/ へ撮り(既にあるものは
// 飛ばす)、基準と各構図を位置と縮尺で合わせてから、尺度の帯ごとに
//   比 = √(差のパワー ÷ (基準のパワー + 構図のパワー))
// を出す。止まった雲なら 0、無相関なら 1。現実の雲は 0 で、描画が視点に引きずられて形を変えるほど上がる。
// 位置は位相相関の峰を放物線で詰めてサブ画素まで合わせ、構図側をフーリエの位相の傾きで動かす。
// 高度違いの構図は、基準の km/px へ双線形で拡大してから同じ手順を通す(拡大前に解像していない細かい帯は判定しない)。
// 報告を .cloud-detail/stability/report.json と .cloud-detail/stability-history/ へ残す。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';
import { fft2 } from './cloud-detail-metrics.mjs';
import { linearLuminanceField } from './cloud-detail-field.mjs';
import { gitHead, saveReport } from './cloud-report-history.mjs';

const root = path.resolve(import.meta.dirname, '..');
const renderLabDir = path.join(root, '.render-lab');
const detailDir = path.join(root, '.cloud-detail');
const shotsDir = path.join(detailDir, 'stability');
const historyDir = path.join(detailDir, 'stability-history');
const port = 8774;
const debugPort = 9451;

// 位置合わせと帯の計測に使う中央の一辺 [px]。
const CROP = 512;
// 高度違いの構図で判定に入れる最も細かい帯の波長 [構図側の px]。拡大で失われた帯を外す。
const ZOOM_MIN_WAVELENGTH_PX = 4;
// 判定の閾値(達成目標)。細部の尺度のすべての帯でこれ未満。
const STABLE_RATIO = 0.1;

// 一覧のうち、まだ無いものを撮って shotsDir へ書く。
async function shootMissing(names) {
  const missing = names.filter((name) => !existsSync(path.join(shotsDir, `${name}.png`)));
  if (missing.length === 0) return 0;
  mkdirSync(shotsDir, { recursive: true });
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: renderLabDir, port, debugPort, profilePrefix: 'tepui-cloud-stability-', onEvent,
    requestTimeoutMs: 120_000,
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    await waitFor(
      devTools,
      "(document.getElementById('error')?.textContent || typeof window.renderLab?.shootCloudDetail === 'function')",
      'the render lab to initialise',
    );
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`Render lab failed to initialise: ${failure}`);
    for (const name of missing) {
      const dataUrl = await devTools.evaluate(`window.renderLab.shootCloudDetail(${JSON.stringify(name)})`);
      writeFileSync(path.join(shotsDir, `${name}.png`), Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
    }
    if (fatalEvents.length > 0) throw new Error(`Page reported errors during shooting:\n${fatalEvents.join('\n')}`);
    return missing.length;
  } finally {
    await session.close();
  }
}

// 撮影の一覧を render-lab から引く(ビルドの中の表が正本)。
async function stabilityInfos() {
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: renderLabDir, port, debugPort, profilePrefix: 'tepui-cloud-stability-', onEvent,
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    await waitFor(
      devTools,
      "(document.getElementById('error')?.textContent || typeof window.renderLab?.cloudDetailStabilityShots === 'function')",
      'the render lab to initialise',
    );
    const infos = await devTools.evaluate('window.renderLab.cloudDetailStabilityShots()');
    if (fatalEvents.length > 0) throw new Error(fatalEvents.join('\n'));
    return infos;
  } finally {
    await session.close();
  }
}

// 場 field(width × height)を、中心から scale 倍に引き伸ばして読んだ CROP × CROP の中央。scale = 1 で
// そのまま切り出す。出力の画素 p は入力の中心 + (p − 中心) × scale を双線形で読む。
function resampledCrop(field, scale) {
  const out = new Float64Array(CROP * CROP);
  const cx = field.width / 2;
  const cy = field.height / 2;
  for (let y = 0; y < CROP; y++) {
    for (let x = 0; x < CROP; x++) {
      const sx = cx + (x + 0.5 - CROP / 2) * scale - 0.5;
      const sy = cy + (y + 0.5 - CROP / 2) * scale - 0.5;
      const x0 = Math.max(0, Math.min(field.width - 2, Math.floor(sx)));
      const y0 = Math.max(0, Math.min(field.height - 2, Math.floor(sy)));
      const fx = sx - x0;
      const fy = sy - y0;
      const at = (ix, iy) => field.data[iy * field.width + ix];
      out[y * CROP + x] = (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy)
        + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
    }
  }
  return out;
}

// 平均を引いた場のフーリエ変換(窓なし)。
function spectrumOf(data) {
  let mean = 0;
  for (const v of data) mean += v;
  mean /= data.length;
  const re = Float64Array.from(data, (v) => v - mean);
  const im = new Float64Array(data.length);
  fft2(re, im, CROP, false);
  return { re, im };
}

// 周期 Hann 窓を掛けた場のフーリエ変換。
function windowedSpectrum(data) {
  let mean = 0;
  for (const v of data) mean += v;
  mean /= data.length;
  const re = new Float64Array(data.length);
  for (let y = 0; y < CROP; y++) {
    const wy = 0.5 * (1 - Math.cos((2 * Math.PI * (y + 0.5)) / CROP));
    for (let x = 0; x < CROP; x++) {
      const wx = 0.5 * (1 - Math.cos((2 * Math.PI * (x + 0.5)) / CROP));
      re[y * CROP + x] = (data[y * CROP + x] - mean) * wx * wy;
    }
  }
  const im = new Float64Array(data.length);
  fft2(re, im, CROP, false);
  return { re, im };
}

// a を基準に b が (dx, dy) 画素ずれているとき、その (dx, dy) を位相相関で求める。峰の隣と放物線で
// サブ画素へ詰める。
function phaseShift(a, b) {
  const fa = windowedSpectrum(a);
  const fb = windowedSpectrum(b);
  const re = new Float64Array(CROP * CROP);
  const im = new Float64Array(CROP * CROP);
  for (let i = 0; i < re.length; i++) {
    // conj(A)·B: b(x) = a(x − d) のとき位相は −2πk·d で、逆変換の峰は +d に立つ。
    const cr = fa.re[i] * fb.re[i] + fa.im[i] * fb.im[i];
    const ci = fa.re[i] * fb.im[i] - fa.im[i] * fb.re[i];
    const mag = Math.hypot(cr, ci) + 1e-12;
    re[i] = cr / mag;
    im[i] = ci / mag;
  }
  fft2(re, im, CROP, true);
  let best = 0;
  for (let i = 1; i < re.length; i++) if (re[i] > re[best]) best = i;
  const px = best % CROP;
  const py = Math.floor(best / CROP);
  const at = (x, y) => re[((y + CROP) % CROP) * CROP + ((x + CROP) % CROP)];
  const refine = (minus, center, plus) => {
    const denominator = minus - 2 * center + plus;
    return Math.abs(denominator) < 1e-12 ? 0 : 0.5 * (minus - plus) / denominator;
  };
  const dx = px + refine(at(px - 1, py), at(px, py), at(px + 1, py));
  const dy = py + refine(at(px, py - 1), at(px, py), at(px, py + 1));
  const wrap = (d) => (d > CROP / 2 ? d - CROP : d);
  return { dx: wrap(dx), dy: wrap(dy), peak: re[best] };
}

// 場 data を (−dx, −dy) 画素ずらして基準へ戻した場。フーリエの位相の傾きで動かすので、サブ画素でも
// ぼけない(端は巻き込むが、あとで掛ける窓が抑える)。
function shiftedBack(data, dx, dy) {
  const { re, im } = spectrumOf(data);
  for (let ky = 0; ky < CROP; ky++) {
    const fy = ky <= CROP / 2 ? ky : ky - CROP;
    for (let kx = 0; kx < CROP; kx++) {
      const fx = kx <= CROP / 2 ? kx : kx - CROP;
      const phase = (2 * Math.PI * (fx * dx + fy * dy)) / CROP;
      const c = Math.cos(phase);
      const s = Math.sin(phase);
      const i = ky * CROP + kx;
      const r = re[i] * c - im[i] * s;
      im[i] = re[i] * s + im[i] * c;
      re[i] = r;
    }
  }
  fft2(re, im, CROP, true);
  return re;
}

// 合わせた 2 つの場の、オクターブの帯ごとの比。kmPerPx は場の 1 px の実寸、minWavelengthPx より
// 細かい帯は judged = false。
function bandRatios(a, b, kmPerPx, minWavelengthPx) {
  const fa = windowedSpectrum(a);
  const fb = windowedSpectrum(b);
  const bands = [];
  for (let k0 = 1; k0 <= CROP / 4; k0 *= 2) {
    const k1 = Math.min(2 * k0 - 1, CROP / 2);
    let pa = 0;
    let pb = 0;
    let pd = 0;
    for (let ky = 0; ky < CROP; ky++) {
      const fy = Math.min(ky, CROP - ky);
      for (let kx = 0; kx < CROP; kx++) {
        const fx = Math.min(kx, CROP - kx);
        const k = Math.round(Math.hypot(fx, fy));
        if (k < k0 || k > k1) continue;
        const i = ky * CROP + kx;
        pa += fa.re[i] ** 2 + fa.im[i] ** 2;
        pb += fb.re[i] ** 2 + fb.im[i] ** 2;
        pd += (fa.re[i] - fb.re[i]) ** 2 + (fa.im[i] - fb.im[i]) ** 2;
      }
    }
    const shortestPx = CROP / k1;
    bands.push({
      bandKm: [(CROP * kmPerPx) / (2 * k0), (CROP * kmPerPx) / k0],
      ratio: pa + pb > 0 ? Math.sqrt(pd / (pa + pb)) : null,
      judged: shortestPx >= minWavelengthPx,
    });
  }
  return bands;
}

function main() {
  return (async () => {
    const infos = await stabilityInfos();
    const taken = await shootMissing(infos.map((info) => info.name));
    console.log(`撮影 ${infos.length} 枚のうち ${taken} 枚を新たに撮った(既存は飛ばす)`);

    const byKey = new Map();
    for (const info of infos) {
      const key = info.name.replace(/-stab-(base|shift|zoom)$/, '');
      const variant = info.name.slice(info.name.lastIndexOf('-') + 1);
      const entry = byKey.get(key) ?? {};
      entry[variant] = info;
      byKey.set(key, entry);
    }

    const pairs = [];
    for (const [key, entry] of byKey) {
      const load = (info) => linearLuminanceField(readFileSync(path.join(shotsDir, `${info.name}.png`)));
      const base = load(entry.base);
      const baseCrop = resampledCrop(base, 1);
      for (const variant of ['shift', 'zoom']) {
        const info = entry[variant];
        const field = load(info);
        // 構図側を基準の km/px へ合わせる: 構図の 1 px が基準の scale 倍なら、構図の場を 1/scale で読む。
        const scale = entry.base.centerKmPerPx / info.centerKmPerPx;
        const crop = resampledCrop(field, scale);
        const { dx, dy, peak } = phaseShift(baseCrop, crop);
        const aligned = shiftedBack(crop, dx, dy);
        const minWavelengthPx = variant === 'zoom' ? ZOOM_MIN_WAVELENGTH_PX / scale : 2;
        const bands = bandRatios(baseCrop, aligned, entry.base.centerKmPerPx, minWavelengthPx);
        pairs.push({ key, variant, tierKmPerPx: entry.base.tierKmPerPx, dx, dy, peak, bands });
      }
    }

    // 段 × 構図ごとに、帯の比の中央値を表にする。
    console.log(`\n=== 視点の安定性(帯ごとの 差 ÷ 模様 の振幅比の中央値。0 で安定、1 で無相関。目標 < ${STABLE_RATIO}) ===`);
    const summary = {};
    for (const variant of ['shift', 'zoom']) {
      for (const tier of [...new Set(pairs.map((pair) => pair.tierKmPerPx))].sort((a, b) => a - b)) {
        const group = pairs.filter((pair) => pair.variant === variant && pair.tierKmPerPx === tier);
        if (group.length === 0) continue;
        const columns = group[0].bands.map((band, index) => {
          const values = group.map((pair) => pair.bands[index]).filter((cell) => cell.judged && cell.ratio !== null)
            .map((cell) => cell.ratio).sort((a, b) => a - b);
          return { bandKm: band.bandKm, median: values.length > 0 ? values[values.length >> 1] : null, max: values.at(-1) ?? null };
        });
        summary[`${variant}@${tier}`] = columns;
        console.log(`\n[${variant}] ${tier} km/px(${group.length} 場面。位置合わせ: ${group.map((pair) => `${pair.dx.toFixed(2)},${pair.dy.toFixed(2)}`).join(' / ')})`);
        for (const column of columns) {
          if (column.median === null) continue;
          const [lo, hi] = column.bandKm;
          const flag = column.median >= STABLE_RATIO ? '  ×' : '';
          console.log(`  ${`${lo.toPrecision(3)}-${hi.toPrecision(3)} km`.padStart(18)}  中央値 ${column.median.toFixed(3)}  最大 ${column.max.toFixed(3)}${flag}`);
        }
      }
    }

    const report = {
      meta: { tool: 'cloud-detail-stability', generatedAt: new Date().toISOString(), gitHead: gitHead(root), stableRatio: STABLE_RATIO },
      sections: { summary },
      pairs,
    };
    writeFileSync(path.join(shotsDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    saveReport(historyDir, report);
  })();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
