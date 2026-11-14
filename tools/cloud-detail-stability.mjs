// 視点を動かしただけで雲の形が変わらないかと、時間とともに雲がどう流れ入れ替わるかの計測。render-lab の
// 撮影の組(基準・直下点を数画素ずらした構図・高度を変えた構図・同じ構図の 10 分後と 30 分後。
// CLOUD_DETAIL_STABILITY_SHOTS)を .cloud-detail/stability/ へ撮り(既にあるものは飛ばす)、基準と各構図を
// 位置と縮尺で合わせてから、尺度の帯ごとに
//   比 = √(差のパワー ÷ (基準のパワー + 構図のパワー))
// を出す。止まった雲なら 0、無相関なら 1。現実の雲は 0 で、描画が視点に引きずられて形を変えるほど上がる。
// 位置は位相相関の峰を放物線で詰めてサブ画素まで合わせ、構図側をフーリエの位相の傾きで動かす。
// 視点の安定性(shift / zoom)は中央 512 px を全体で合わせる。時間の計測(later10 / later30)は
// 種類(両方・積雲だけ・巻雲だけ)ごとに、512 px を 4×4 = 16 の 128 px 小区画へ分け、小区画ごとに
// 位相相関で合わせる — 層ごと・場所ごとに風が違うので、1 つのずれでは片方の層にしか合わない。
// 小区画の位相相関は ±64 px までしか読めないので、先に全体で粗く合わせて大きな流れを引いてから
// 小区画ごとの残差を合わせる。合わせたずれが模様の流れた距離(速さ)、帯の比は流れを差し引いたあとの
// 入れ替わり(寿命)を表し、比から帯ごとの相関が 1/e に落ちる時間 τ も見積もる。
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
// 時間の計測に使う小区画の一辺 [px]。中央の CROP を TILES_PER_SIDE² 枚へ分ける。
const TILE = 128;
const TILES_PER_SIDE = CROP / TILE;
// 高度違いの構図で判定に入れる最も細かい帯の波長 [構図側の px]。拡大で失われた帯を外す。
const ZOOM_MIN_WAVELENGTH_PX = 4;
// 判定の閾値(達成目標)。細部の尺度のすべての帯でこれ未満。
const STABLE_RATIO = 0.1;
// 視点の安定性を見る構図(全体で位置合わせ)と、時間の計測に使う構図(小区画で位置合わせ)。
const VIEWPOINT_VARIANTS = ['shift', 'zoom'];
const LATER_VARIANTS = ['later10', 'later30'];
// 時間の計測を行う種類。両方・巻雲だけ。
const KINDS = ['both', 'cirrus'];
// 撮影名の末尾の -stab-<構図>[-<種類>]。種類の無標は両方。
const STABILITY_NAME = /-stab-(base|shift|zoom|later10|later30)(?:-(both|cirrus))?$/;

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

// 平均を引いた場のフーリエ変換(窓なし)。場の一辺は n [px]。
function spectrumOf(data, n) {
  let mean = 0;
  for (const v of data) mean += v;
  mean /= data.length;
  const re = Float64Array.from(data, (v) => v - mean);
  const im = new Float64Array(data.length);
  fft2(re, im, n, false);
  return { re, im };
}

// 周期 Hann 窓を掛けた場のフーリエ変換。場の一辺は n [px]。
function windowedSpectrum(data, n) {
  let mean = 0;
  for (const v of data) mean += v;
  mean /= data.length;
  const re = new Float64Array(data.length);
  for (let y = 0; y < n; y++) {
    const wy = 0.5 * (1 - Math.cos((2 * Math.PI * (y + 0.5)) / n));
    for (let x = 0; x < n; x++) {
      const wx = 0.5 * (1 - Math.cos((2 * Math.PI * (x + 0.5)) / n));
      re[y * n + x] = (data[y * n + x] - mean) * wx * wy;
    }
  }
  const im = new Float64Array(data.length);
  fft2(re, im, n, false);
  return { re, im };
}

