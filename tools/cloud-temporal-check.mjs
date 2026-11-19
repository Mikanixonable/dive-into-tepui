// 雲の時間方向の連続性の計測。render-lab の雲の細部の撮影を、視点を固定したまま表示時刻を一定の刻み Δ で
// 進めて N 枚連続で撮り、前後の 2 枚の差から、一定間隔で急に変わるかを見る。
//   D(k) = 雲の画素の平均絶対差 [1/255]、F(k) = 最大チャンネル差が CHANGE_THRESHOLD を超える雲の画素の割合。
// 雲の画素は最初の撮影の輝度から決める(下位 10% の輝度 + CLOUD_MASK_MARGIN より明るい画素)。雲の外の
// 画素の差(Dout)は対照として併記する。撮影ノイズの床は、同じ時刻を撮り直した差(FLOOR_SAMPLES 点)で測る。
// 解析は D の中央値・99%点・最大・スパイク比、D の自己相関による周期的なピーク、上位のスパイクの時刻と
// 7200 s の倍数(段の周期)に乗っているかの割合を出す。さらに、雲の画素の大きな尺度の傾きを除いた残差の、
// 時刻 t と t + τ のピアソン相関 C(t) を全 t について出し、その変動係数(CV)と最小・最大を見る。C が一定なら
// 変化の速さが時間によらず一定になる。
// 尺度別には、輝度を波長の帯(BAND_EDGES_KM)へ分け、帯ごとに隣り合う枠の変化の速さ d_b(k) を出す。
// d_b = 1 − 整数ずらし ±BAND_SHIFT_RADIUS 画素の最大 NCC とし、ずらしを取るので移流には鈍く、
// 模様の入れ替わりだけが効く。帯ごとの CV・最大/平均・自己相関の周期ピーク(7200 s の窓の検査)と、
// 帯をまとめた合計の速さの CV を見る。雲の外の画素はマスク内の平均で埋めてから帯域を作る。
// mode 'selftest' では撮影せず、合成の系列(周期の窓でのみ変わる場・定常に変わる場・移流だけの場)へ
// 同じ解析を当てて、指標が窓の変化と移流を区別できるかを確かめる。
// 結果は .cloud-detail/temporal/ へ JSON で残す。
// 設定は作業ツリー直下の .loop-temporal-config.json(無ければ既定)。引数は取らない。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';
import { decodePng } from './png.mjs';

const root = path.resolve(import.meta.dirname, '..');
const renderLabDir = path.join(root, '.render-lab');
const outDir = path.join(root, '.cloud-detail', 'temporal');
const configPath = path.join(root, '.loop-temporal-config.json');
const port = 8777;
const debugPort = 9456;

// 既定の設定。場面は render-lab の cloud-detail-cases.ts の SCENES の id、km/px は段の目標(0.25・1・4)。
// kind は撮影名の種類(both・cirrus)。mode 'selftest' は撮影しない純粋な計算。
// graphics は描画設定の差分(撮影の設定へ重ねる)。
const DEFAULTS = {
  scene: 'natl-trade', kmPerPx: 1, kind: 'both', deltaS: 60, frames: 480, startS: 0, tauS: 900,
  label: null, mode: 'measure', graphics: null,
};
// 残差の大きな尺度の傾きを引くための箱ぼかしの半幅 [画素]。
const CORRELATION_BLUR_RADIUS = 32;
// 段の読み直しの上限周期 [表示時刻の秒](cloud-detail-clock.ts の MAX_RECYCLE_PERIOD)。入れ替わりの周期。
const CYCLE_S = 7200;
// 尺度の帯の端 [km]。帯 i は波長 BAND_EDGES_KM[i]〜BAND_EDGES_KM[i+1] を通す —
// 箱ぼかし(半幅 = 端の波長の 1/2)の差で作る。
const BAND_EDGES_KM = [2, 4, 8, 16, 32, 64];
// d_b のずらしの半径 [画素]。風の移流(1 km/px・60 s で 1 画素未満)を除くための整数ずらし。
const BAND_SHIFT_RADIUS = 3;
// d_b の評価に使う画素数の目安。雲の画素が多いときは間引いてこの数へ揃える。
const BAND_EVAL_PIXELS = 60000;
// 同じ時刻の絵が落ち着くまで撮る上限。連続する 2 回が一致すれば落ち着いたとみなす(captureSettled と同じ)。
const MAX_SETTLE_CAPTURES = 8;
// 雲の画素の閾値: 最初の撮影の輝度の下位 10% に足す量 (0..255)。
const CLOUD_MASK_MARGIN = 20;
// 画素が変わったとみなす閾値 [1/255]。F(k) の判定に使う。
const CHANGE_THRESHOLD = 8;
// 撮影ノイズの床を測る時刻の数。枠の中で等間隔に取る。
const FLOOR_SAMPLES = 4;

