// 雲の時間方向の連続性の計測。render-lab の雲の細部の撮影を、視点を固定したまま表示時刻を一定の刻み Δ で
// 進めて N 枚連続で撮り、前後の 2 枚の差から、一定間隔で急に変わるかを見る。
//   D(k) = 雲の画素の平均絶対差 [1/255]、F(k) = 最大チャンネル差が CHANGE_THRESHOLD を超える雲の画素の割合。
// 雲の画素は最初の撮影の輝度から決める(下位 10% の輝度 + CLOUD_MASK_MARGIN より明るい画素)。雲の外の
// 画素の差(Dout)は対照として併記する。撮影ノイズの床は、同じ時刻を撮り直した差(FLOOR_SAMPLES 点)で測る。
// 解析は D の中央値・99%点・最大・スパイク比、D の自己相関による周期的なピーク、上位のスパイクの時刻と
// 7200 s の倍数(段の周期)に乗っているかの割合を出す。結果は .cloud-detail/temporal/ へ JSON で残す。
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
const DEFAULTS = { scene: 'natl-trade', kmPerPx: 1, deltaS: 60, frames: 240, startS: 0, label: null };
// 段の読み直しの上限周期 [表示時刻の秒](cloud-detail-clock.ts の MAX_RECYCLE_PERIOD)。入れ替わりの周期。
const CYCLE_S = 7200;
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

// 最初の撮影から雲の画素を決める。輝度の下位 10% + CLOUD_MASK_MARGIN より明るい画素。
function cloudPixels(rgb, pixelCount) {
  const luminance = new Float64Array(pixelCount);
  for (let p = 0; p < pixelCount; p++) {
    luminance[p] = 0.2126 * rgb[3 * p] + 0.7152 * rgb[3 * p + 1] + 0.0722 * rgb[3 * p + 2];
  }
  const sorted = Float64Array.from(luminance).sort();
  const threshold = sorted[Math.floor(0.1 * (pixelCount - 1))] + CLOUD_MASK_MARGIN;
  const inside = [];
  const outside = [];
  for (let p = 0; p < pixelCount; p++) (luminance[p] > threshold ? inside : outside).push(p);
  return { inside: Uint32Array.from(inside), outside: Uint32Array.from(outside), threshold };
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

// D の系列を幅 width の文字の帯にする。各欄は中の最大値。
function asciiGraph(values, width = 80) {
  const levels = ' ▁▂▃▄▅▆▇█';
  const max = Math.max(...values);
  const cells = [];
  for (let c = 0; c < width; c++) {
    const from = Math.floor((c * values.length) / width);
    const to = Math.max(from + 1, Math.floor(((c + 1) * values.length) / width));
    let cell = 0;
    for (let i = from; i < to; i++) cell = Math.max(cell, values[i]);
    cells.push(levels[Math.min(levels.length - 1, Math.round((cell / max) * (levels.length - 1)))]);
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

    const times = Array.from({ length: config.frames }, (_, k) => config.startS + k * config.deltaS);
    const floorIndices = Array.from({ length: FLOOR_SAMPLES }, (_, j) =>
      Math.round(((j + 0.5) * config.frames) / FLOOR_SAMPLES));
    const started = Date.now();
    let width = 0;
    let height = 0;
    let mask = null;
    let previous = null;
    const D = [];
    const F = [];
    const Dout = [];
    const kept = new Map();
    for (let k = 0; k < times.length; k++) {
      const { width: w, height: h, rgb } = rgbOfDataUrl(await settledFrame(devTools, times[k]));
      width = w;
      height = h;
      if (mask === null) mask = cloudPixels(rgb, w * h);
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
      width, height, times, D, F, Dout, mask: { inside: mask.inside.length, threshold: mask.threshold },
      floorD, floorF, elapsedS: Math.round((Date.now() - started) / 1000),
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
  return {
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
  line(`  D(k) 0 … ${config.startS + config.frames * config.deltaS} s:`);
  line(`  |${stats.graph}|`);
}

async function main() {
  const config = readConfig();
  const shotName = `${config.scene}-0h-${config.kmPerPx}km-both`;
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
    maskPixels: series.mask.inside, times: series.times, D: series.D, F: series.F, Dout: series.Dout,
    stats,
  }, null, 2)}\n`);
  console.log(`  保存: ${outPath}`);
}

await main();