// 窓を掛けたスペクトル fa を基準に fb が (dx, dy) 画素ずれているとき、その (dx, dy) を位相相関で
// 求める。峰の隣と放物線でサブ画素へ詰める。n は場の一辺 [px]。
function phaseShiftSpectra(fa, fb, n) {
  const re = new Float64Array(n * n);
  const im = new Float64Array(n * n);
  for (let i = 0; i < re.length; i++) {
    // conj(A)·B: b(x) = a(x − d) のとき位相は −2πk·d で、逆変換の峰は +d に立つ。
    const cr = fa.re[i] * fb.re[i] + fa.im[i] * fb.im[i];
    const ci = fa.re[i] * fb.im[i] - fa.im[i] * fb.re[i];
    const mag = Math.hypot(cr, ci) + 1e-12;
    re[i] = cr / mag;
    im[i] = ci / mag;
  }
  fft2(re, im, n, true);
  let best = 0;
  for (let i = 1; i < re.length; i++) if (re[i] > re[best]) best = i;
  const px = best % n;
  const py = Math.floor(best / n);
  const at = (x, y) => re[((y + n) % n) * n + ((x + n) % n)];
  const refine = (minus, center, plus) => {
    const denominator = minus - 2 * center + plus;
    return Math.abs(denominator) < 1e-12 ? 0 : 0.5 * (minus - plus) / denominator;
  };
  const dx = px + refine(at(px - 1, py), at(px, py), at(px + 1, py));
  const dy = py + refine(at(px, py - 1), at(px, py), at(px, py + 1));
  const wrap = (d) => (d > n / 2 ? d - n : d);
  return { dx: wrap(dx), dy: wrap(dy), peak: re[best] };
}

// 場 a を基準に場 b が (dx, dy) 画素ずれているとき、その (dx, dy) を位相相関で求める。n は一辺 [px]。
function phaseShift(a, b, n) {
  return phaseShiftSpectra(windowedSpectrum(a, n), windowedSpectrum(b, n), n);
}

// 場 data(n × n)を (−dx, −dy) 画素ずらして基準へ戻した場。フーリエの位相の傾きで動かすので、サブ画素でも
// ぼけない(端は巻き込むが、あとで掛ける窓が抑える)。
function shiftedBack(data, dx, dy, n) {
  const { re, im } = spectrumOf(data, n);
  for (let ky = 0; ky < n; ky++) {
    const fy = ky <= n / 2 ? ky : ky - n;
    for (let kx = 0; kx < n; kx++) {
      const fx = kx <= n / 2 ? kx : kx - n;
      const phase = (2 * Math.PI * (fx * dx + fy * dy)) / n;
      const c = Math.cos(phase);
      const s = Math.sin(phase);
      const i = ky * n + kx;
      const r = re[i] * c - im[i] * s;
      im[i] = re[i] * s + im[i] * c;
      re[i] = r;
    }
  }
  fft2(re, im, n, true);
  return re;
}

// 合わせた 2 つのスペクトルの、オクターブの帯ごとの比。n は場の一辺 [px]、kmPerPx は場の 1 px の実寸、
// minWavelengthPx より細かい帯は judged = false。
function bandRatiosSpectra(fa, fb, n, kmPerPx, minWavelengthPx) {
  const bands = [];
  for (let k0 = 1; k0 <= n / 4; k0 *= 2) {
    const k1 = Math.min(2 * k0 - 1, n / 2);
    let pa = 0;
    let pb = 0;
    let pd = 0;
    for (let ky = 0; ky < n; ky++) {
      const fy = Math.min(ky, n - ky);
      for (let kx = 0; kx < n; kx++) {
        const fx = Math.min(kx, n - kx);
        const k = Math.round(Math.hypot(fx, fy));
        if (k < k0 || k > k1) continue;
        const i = ky * n + kx;
        pa += fa.re[i] ** 2 + fa.im[i] ** 2;
        pb += fb.re[i] ** 2 + fb.im[i] ** 2;
        pd += (fa.re[i] - fb.re[i]) ** 2 + (fa.im[i] - fb.im[i]) ** 2;
      }
    }
    const shortestPx = n / k1;
    bands.push({
      bandKm: [(n * kmPerPx) / (2 * k0), (n * kmPerPx) / k0],
      ratio: pa + pb > 0 ? Math.sqrt(pd / (pa + pb)) : null,
      judged: shortestPx >= minWavelengthPx,
    });
  }
  return bands;
}

// 合わせた 2 つの場(一辺 n [px])の、オクターブの帯ごとの比。
function bandRatios(a, b, n, kmPerPx, minWavelengthPx) {
  return bandRatiosSpectra(
    windowedSpectrum(a, n), windowedSpectrum(b, n), n, kmPerPx, minWavelengthPx);
}

// CROP × CROP の場を、行優先で TILES_PER_SIDE² 枚の TILE × TILE の小区画へ切り分ける。
function tiles(data) {
  const out = [];
  for (let ty = 0; ty < TILES_PER_SIDE; ty++) {
    for (let tx = 0; tx < TILES_PER_SIDE; tx++) {
      const tile = new Float64Array(TILE * TILE);
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          tile[y * TILE + x] = data[(ty * TILE + y) * CROP + tx * TILE + x];
        }
      }
      out.push(tile);
    }
  }
  return out;
}

// 数値列の中央値。空なら null。
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