function readConfig() {
  const given = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  const config = { ...DEFAULTS, ...given };
  if (!(config.deltaS > 0)) throw new Error(`config.deltaS must be > 0: ${config.deltaS}`);
  if (!(config.frames >= 4)) throw new Error(`config.frames must be >= 4: ${config.frames}`);
  if (!(config.tauS >= config.deltaS)) throw new Error(`config.tauS must be >= deltaS: ${config.tauS}`);
  if (config.mode !== 'measure' && config.mode !== 'selftest') throw new Error(`config.mode: ${config.mode}`);
  if (config.kind !== 'both' && config.kind !== 'cirrus') throw new Error(`config.kind: ${config.kind}`);
  return config;
}

function buildRenderLab() {
  if (process.env.CLOUD_TEMPORAL_SKIP_BUILD === '1') return;
  const result = spawnSync(
    path.join(root, 'node_modules', '.bin', 'webpack'),
    ['--config', 'webpack.render-lab.config.js', '--mode', 'production'],
    { cwd: root, stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error('render-lab の webpack 本番ビルドが失敗した');
}

function gitInfo() {
  const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const stat = execFileSync('git', ['diff', '--stat', 'HEAD', '--', 'src'], { cwd: root, encoding: 'utf8' }).trim();
  return { head, stat, dirty: stat.length > 0 };
}

// PNG のデータ URL を RGB(画素あたり 3 byte、行優先)へ。
function rgbOfDataUrl(dataUrl) {
  const decoded = decodePng(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
  const { width, height, channels, data } = decoded;
  const rgb = new Uint8Array(width * height * 3);
  for (let p = 0; p < width * height; p++) {
    for (let c = 0; c < 3; c++) rgb[3 * p + c] = data[p * channels + c];
  }
  return { width, height, rgb };
}

// 画素ごとの輝度。
function luminanceOf(rgb, pixelCount) {
  const luminance = new Float64Array(pixelCount);
  for (let p = 0; p < pixelCount; p++) {
    luminance[p] = 0.2126 * rgb[3 * p] + 0.7152 * rgb[3 * p + 1] + 0.0722 * rgb[3 * p + 2];
  }
  return luminance;
}

// 最初の撮影から雲の画素を決める。輝度の下位 10% + CLOUD_MASK_MARGIN より明るい画素。
function cloudPixels(rgb, pixelCount) {
  const luminance = luminanceOf(rgb, pixelCount);
  const sorted = Float64Array.from(luminance).sort();
  const threshold = sorted[Math.floor(0.1 * (pixelCount - 1))] + CLOUD_MASK_MARGIN;
  const inside = [];
  const outside = [];
  for (let p = 0; p < pixelCount; p++) (luminance[p] > threshold ? inside : outside).push(p);
  return { inside: Uint32Array.from(inside), outside: Uint32Array.from(outside), threshold };
}

// 輝度の箱ぼかし(半幅 radius)。縦横の 2 段に分け、窓の和を移しながら進める。縁は端の値で延ばす。
function boxBlur(values, width, height, radius) {
  const span = 2 * radius + 1;
  const clampTo = (i, n) => Math.min(n - 1, Math.max(0, i));
  const horizontal = new Float64Array(width * height);
  const out = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let x = -radius; x <= radius; x++) sum += values[row + clampTo(x, width)];
    for (let x = 0; x < width; x++) {
      horizontal[row + x] = sum / span;
      sum += values[row + clampTo(x + radius + 1, width)] - values[row + clampTo(x - radius, width)];
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += horizontal[clampTo(y, height) * width + x];
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / span;
      sum += horizontal[clampTo(y + radius + 1, height) * width + x]
        - horizontal[clampTo(y - radius, height) * width + x];
    }
  }
  return out;
}

// 雲の画素 pixels の輝度から大きな尺度の傾きを引いた残差を、pixels の順に返す。
function cloudResidual(luminance, width, height, pixels) {
  const blur = boxBlur(luminance, width, height, CORRELATION_BLUR_RADIUS);
  const residual = new Float32Array(pixels.length);
  for (let i = 0; i < pixels.length; i++) residual[i] = luminance[pixels[i]] - blur[pixels[i]];
  return residual;
}

// 尺度の帯の箱ぼかしの半幅 [画素] の並び(帯の端の波長の 1/2)。帯 i は半幅 radii[i] のぼかしと
// radii[i + 1] のぼかしの差。画素の実寸で半幅が 1 を切る端は 1 に畳み、差が消える帯は null にする。
function bandRadii(kmPerPx) {
  const radii = BAND_EDGES_KM.map((edge) => Math.max(1, Math.round(edge / (2 * kmPerPx))));
  return BAND_EDGES_KM.slice(0, -1).map((edge, i) => (
    radii[i] < radii[i + 1] ? { km: [edge, BAND_EDGES_KM[i + 1]], lo: radii[i], hi: radii[i + 1] } : null
  ));
}

// 雲の外の画素をマスク内の平均で埋めた輝度から、帯ごとの場(2 つの箱ぼかしの差)を作る。
// 埋めるのは、雲の外の暗い地表がぼかしでマスク内へ滲み、帯の変化に混入するのを防ぐため。
function bandFields(luminance, width, height, inside, radii) {
  let sum = 0;
  for (const p of inside) sum += luminance[p];
  const fill = sum / inside.length;
  const insideSet = new Uint8Array(width * height);
  for (const p of inside) insideSet[p] = 1;
  const filled = Float64Array.from(luminance);
  for (let p = 0; p < filled.length; p++) if (!insideSet[p]) filled[p] = fill;
  const unique = [...new Set(radii.flatMap((band) => (band === null ? [] : [band.lo, band.hi])))];
  const blurs = new Map(unique.map((r) => [r, boxBlur(filled, width, height, r)]));
  return radii.map((band) => {
    if (band === null) return null;
    const lo = blurs.get(band.lo);
    const hi = blurs.get(band.hi);
    const field = new Float64Array(width * height);
    for (let p = 0; p < field.length; p++) field[p] = lo[p] - hi[p];
    return field;
  });
}

// d_b の評価に使う画素: 雲の画素を、ずらしの半径だけ侵食したもの(ずらしても雲の外へ出ない画素)。
// 多すぎるときは等間隔に間引く。
function bandEvalPixels(inside, width, height) {
  const insideSet = new Uint8Array(width * height);
  for (const p of inside) insideSet[p] = 1;
  const eroded = [];
  for (const p of inside) {
    const x = p % width;
    const y = Math.floor(p / width);
    if (x < BAND_SHIFT_RADIUS || x >= width - BAND_SHIFT_RADIUS
      || y < BAND_SHIFT_RADIUS || y >= height - BAND_SHIFT_RADIUS) continue;
    let ok = true;
    for (let dy = -BAND_SHIFT_RADIUS; ok && dy <= BAND_SHIFT_RADIUS; dy++) {
      for (let dx = -BAND_SHIFT_RADIUS; dx <= BAND_SHIFT_RADIUS; dx++) {
        if (!insideSet[p + dy * width + dx]) { ok = false; break; }
      }
    }
    if (ok) eroded.push(p);
  }
  const stride = Math.max(1, Math.floor(eroded.length / BAND_EVAL_PIXELS));
  const pixels = [];
  for (let i = 0; i < eroded.length; i += stride) pixels.push(eroded[i]);
  return Uint32Array.from(pixels);
}

// 帯の場 a の時刻 k、b の時刻 k+1 へのずらし offset(= dy * width + dx)での正規化相関。
function nccAt(a, b, offset, evalPixels) {
  let sumA = 0;
  let sumB = 0;
  for (const p of evalPixels) { sumA += a[p]; sumB += b[p + offset]; }
  const meanA = sumA / evalPixels.length;
  const meanB = sumB / evalPixels.length;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (const p of evalPixels) {
    const x = a[p] - meanA;
    const y = b[p + offset] - meanB;
    cov += x * y;
    varA += x * x;
    varB += y * y;
  }
  if (varA === 0 || varB === 0) return 0;
  return cov / Math.sqrt(varA * varB);
}

// 帯の標準偏差で正規化した差の RMS(ずらし offset での)。
function rmsDiffAt(a, b, offset, evalPixels, sdA) {
  let sum = 0;
  for (const p of evalPixels) { const d = a[p] - b[p + offset]; sum += d * d; }
  return Math.sqrt(sum / evalPixels.length) / sdA;
}

// 帯の場 a・b の隣り合う枠の変化の速さ。ずらし ±BAND_SHIFT_RADIUS の最大 NCC で 1 から引く。
// ずらしは場の平行移動(移流)を吸収するので、残る速さは模様の変化と振幅の揺らぎの分。
function bandSpeedNcc(a, b, width, evalPixels) {
  let best = -1;
  for (let dy = -BAND_SHIFT_RADIUS; dy <= BAND_SHIFT_RADIUS; dy++) {
    for (let dx = -BAND_SHIFT_RADIUS; dx <= BAND_SHIFT_RADIUS; dx++) {
      const ncc = nccAt(a, b, dy * width + dx, evalPixels);
      if (ncc > best) best = ncc;
    }
  }
  return 1 - best;
}

// 同じ速さを、正規化した差の RMS の最小で測る指標(自己検査での比較用)。
function bandSpeedRms(a, b, width, evalPixels) {
  let sumA = 0;
  let sumA2 = 0;
  for (const p of evalPixels) { sumA += a[p]; sumA2 += a[p] * a[p]; }
  const meanA = sumA / evalPixels.length;
  const sdA = Math.sqrt(sumA2 / evalPixels.length - meanA * meanA);
  if (sdA === 0) return 0;
  let best = Infinity;
  for (let dy = -BAND_SHIFT_RADIUS; dy <= BAND_SHIFT_RADIUS; dy++) {
    for (let dx = -BAND_SHIFT_RADIUS; dx <= BAND_SHIFT_RADIUS; dx++) {
      const rms = rmsDiffAt(a, b, dy * width + dx, evalPixels, sdA);
      if (rms < best) best = rms;
    }
  }
  return best;
}

// 2 つの列のピアソン相関。
function pearson(a, b) {
  const n = a.length;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i++) {
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= n;
  meanB /= n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - meanA;
    const y = b[i] - meanB;
    cov += x * y;
    varA += x * x;
    varB += y * y;
  }
  return cov / Math.sqrt(varA * varB);
}

// 時刻 t と t + lag 枚の残差の相関 C(t) を、すべての t について返す。lag が枠の数に届かなければ null。
function lagCorrelation(residuals, lag) {
  if (lag < 1 || lag >= residuals.length) return null;
  const C = [];
  for (let i = 0; i + lag < residuals.length; i++) C.push(pearson(residuals[i], residuals[i + lag]));
  const n = C.length;
  const mean = C.reduce((s, v) => s + v, 0) / n;
  const sd = Math.sqrt(C.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  return { C, mean, sd, cv: sd / mean, min: Math.min(...C), max: Math.max(...C) };
}

// 2 枚の差。pixels の画素について平均絶対差 [1/255] と、最大チャンネル差が閾値を超える割合を返す。
function frameDifference(a, b, pixels) {
  let sum = 0;
  let over = 0;
  for (const p of pixels) {
    let worst = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a[3 * p + c] - b[3 * p + c]);
      sum += d;
      if (d > worst) worst = d;
    }
    if (worst > CHANGE_THRESHOLD) over++;
  }
  return { D: sum / (3 * pixels.length), F: over / pixels.length };
}

function sortedNumbers(values) {
  return Float64Array.from(values).sort();
}

function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
}

// 系列の移動中央値からの残差。ゆっくりした流れの傾きを落とし、短い突起だけを残す。半幅 halfWidth の窓。
function detrendByMedian(series, halfWidth) {
  return series.map((_, i) => {
    const window = series.slice(Math.max(0, i - halfWidth), i + halfWidth + 1);
    return series[i] - quantile(sortedNumbers(window), 0.5);
  });
}