// 帯の比 r(Δt) から、その帯の相関が 1/e に落ちる時間 τ [s] を見積もる。帯の比は
// r² = (Pa + Pb − 2C)/(Pa + Pb) なので、帯の相関は ρ = 1 − r²。ρ = exp(−Δt/τ) を対数で
// 原点通過の最小二乗に当てはめる。0 < ρ < 1(つまり 0 < r < 1)の点だけを使い、使える点が
// 無ければ null を返す。
function lifetime(points) {
  let slope = 0;
  let sq = 0;
  for (const { delayS, ratio } of points) {
    if (delayS <= 0 || ratio === null || ratio <= 0 || ratio >= 1) continue;
    slope += delayS * Math.log(1 - ratio * ratio);
    sq += delayS * delayS;
  }
  return sq > 0 ? -sq / slope : null;
}

// null 安全な数値の表示。
function fmt(value, digits) {
  return value === null ? '—' : value.toFixed(digits);
}

function main() {
  return (async () => {
    const infos = await stabilityInfos();
    const taken = await shootMissing(infos.map((info) => info.name));
    console.log(`撮影 ${infos.length} 枚のうち ${taken} 枚を新たに撮った(既存は飛ばす)`);

    // 撮影名の末尾の -stab-<構図>[-<種類>] から、組(海域-時刻-段)のキーと構図・種類を取り出す。
    const byKey = new Map();
    for (const info of infos) {
      const match = STABILITY_NAME.exec(info.name);
      if (match === null) continue;
      const key = info.name.slice(0, match.index);
      const entry = byKey.get(key) ?? {};
      (entry[match[1]] ??= {})[match[2] ?? 'both'] = info;
      byKey.set(key, entry);
    }

    const load = (info) => linearLuminanceField(readFileSync(path.join(shotsDir, `${info.name}.png`)));
    const pairs = [];
    for (const [key, entry] of byKey) {
      // 視点の安定性(shift / zoom)。両方の描画を全体で位置合わせする。
      const baseBoth = entry.base?.both;
      if (baseBoth !== undefined) {
        const baseCrop = resampledCrop(load(baseBoth), 1);
        for (const variant of VIEWPOINT_VARIANTS) {
          const info = entry[variant]?.both;
          if (info === undefined) continue;
          // 構図側を基準の km/px へ合わせる: 構図の 1 px が基準の scale 倍なら、構図の場を 1/scale で読む。
          const scale = baseBoth.centerKmPerPx / info.centerKmPerPx;
          const crop = resampledCrop(load(info), scale);
          const { dx, dy, peak } = phaseShift(baseCrop, crop, CROP);
          const aligned = shiftedBack(crop, dx, dy, CROP);
          const minWavelengthPx = variant === 'zoom' ? ZOOM_MIN_WAVELENGTH_PX / scale : 2;
          const bands = bandRatios(baseCrop, aligned, CROP, baseBoth.centerKmPerPx, minWavelengthPx);
          pairs.push({ key, variant, kind: 'both', tierKmPerPx: baseBoth.tierKmPerPx, dx, dy, peak, bands });
        }
      }

      // 時間の計測(later10 / later30)。種類ごとに、まず全体で粗く合わせて大きな流れを引き、
      // 小区画ごとの残差を位相相関で合わせてから、小区画の帯の比を出す。
      for (const kind of KINDS) {
        const baseInfo = entry.base?.[kind];
        if (baseInfo === undefined) continue;
        const baseCrop = resampledCrop(load(baseInfo), 1);
        const baseTiles = tiles(baseCrop);
        const baseSpectra = baseTiles.map((tile) => windowedSpectrum(tile, TILE));
        for (const variant of LATER_VARIANTS) {
          const info = entry[variant]?.[kind];
          if (info === undefined) continue;
          const laterS = info.displayTime - baseInfo.displayTime;
          const laterCrop = resampledCrop(load(info), 1);
          const coarse = phaseShift(baseCrop, laterCrop, CROP);
          const laterTiles = tiles(shiftedBack(laterCrop, coarse.dx, coarse.dy, CROP));
          const tileResults = laterTiles.map((tile, index) => {
            const residual = phaseShiftSpectra(baseSpectra[index], windowedSpectrum(tile, TILE), TILE);
            const aligned = shiftedBack(tile, residual.dx, residual.dy, TILE);
            const bands = bandRatiosSpectra(
              baseSpectra[index], windowedSpectrum(aligned, TILE), TILE, baseInfo.centerKmPerPx, 2);
            // 位置合わせのずれが模様の流れた距離。速さ [m/s] に直す。
            const dx = coarse.dx + residual.dx;
            const dy = coarse.dy + residual.dy;
            return {
              dx, dy, peak: residual.peak,
              speed: (Math.hypot(dx, dy) * baseInfo.centerKmPerPx * 1000) / laterS,
              bands,
            };
          });
          pairs.push({
            key, variant, kind, tierKmPerPx: baseInfo.tierKmPerPx, laterS,
            coarse: { dx: coarse.dx, dy: coarse.dy, peak: coarse.peak }, tiles: tileResults,
          });
        }
      }
    }

    const tiers = [...new Set(pairs.map((pair) => pair.tierKmPerPx))].sort((a, b) => a - b);

    // 段 × 構図ごとに、帯の比の中央値を表にする。
    console.log(`\n=== 視点の安定性(帯ごとの 差 ÷ 模様 の振幅比の中央値。0 で安定、1 で無相関。目標 < ${STABLE_RATIO}) ===`);
    const summary = {};
    for (const variant of VIEWPOINT_VARIANTS) {
      for (const tier of tiers) {
        const group = pairs.filter((pair) => pair.variant === variant && pair.tierKmPerPx === tier);
        if (group.length === 0) continue;
        const columns = group[0].bands.map((band, index) => {
          const values = group.map((pair) => pair.bands[index])
            .filter((cell) => cell.judged && cell.ratio !== null)
            .map((cell) => cell.ratio).sort((a, b) => a - b);
          return {
            bandKm: band.bandKm,
            median: values.length > 0 ? values[values.length >> 1] : null,
            max: values.at(-1) ?? null,
          };
        });
        summary[`${variant}@${tier}`] = columns;
        console.log(`\n[${variant}] ${tier} km/px(${group.length} 場面。位置合わせ: ${group.map((pair) => `${pair.dx.toFixed(2)},${pair.dy.toFixed(2)}`).join(' / ')})`);
        for (const column of columns) {
          if (column.median === null) continue;
          const [lo, hi] = column.bandKm;
          const flag = column.median < STABLE_RATIO ? '' : '  ×';
          console.log(`  ${`${lo.toPrecision(3)}-${hi.toPrecision(3)} km`.padStart(18)}  中央値 ${column.median.toFixed(3)}  最大 ${column.max.toFixed(3)}${flag}`);
        }
      }
    }

    // 段 × 種類 × 遅れごとに、小区画の速さと帯の比の中央値と τ を表にする。
    console.log(`\n=== 時間の計測(同じ構図の 10 分後・30 分後。中央 ${CROP} px を ${TILE} px の小区画へ分け、区画ごとに位相相関で合わせる。帯の比が寿命、区画のずれが流れ。τ は帯の相関が 1/e に落ちる時間) ===`);
    const temporal = {};
    for (const kind of KINDS) {
      for (const tier of tiers) {
        const groups = LATER_VARIANTS.map((variant) =>
          pairs.filter((pair) => pair.variant === variant && pair.kind === kind && pair.tierKmPerPx === tier));
        const all = groups.flat();
        if (all.length === 0) continue;
        const speeds = groups.map((group) =>
          median(group.flatMap((pair) => pair.tiles.map((tile) => tile.speed))));
        const columns = all[0].tiles[0].bands.map((band, index) => {
          const ratios = groups.map((group) =>
            median(group.flatMap((pair) => pair.tiles.map((tile) => tile.bands[index]))
              .filter((cell) => cell.judged && cell.ratio !== null).map((cell) => cell.ratio)));
          const tauS = lifetime(groups.map((group, g) => ({ delayS: group[0]?.laterS ?? 0, ratio: ratios[g] })));
          return { bandKm: band.bandKm, ratios, tauS };
        });
        temporal[`${kind}@${tier}`] = {
          scenes: all.length,
          tilesPerScene: TILES_PER_SIDE * TILES_PER_SIDE,
          speedMs: Object.fromEntries(LATER_VARIANTS.map((variant, i) => [variant, speeds[i]])),
          bands: columns.map((column) => ({
            bandKm: column.bandKm,
            medianRatio: Object.fromEntries(LATER_VARIANTS.map((variant, i) => [variant, column.ratios[i]])),
            tauS: column.tauS,
          })),
        };
        const scenes = Math.max(...groups.map((group) => group.length));
        console.log(`\n[${kind}] ${tier} km/px(${scenes} 場面 × ${TILES_PER_SIDE * TILES_PER_SIDE} 区画)`);
        console.log(`  速さの中央値 [m/s]   10 分後 ${fmt(speeds[0], 1)}   30 分後 ${fmt(speeds[1], 1)}`);
        for (const column of columns) {
          const [lo, hi] = column.bandKm;
          console.log(`  ${`${lo.toPrecision(3)}-${hi.toPrecision(3)} km`.padStart(18)}  比 10 分後 ${fmt(column.ratios[0], 3)}   比 30 分後 ${fmt(column.ratios[1], 3)}   τ ${column.tauS === null ? '—' : `${(column.tauS / 60).toPrecision(3)} 分`}`);
        }
      }
    }

    const report = {
      meta: { tool: 'cloud-detail-stability', generatedAt: new Date().toISOString(), gitHead: gitHead(root), stableRatio: STABLE_RATIO },
      sections: { summary, temporal },
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