// 速さの系列 d(k) の要約: 平均・標準偏差・CV・最大/平均、移動中央値を引いた残差の自己相関の周期ピークと、
// 段の周期 CYCLE_S にあたる遅れでの自己相関。deltaS は枠あたりの表示時刻 [s]。
function speedStats(d, deltaS) {
  const n = d.length;
  const mean = d.reduce((s, v) => s + v, 0) / n;
  const sd = Math.sqrt(d.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  const acf = autocorrelation(detrendByMedian(d, Math.max(2, Math.round(600 / deltaS))));
  const cycleLag = Math.round(CYCLE_S / deltaS);
  return {
    mean, sd, cv: sd / mean, maxOverMean: Math.max(...d) / mean,
    peak: { lagFrames: acf.peak, periodS: acf.peak * deltaS, acf: acf.peakValue, z: acf.zScore },
    acfAtCycle: cycleLag < acf.acf.length ? acf.acf[cycleLag] : null,
  };
}

// 平均を引いた系列の自己相関。lag は 2 から maxLag までの周期的なピークを探す。overlap の少ない遅れは
// 標本数で割り直して不偏にする。
function autocorrelation(series) {
  const n = series.length;
  const mean = series.reduce((s, v) => s + v, 0) / n;
  const d = series.map((v) => v - mean);
  const c0 = d.reduce((s, v) => s + v * v, 0);
  const maxLag = Math.floor(0.75 * n);
  const acf = new Float64Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += d[i] * d[i + lag];
    acf[lag] = (s / c0) * (n / (n - lag));
  }
  // 近い遅れの相関は突起の幅で決まるので、自己相関が初めて負になった遅れから先で峰を探す。
  let start = 2;
  while (start < maxLag && acf[start] > 0) start++;
  let peak = start;
  for (let lag = start; lag <= maxLag; lag++) if (acf[lag] > acf[peak]) peak = lag;
  return { acf, peak, peakValue: acf[peak], zScore: acf[peak] * Math.sqrt(n) };
}

// 系列を幅 width の文字の帯にする。各欄は中の最大値を、floor から最大値までの高さで表す。
function asciiGraph(values, width = 80, floor = 0) {
  const levels = ' ▁▂▃▄▅▆▇█';
  const max = Math.max(...values);
  const cells = [];
  for (let c = 0; c < width; c++) {
    const from = Math.floor((c * values.length) / width);
    const to = Math.max(from + 1, Math.floor(((c + 1) * values.length) / width));
    let cell = 0;
    for (let i = from; i < to; i++) cell = Math.max(cell, values[i]);
    cells.push(levels[Math.min(levels.length - 1, Math.round(((cell - floor) / (max - floor)) * (levels.length - 1)))]);
  }
  return cells.join('');
}

// 1 枚の撮影を、表示時刻 t へ置いて落ち着くまで撮る。落ち着いた PNG のデータ URL を返す。
async function settledFrame(devTools, t) {
  const expression = `(async () => {
    window.renderLab.setDisplayTime(${JSON.stringify(t)});
    let previous = await window.renderLab.capture();
    for (let count = 2; count <= ${MAX_SETTLE_CAPTURES}; count++) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const next = await window.renderLab.capture();
      if (next === previous) return next;
      previous = next;
    }
    return null;
  })()`;
  const png = await devTools.evaluate(expression);
  if (png === null) throw new Error(`撮影が落ち着かない: t=${t} s`);
  return png;
}

async function measureSeries(config, shotName) {
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: renderLabDir, port, debugPort, profilePrefix: 'tepui-cloud-temporal-', onEvent,
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

    // 撮影の組(視点・描画設定)を組むため、基準の撮影を 1 枚撮る。以降は表示時刻だけを動かす。
    await devTools.evaluate(`window.renderLab.shootCloudDetail(${JSON.stringify(shotName)})`);
    for (const [key, value] of Object.entries(config.graphics ?? {})) {
      await devTools.evaluate(
        `window.renderLab.setGraphicsOption(${JSON.stringify(key)}, ${JSON.stringify(value)})`);
    }

    const times = Array.from({ length: config.frames }, (_, k) => config.startS + k * config.deltaS);
    const floorIndices = Array.from({ length: FLOOR_SAMPLES }, (_, j) =>
      Math.round(((j + 0.5) * config.frames) / FLOOR_SAMPLES));
    const started = Date.now();
    let width = 0;
    let height = 0;
    let mask = null;
    let evalPixels = null;
    const radii = bandRadii(config.kmPerPx);
    const bandD = radii.map(() => []);
    let previous = null;
    let previousFields = null;
    const D = [];
    const F = [];
    const Dout = [];
    const residuals = [];
    const kept = new Map();
    for (let k = 0; k < times.length; k++) {
      const { width: w, height: h, rgb } = rgbOfDataUrl(await settledFrame(devTools, times[k]));
      width = w;
      height = h;
      if (mask === null) {
        mask = cloudPixels(rgb, w * h);
        evalPixels = bandEvalPixels(mask.inside, w, h);
      }
      const luminance = luminanceOf(rgb, w * h);
      residuals.push(cloudResidual(luminance, w, h, mask.inside));
      const fields = bandFields(luminance, w, h, mask.inside, radii);
      if (previousFields !== null) {
        for (const [i, field] of fields.entries()) {
          if (field !== null) bandD[i].push(bandSpeedNcc(previousFields[i], field, w, evalPixels));
        }
      }
      previousFields = fields;
      if (previous !== null) {
        const inside = frameDifference(previous, rgb, mask.inside);
        const outside = frameDifference(previous, rgb, mask.outside);
        D.push(inside.D);
        F.push(inside.F);
        Dout.push(outside.D);
      }
      if (floorIndices.includes(k)) kept.set(k, rgb);
      previous = rgb;
      if (k % 40 === 39) {
        console.error(`[temporal] ${k + 1}/${times.length} frames, ${Math.round((Date.now() - started) / 1000)} s`);
      }
    }

    // 撮影ノイズの床: 同じ時刻を撮り直した差。
    const floorD = [];
    const floorF = [];
    for (const k of floorIndices) {
      const again = rgbOfDataUrl(await settledFrame(devTools, times[k])).rgb;
      const difference = frameDifference(kept.get(k), again, mask.inside);
      floorD.push(difference.D);
      floorF.push(difference.F);
    }

    if (fatalEvents.length > 0) throw new Error(`Page reported errors during shooting:\n${fatalEvents.join('\n')}`);
    return {
      width, height, times, D, F, Dout, residuals, mask: { inside: mask.inside.length, threshold: mask.threshold },
      floorD, floorF, elapsedS: Math.round((Date.now() - started) / 1000),
      bands: radii.map((band, i) => (band === null ? null : { km: band.km, d: bandD[i] })),
      bandEvalPixels: evalPixels.length,
    };
  } finally {
    await session.close();
  }
}

function analyse(config, series) {
  const { times, D, F, Dout } = series;
  const sorted = sortedNumbers(D);
  const median = quantile(sorted, 0.5);
  const max = sorted[sorted.length - 1];
  const floorMedian = quantile(sortedNumbers(series.floorD), 0.5);
  // 周期の探索は、10 分の窓の移動中央値を引いた残差で行う。傾きの残りが lag 2 の峰を作るのを避ける。
  const acf = autocorrelation(detrendByMedian(D, Math.max(2, Math.round(600 / config.deltaS))));
  // D の添字 i は時刻 times[i + 1] の撮影と前の撮影の差。
  const frameTimes = D.map((_, i) => times[i + 1]);
  const onCycle = frameTimes.map((t) => {
    const r = ((t % CYCLE_S) + CYCLE_S) % CYCLE_S;
    return Math.min(r, CYCLE_S - r) <= config.deltaS / 2;
  });
  const cycleFrames = D.filter((_, i) => onCycle[i]);
  const top = D.map((value, i) => ({ value, time: frameTimes[i], onCycle: onCycle[i] }))
    .sort((a, b) => b.value - a.value).slice(0, 8);
  const correlation = lagCorrelation(series.residuals, Math.round(config.tauS / config.deltaS));
  const bands = series.bands.map((band) => (
    band === null || band.d.length < 4 ? null : { km: band.km, d: band.d, ...speedStats(band.d, config.deltaS) }
  ));
  // 帯をまとめた合計の速さ。無い帯(null)は 0 として足す。
  const total = series.times.slice(1).map((_, k) =>
    series.bands.reduce((s, band) => s + (band === null ? 0 : band.d[k]), 0));
  const bandsTotal = total.length >= 4 ? speedStats(total, config.deltaS) : null;
  return {
    corr: correlation === null ? null : {
      tauS: Math.round(config.tauS / config.deltaS) * config.deltaS,
      mean: correlation.mean, sd: correlation.sd, cv: correlation.cv, min: correlation.min, max: correlation.max,
      C: correlation.C, graph: asciiGraph(correlation.C, 80, correlation.min),
    },
    D: {
      median, p99: quantile(sorted, 0.99), max, spikeRatio: max / median,
      meanOverFloor: floorMedian > 0 ? median / floorMedian : null,
    },
    F: { median: quantile(sortedNumbers(F), 0.5), max: Math.max(...F) },
    Dout: { median: quantile(sortedNumbers(Dout), 0.5) },
    floor: {
      D: floorMedian, Fmedian: quantile(sortedNumbers(series.floorF), 0.5),
      Dsamples: series.floorD,
    },
    periodic: {
      lagFrames: acf.peak, periodS: acf.peak * config.deltaS, acf: acf.peakValue, z: acf.zScore,
    },
    cycle: {
      frames: cycleFrames.length,
      meanD: cycleFrames.length > 0 ? cycleFrames.reduce((s, v) => s + v, 0) / cycleFrames.length : null,
      ratioToMedian: cycleFrames.length > 0 ? (cycleFrames.reduce((s, v) => s + v, 0) / cycleFrames.length) / median : null,
    },
    topSpikes: top.map((spike) => ({ timeS: spike.time, D: spike.value, onCycle: spike.onCycle })),
    graph: asciiGraph(D),
    bands,
    bandsTotal,
  };
}

function printSummary(label, config, shotName, series, stats) {
  const line = (text) => console.log(text);
  line(`[temporal] label=${label} shot=${shotName} Δ=${config.deltaS} s N=${config.frames} start=${config.startS} s`);
  line(`  雲の画素 ${series.mask.inside}/${series.width * series.height} (閾値 ${series.mask.threshold.toFixed(1)})、撮影 ${series.elapsedS} s`);
  line(`  D  中央値 ${stats.D.median.toFixed(3)}  99%点 ${stats.D.p99.toFixed(3)}  最大 ${stats.D.max.toFixed(3)}  スパイク比 ${stats.D.spikeRatio.toFixed(2)}`);
  line(`  F  中央値 ${stats.F.median.toFixed(4)}  最大 ${stats.F.max.toFixed(4)}  Dout(雲の外) 中央値 ${stats.Dout.median.toFixed(3)}`);
  line(`  床 撮り直しの D 中央値 ${stats.floor.D.toFixed(3)} (各 ${stats.floor.Dsamples.map((v) => v.toFixed(3)).join(', ')})  F 中央値 ${stats.floor.Fmedian.toFixed(4)}`);
  line(stats.floor.D === 0
    ? '  床 0: 同じ時刻の撮り直しは画素まで一致(撮影は決定的)'
    : `  D 中央値 / 床 = ${stats.D.meanOverFloor.toFixed(2)}`);
  line(`  周期的なピーク(残差・相関が切れた後): lag ${stats.periodic.lagFrames} 枚 = ${stats.periodic.periodS} s、自己相関 ${stats.periodic.acf.toFixed(3)}、z ${stats.periodic.z.toFixed(1)}`);
  line(`  7200 s の倍数の枚: ${stats.cycle.frames} 枚、平均 D ${stats.cycle.meanD?.toFixed(3) ?? '-'}、中央値比 ${stats.cycle.ratioToMedian?.toFixed(2) ?? '-'}`);
  line(`  上位のスパイク(時刻 s: D, 7200 倍数か): ${stats.topSpikes.map((s) => `${s.timeS}: ${s.D.toFixed(3)}${s.onCycle ? ' *' : ''}`).join(', ')}`);
  if (stats.corr !== null) {
    const c = stats.corr;
    line(`  C(t) 残差の相関 τ=${c.tauS} s: 平均 ${c.mean.toFixed(3)}  標準偏差 ${c.sd.toFixed(3)}  CV ${c.cv.toFixed(3)}  最小 ${c.min.toFixed(3)}  最大 ${c.max.toFixed(3)}`);
    line(`  C(t) t = ${config.startS} … ${config.startS + (c.C.length - 1) * config.deltaS} s(縦は ${c.min.toFixed(2)} … ${c.max.toFixed(2)}):`);
    line(`  |${c.graph}|`);
  }
  line(`  D(k) 0 … ${config.startS + config.frames * config.deltaS} s:`);
  line(`  |${stats.graph}|`);
  line(`  帯別の速さ d_b(k) = 1 − max NCC(±${BAND_SHIFT_RADIUS} px、評価画素 ${series.bandEvalPixels}):`);
  line('  帯 [km]      平均      標準偏差  CV      最大/平均  周期ピーク(lag・acf・z)  acf@7200 s');
  for (const band of stats.bands) {
    if (band === null) continue;
    const b = band;
    const peak = `${b.peak.periodS} s・${b.peak.acf.toFixed(2)}・z ${b.peak.z.toFixed(1)}`;
    line(`  ${String(b.km[0]).padStart(2)}-${String(b.km[1]).padEnd(3)}    ${b.mean.toFixed(4)}    ${b.sd.toFixed(4)}    ${b.cv.toFixed(3)}    ${b.maxOverMean.toFixed(2)}        ${peak}  ${b.acfAtCycle === null ? '-' : b.acfAtCycle.toFixed(2)}`);
    line(`  |${asciiGraph(b.d)}|`);
  }
  if (stats.bandsTotal !== null) {
    const t = stats.bandsTotal;
    line(`  合計          ${t.mean.toFixed(4)}    ${t.sd.toFixed(4)}    ${t.cv.toFixed(3)}    ${t.maxOverMean.toFixed(2)}        ${t.peak.periodS} s・${t.peak.acf.toFixed(2)}・z ${t.peak.z.toFixed(1)}  ${t.acfAtCycle === null ? '-' : t.acfAtCycle.toFixed(2)}`);
  }
}

// ---- 自己検査(撮影なし) ----
// 合成の系列は 1 画素を 1 km と読み、実機と同じ周期(7200 s ÷ 60 s = 120 枠)・窓の割合 0.4・
// 段ごとの位相ずらし・移流(風 8 m/s 程度 → 0.4 画素/枠)で場を進める。
const SELFTEST_SIZE = 256;
const SELFTEST_PERIOD = 120;
const SELFTEST_BLEND = 0.4;
const SELFTEST_STAGGER = 0.6180339887;
const SELFTEST_OCTAVES = [2, 4, 8, 16, 32, 64];
const SELFTEST_DRIFT = 0.4;
// 段の模様が周期の中で連続に変わる量(格子単位/枠)。実機では周期あたり寿命の数倍ぶん滑らせて読む。
const SELFTEST_SLIDE = 0.04;

// (octave, seed) の乱数格子の 1 要素。
function selftestHash(octave, seed, i, j) {
  let h = Math.imul(octave + 1, 73856093) ^ Math.imul(seed + 1, 19349663)
    ^ Math.imul(i, 83492791) ^ Math.imul(j, 2654435761 % 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h ^= h >>> 16;
  return (h >>> 0) / 2147483648 - 1;
}

// octave の波長 wavelength [画素] の乱数格子(間隔 wavelength/2)。移流と滑りで読む範囲が枠より
// 横に広がるぶんだけ横幅を足す。
function selftestGrid(octave, seed, wavelength, frames) {
  const spacing = wavelength / 2;
  const gx = Math.ceil((SELFTEST_SIZE + SELFTEST_DRIFT * frames + SELFTEST_SLIDE * frames * spacing) / spacing) + 3;
  const gy = Math.ceil(SELFTEST_SIZE / spacing) + 2;
  const grid = new Float32Array(gx * gy);
  for (let j = 0; j < gy; j++) {
    for (let i = 0; i < gx; i++) grid[j * gx + i] = selftestHash(octave, seed, i, j);
  }
  return { spacing, gx, gy, grid };
}

// 格子の (fx, fy)[格子座標] を双線形で読む。
function selftestSample({ gx, gy, grid }, fx, fy) {
  const i0 = Math.max(0, Math.min(gx - 2, Math.floor(fx)));
  const j0 = Math.max(0, Math.min(gy - 2, Math.floor(fy)));
  const tx = Math.max(0, Math.min(1, fx - i0));
  const ty = Math.max(0, Math.min(1, fy - j0));
  const a = grid[j0 * gx + i0] + (grid[j0 * gx + i0 + 1] - grid[j0 * gx + i0]) * tx;
  const b = grid[(j0 + 1) * gx + i0] + (grid[(j0 + 1) * gx + i0 + 1] - grid[(j0 + 1) * gx + i0]) * tx;
  return a + (b - a) * ty;
}

const SELFTEST_WEIGHTS = (() => {
  const raw = SELFTEST_OCTAVES.map((wavelength) => wavelength ** 0.7);
  const total = raw.reduce((s, w) => s + w, 0);
  return raw.map((w) => w / total);
})();

// 合成の 1 枠。variant: 'windowed'(周期の窓だけで次の種へ渡す)、'steady'(半周期ずらした 2 位相を
// sin の重みで常に重ねる)、'advect'(移流だけで種は変わらない)。戻り値は輝度相当の場。
function selftestFrame(variant, k, grids) {
  const field = new Float64Array(SELFTEST_SIZE * SELFTEST_SIZE);
  for (const [oi, wavelength] of SELFTEST_OCTAVES.entries()) {
    const elapsed = k / SELFTEST_PERIOD + oi * SELFTEST_STAGGER;
    const cycle = Math.floor(elapsed);
    const age = elapsed - cycle;
    // 位相 phase・種 seed で読み位置は位相ぶん移流し、枠 k に比例して格子座標を滑らせる。
    const addOctave = (phase, seed, weight, slide = true) => {
      const grid = grids.get(`${oi}:${seed}`);
      const shiftX = phase * SELFTEST_PERIOD * SELFTEST_DRIFT
        + (slide ? k * SELFTEST_SLIDE * wavelength / 2 : 0);
      for (let y = 0; y < SELFTEST_SIZE; y++) {
        const row = y * SELFTEST_SIZE;
        for (let x = 0; x < SELFTEST_SIZE; x++) {
          field[row + x] += SELFTEST_WEIGHTS[oi] * weight
            * selftestSample(grid, (x + shiftX) / grid.spacing, y / grid.spacing);
        }
      }
    };
    if (variant === 'advect') {
      addOctave(k / SELFTEST_PERIOD, 0, 1, false);
    } else if (variant === 'steady') {
      const halfElapsed = elapsed + 0.5;
      const halfCycle = Math.floor(halfElapsed);
      const ageB = halfElapsed - halfCycle;
      addOctave(age, 2 * cycle, Math.sin(Math.PI * age));
      addOctave(ageB, 2 * halfCycle + 1, Math.sin(Math.PI * ageB));
    } else {
      const blendStart = 1 - SELFTEST_BLEND;
      if (age <= blendStart) {
        addOctave(age, cycle, 1);
      } else {
        const t = (age - blendStart) / SELFTEST_BLEND;
        const w = t * t * (3 - 2 * t) * Math.PI / 2;
        addOctave(age, cycle, Math.cos(w));
        addOctave(age, cycle + 1, Math.sin(w));
      }
    }
  }
  return field;
}

// 合成の系列へ帯別の速さの解析を当て、2 指標(NCC・RMS)の識別を並べて出す。
function runSelftest() {
  const frames = Math.round(SELFTEST_PERIOD * 2.5);
  const radii = bandRadii(1);
  const inside = Uint32Array.from({ length: SELFTEST_SIZE * SELFTEST_SIZE }, (_, i) => i);
  const evalPixels = bandEvalPixels(inside, SELFTEST_SIZE, SELFTEST_SIZE);
  const maxSeed = 2 * (Math.ceil(frames / SELFTEST_PERIOD + SELFTEST_OCTAVES.length * SELFTEST_STAGGER) + 1) + 1;
  const grids = new Map();
  for (const [oi, wavelength] of SELFTEST_OCTAVES.entries()) {
    for (let seed = 0; seed <= maxSeed; seed++) {
      grids.set(`${oi}:${seed}`, selftestGrid(oi, seed, wavelength, frames));
    }
  }
  for (const variant of ['advect', 'windowed', 'steady']) {
    const bandD = { ncc: radii.map(() => []), rms: radii.map(() => []) };
    let previousFields = null;
    for (let k = 0; k < frames; k++) {
      const luminance = selftestFrame(variant, k, grids);
      const fields = bandFields(luminance, SELFTEST_SIZE, SELFTEST_SIZE, inside, radii);
      if (previousFields !== null) {
        for (const [i, field] of fields.entries()) {
          if (field === null) continue;
          bandD.ncc[i].push(bandSpeedNcc(previousFields[i], field, SELFTEST_SIZE, evalPixels));
          bandD.rms[i].push(bandSpeedRms(previousFields[i], field, SELFTEST_SIZE, evalPixels));
        }
      }
      previousFields = fields;
    }
    console.log(`[selftest] ${variant} (${frames} 枠、周期 ${SELFTEST_PERIOD} 枠、評価画素 ${evalPixels.length})`);
    for (const metric of ['ncc', 'rms']) {
      console.log(`  指標 ${metric}   帯 [km]      平均      CV      最大/平均  ピーク(lag・acf・z)`);
      for (const [i, band] of radii.entries()) {
        if (band === null) continue;
        const s = speedStats(bandD[metric][i], 1);
        console.log(
          `             ${String(band.km[0]).padStart(2)}-${String(band.km[1]).padEnd(3)}    ${s.mean.toFixed(4)}    `
          + `${s.cv.toFixed(3)}    ${s.maxOverMean.toFixed(2)}        ${s.peak.lagFrames}・${s.peak.acf.toFixed(2)}・z ${s.peak.z.toFixed(1)}`);
      }
    }
  }
}

async function main() {
  const config = readConfig();
  if (config.mode === 'selftest') {
    runSelftest();
    return;
  }
  const shotName = `${config.scene}-0h-${config.kmPerPx}km-${config.kind}`;
  buildRenderLab();
  const git = gitInfo();
  const label = config.label ?? (git.dirty ? 'working' : 'head');
  const series = await measureSeries(config, shotName);
  const stats = analyse(config, series);
  printSummary(label, config, shotName, series, stats);

  mkdirSync(outDir, { recursive: true });
  const fileName = `${label}-${config.kmPerPx}km-d${config.deltaS}s-n${config.frames}.json`;
  const outPath = path.join(outDir, fileName);
  writeFileSync(outPath, `${JSON.stringify({
    git, config, shot: shotName, width: series.width, height: series.height,
    maskPixels: series.mask.inside, bandEvalPixels: series.bandEvalPixels,
    times: series.times, D: series.D, F: series.F, Dout: series.Dout,
    stats,
  }, null, 2)}\n`);
  console.log(`  保存: ${outPath}`);
}

await main();
