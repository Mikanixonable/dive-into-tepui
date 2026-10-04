// 近傍拡散補正の計測が使う、評価の組と解析値のある窓、それを描画テスト環境で撮る口と誤差の指標を測る口と平面を均す口、
// 基準の置き場、表の書式。撮影は走査の段とブルーノイズの seed を与え、表示の絵と浮動小数の中間ターゲットを受け取る。中間ターゲットは
// ページの中で積むこともでき(和か、倍精度の和と二乗和と成分の和の高次の冪和)、積んだ HDR の平均は本番と同じ合成で表示にして
// 受け取る。
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openChromeSession, waitFor } from './chrome-session.mjs';
import { decodePng } from './png.mjs';
import { exposedCorrectionOf, linearOfSrgbCodes, rmsOf, srgbToLinear, windowMean } from './screen-space-error.mjs';

// リポジトリ根と、組んだ描画テスト環境、撮影組の置き場。
const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
export const shotsDir = path.join(root, '.render-lab-shots');
const port = 8771;
const debugPort = 9447;
// 描画テスト環境の絵の寸法 [画素]。
export const WIDTH = 960;
export const HEIGHT = 540;

// 描画設定 screenSpaceDiffuse の値(src/render/pipeline/screen-space/screen-space-pass.ts)。
const MODE = { occlusion: 1, indirect: 2 };
// 全撮影へ重ねる描画設定。目で見る画像は候補の表示と基準の合成の差から作る。レンズ効果は明るい面の光を、
// アンチエイリアス(値 0 はなし)は表示を縁の向こうへ広げ、どちらも基準の合成には掛からないので切る。
const EVALUATION_GRAPHICS = { lens: false, antialias: 0 };

// 評価の組。set は tuning(調整用)・checking(確認用)・correctness(解析値との照合)・flicker(ちらつき)、mode は
// 描画設定 screenSpaceDiffuse の値、dolly はカメラの距離の倍率の常用対数。key は撮影名に、遮蔽の方式なら
// @occlusion、カメラを引いたなら @dolly<フレーム> を付けたもの。
const DOLLY_STEP = 0.0005;
const DOLLY_FRAMES = 6;
const entry = (set, caseName, shot, mode = MODE.indirect, dolly = 0) => {
  const suffix = `${mode === MODE.occlusion ? '@occlusion' : ''}${dolly ? `@dolly${Math.round(dolly / DOLLY_STEP)}` : ''}`;
  return { set, caseName, shot, mode, dolly, key: `${shot}${suffix}` };
};
export const ENTRIES = [
  ...['bay', 'bay-dark', 'bay-earth-open', 'bay-bounce'].map((shot) => entry('tuning', 'bay', shot)),
  ...['groove-ladder', 'groove-ladder-near', 'groove-ladder-far', 'groove-ladder-bounce']
    .map((shot) => entry('tuning', 'groove-ladder', shot)),
  entry('tuning', 'slope-fan', 'slope-fan'),
  ...['bay-distance-0.5x', 'bay-distance-2.5x', 'bay-truss', 'bay-edge'].map((shot) => entry('checking', 'bay', shot)),
  entry('checking', 'groove-ladder', 'groove-ladder-check'),
  entry('checking', 'slope-fan', 'slope-fan-check'),
  ...['cornell-box', 'cornell-box-grazing'].map((shot) => entry('checking', 'cornell-box', shot)),
  ...['bay-earthshine', 'bay-earth-overhead', 'bay-earth-corner', 'bay-moon-open', 'bay-moon-corner']
    .flatMap((shot) => Object.values(MODE).map((mode) => entry('correctness', 'bay', shot, mode))),
  entry('correctness', 'bounce-cosine', 'bounce-cosine'),
  ...[
    'plane-earth-overhead', 'plane-earth-low', 'plane-earth-horizon', 'plane-moon-overhead', 'plane-moon-low',
    'plane-moon-horizon', 'plane-ambient', 'plane-earth-low-grazing', 'plane-ambient-grazing',
  ].flatMap((shot) => Object.values(MODE).map((mode) => entry('correctness', 'plane', shot, mode))),
  ...Array.from({ length: DOLLY_FRAMES }, (_, k) => entry('flicker', 'bay', 'bay', MODE.indirect, (k + 1) * DOLLY_STEP)),
];

// 評価の組のうち、entries(撮影の key を , で並べた文字列)と sets(set を , で並べた文字列)の両方に当たるもの。
// undefined の方は絞らない。
export function selectedEntries({ entries, sets }) {
  const keys = entries?.split(',');
  const setNames = sets?.split(',');
  const selected = ENTRIES.filter((e) => (keys?.includes(e.key) ?? true) && (setNames?.includes(e.set) ?? true));
  if (selected.length === 0) throw new Error(`no entries match --entries ${entries} --sets ${sets}`);
  return selected;
}

// 撮影 e を、描画設定 screenSpaceDiffuse を方式 modeName(MODE の名前)にして撮るもの。
export function entryInMode(e, modeName) {
  if (!Object.hasOwn(MODE, modeName)) throw new Error(`unknown mode ${modeName}: one of ${Object.keys(MODE).join(', ')}`);
  return entry(e.set, e.caseName, e.shot, MODE[modeName], e.dolly);
}

// 受け手の近傍の半径に効きを渡すフェードの外側 [走査の画素](src/render/pipeline/screen-space/hemisphere-scan.ts の
// smoothstep(1, 2, radius))。
const FADE_OUTER_SCAN_PX = 2;
// 撮影 1 枚が、絵の落ち着きを待って撮る回数の上限。
const MAX_SETTLE_CAPTURES = 6;
// 段の費用の計測を待つ上限 [ms]。段 1 つの 1 巡に 2〜4 秒かかる。
const MEASURE_TIMEOUT_MS = 15 * 60_000;

// seed の列。ブルーノイズのタイル(一辺 SEED_GRID テクセル)の整数のずれを、R2 列(plastic number g の
// α = (1/g, 1/g²))の点 fract(n·α) が落ちる格子の順に、重複を飛ばして並べる。どこで打ち切っても格子に一様に散る。
const SEED_GRID = 64;
const PLASTIC = 1.324717957244746;
const R2_ALPHA = [1 / PLASTIC, 1 / PLASTIC ** 2];
const SEED_CELLS = (() => {
  const seen = new Set();
  const cells = [];
  for (let n = 0; cells.length < SEED_GRID * SEED_GRID; n++) {
    const [x, y] = R2_ALPHA.map((a) => Math.floor(((n * a) % 1) * SEED_GRID));
    if (seen.has(y * SEED_GRID + x)) continue;
    seen.add(y * SEED_GRID + x);
    cells.push([x / SEED_GRID, y / SEED_GRID]);
  }
  return cells;
})();
// k 番目の seed [タイルの幅]。seedOf(0) は (0, 0)(本番と同じ絵)。k は格子の数(4096)未満。
export function seedOf(k) {
  if (k >= SEED_CELLS.length) throw new Error(`seed ${k} exceeds the ${SEED_CELLS.length} tile shifts`);
  return SEED_CELLS[k];
}

// 基準と比べる候補の k 番目の seed。列の末尾から取り、先頭の seedOf(0〜referencePasses − 1) で作った基準のパスと
// 重なるなら投げる。
export function candidateSeedOf(k, referencePasses) {
  const index = SEED_CELLS.length - 1 - k;
  if (index < referencePasses) {
    throw new Error(`candidate seed ${k} overlaps ${referencePasses} reference passes of ${SEED_CELLS.length} seeds`);
  }
  return SEED_CELLS[index];
}

// いまの精細さの段(src/render/pipeline/screen-space/screen-space-pass.ts の SCAN_TIERS)。
export const TIERS = {
  low: { scale: 0.25, sliceCount: 2, stepCount: 3, bandCount: 4, bandScale: 1 / 8 },
  medium: { scale: 0.25, sliceCount: 4, stepCount: 5, bandCount: 4, bandScale: 1 / 8 },
  high: { scale: 0.25, sliceCount: 4, stepCount: 6, bandCount: 4, bandScale: 1 / 8 },
};
// 中の段の、帯に分けない愚直な点。走査の帯 0 が raw。
export const MEDIUM_RAW_TIER = { ...TIERS.medium, bandCount: 1 };

// 走査が帯ごとの補正を詰めるテクスチャ(src/render/pipeline/screen-space/band-pyramid.ts)の、帯の数 bandCount の段での
// 読み戻しの名前の並び(テクスチャの番号順)。帯 b の成分 c は、テクスチャを並べた通しのチャンネル 3b + c。
export const packedBandsNamesOf = (bandCount) => Array.from(
  { length: Math.ceil(3 * bandCount / 4) }, (_, i) => `packed-bands-${i}`);

// 詰めたテクスチャの、画素ごとに 4 成分の並び packed(packedBandsNamesOf の順)から、帯 band の画素ごとの rgb を同じ型で
// 取り出す。
export function unpackedBand(packed, band) {
  const pixels = packed[0].length / 4;
  const out = new packed[0].constructor(pixels * 3);
  for (let c = 0; c < 3; c++) {
    const channel = 3 * band + c;
    const texture = packed[Math.floor(channel / 4)];
    for (let p = 0; p < pixels; p++) out[3 * p + c] = texture[4 * p + channel % 4];
  }
  return out;
}

// HEAD の短いハッシュ。
export const headHash = () => execSync('git rev-parse --short HEAD', { cwd: root, encoding: 'utf8' }).trim();

// ---- 撮影 ----

// accumulateMoments が成分の和のずれの冪和を積む、最高の次数。
const MOMENT_ORDER = 4;

// ページの式 source が指す長さ length の、型 type(Float32Array か Float64Array)の配列を受け取る。CDP の 1 通の上限を
// 超えないよう、塊ごとに受け取る。
const BYTES_PER_CHUNK = 64 * WIDTH * 3 * 4;
async function receiveFloats(devTools, source, length, type = Float32Array) {
  const out = new type(length);
  const byteLength = length * type.BYTES_PER_ELEMENT;
  for (let start = 0; start < byteLength; start += BYTES_PER_CHUNK) {
    const size = Math.min(byteLength - start, BYTES_PER_CHUNK);
    const base64 = await devTools.evaluate(`new Uint8Array(${source}.buffer, ${start}, ${size}).toBase64()`);
    const bytes = Buffer.from(base64, 'base64');
    out.set(new type(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + size)), start / type.BYTES_PER_ELEMENT);
  }
  return out;
}

// ページの式 source が解決する Float32Array を受け取る。
async function receiveResolvedFloats(devTools, source) {
  const length = await devTools.evaluate(
    `(${source}).then((values) => { window.__ssdFloat = values; return values.length; })`);
  const out = await receiveFloats(devTools, 'window.__ssdFloat', length);
  await devTools.evaluate('delete window.__ssdFloat');
  return out;
}

// 型付き配列 values の写しを、ページの式 destination が指す場所へ同じ型で置く。塊ごとに送る。
async function sendArray(devTools, destination, values) {
  await devTools.evaluate(`${destination} = new ${values.constructor.name}(${values.length}), 0`);
  const bytes = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
  for (let start = 0; start < bytes.length; start += BYTES_PER_CHUNK) {
    const base64 = bytes.subarray(start, start + BYTES_PER_CHUNK).toString('base64');
    await devTools.evaluate(`new Uint8Array(${destination}.buffer)
      .set(Uint8Array.fromBase64('${base64}'), ${start}), 0`);
  }
}

// 平面の組 planes(R・G・B)を画素ごとに rgb を並べてページの window.__ssdRgb へ、面の幾何 geometry({ position, normal,
// footprint } の Float32Array)を window.__ssdGeometry へ置く。
async function sendRgbAndGeometry(devTools, planes, geometry) {
  const count = planes[0].length;
  const rgb = new Float32Array(3 * count);
  for (let p = 0; p < count; p++) {
    for (let c = 0; c < 3; c++) rgb[3 * p + c] = planes[c][p];
  }
  await sendArray(devTools, 'window.__ssdRgb', rgb);
  await devTools.evaluate('window.__ssdGeometry = {}, 0');
  for (const key of ['position', 'normal', 'footprint']) {
    await sendArray(devTools, `window.__ssdGeometry.${key}`, geometry[key]);
  }
}

// 画素ごとに rgb を並べた rgb を平面の組(R・G・B)へ。
const planesOfRgb = (rgb) => [0, 1, 2].map((c) => Float32Array.from({ length: rgb.length / 3 }, (_, p) => rgb[3 * p + c]));

// 描画テスト環境の CDP の入口を包む。
function labOf(devTools) {
  const call = (expression) => devTools.evaluate(`window.renderLab.${expression}`);
  const pngOf = (dataUrl) => Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  return {
    // 評価の組の 1 つ entry を表示する。
    async show(entry) {
      await call(`showShot(${JSON.stringify(entry.caseName)}, ${JSON.stringify(entry.shot)}, ${JSON.stringify({ ...EVALUATION_GRAPHICS, screenSpaceDiffuse: entry.mode })})`);
      if (entry.dolly) await call(`setView(${JSON.stringify({ cameraDistanceLog: entry.dolly })})`);
    },
    setTier: (tier) => call(`setScanTier(${JSON.stringify(tier)})`),
    // seed は seedOf の返す [x, y]。
    setSeed: ([x, y]) => call(`setScanSeed(${x}, ${y})`),
    setTarget: (target) => call(`setTarget(${JSON.stringify(target)})`),
    exposureFactor: () => call('exposureFactor()'),
    // 段 tiers を rounds 巡交互に測る。段と巡が多いと CDP の 1 要求の待ちを越えるので、ページの中で走らせて
    // 終わりを待つ。
    async measureTiers(tiers, rounds) {
      await devTools.evaluate(`(window.__ssdCosts = null, window.renderLab.measureTiers(${JSON.stringify(tiers)}, ${rounds})
        .then((costs) => { window.__ssdCosts = { costs }; }, (e) => { window.__ssdCosts = { error: String(e) }; }), 0)`);
      await waitFor(devTools, 'window.__ssdCosts !== null', 'the tier costs', MEASURE_TIMEOUT_MS);
      const { costs, error } = await devTools.evaluate('window.__ssdCosts');
      await devTools.evaluate('delete window.__ssdCosts');
      if (error !== undefined) throw new Error(`measureTiers failed: ${error}`);
      return costs;
    },
    // いまの絵を、連続する 2 回が一致するまで撮り直して PNG の Buffer で返す。
    async capturePng() {
      let previous = await call('capture()');
      for (let count = 2; count <= MAX_SETTLE_CAPTURES; count++) {
        const next = await call('capture()');
        if (next === previous) return pngOf(next);
        previous = next;
      }
      throw new Error(`capture did not settle within ${MAX_SETTLE_CAPTURES} captures`);
    },
    // いまの設定で 1 フレーム描く。
    render: () => call('render()'),
    // 直前のフレームの中間ターゲット name の、画素ごとに先頭 channels 成分の Float32Array。
    async readFloat(name, channels) {
      const [width, height] = await devTools.evaluate(`window.renderLab.readFloat(${JSON.stringify(name)})
        .then(({ width, height, rgba }) => {
          const packed = new Float32Array(width * height * ${channels});
          for (let p = 0; p < width * height; p++) {
            for (let k = 0; k < ${channels}; k++) packed[p * ${channels} + k] = rgba[p * 4 + k];
          }
          window.__ssdFloat = packed;
          return [width, height];
        })`);
      const out = await receiveFloats(devTools, 'window.__ssdFloat', width * height * channels);
      await devTools.evaluate('delete window.__ssdFloat');
      return out;
    },
    // 直前のフレームの中間ターゲット name の寸法 [width, height]。
    floatSizeOf: (name) => devTools.evaluate(`window.renderLab.readFloat(${JSON.stringify(name)})
      .then(({ width, height }) => [width, height])`),
    // 直前のフレームの中間ターゲット name の先頭 channels 成分を、ページの中に name ごとに積む slot 番目の和へ足す。
    // 積んだ和は takeAccumulated で受け取る。
    accumulateFloat: (name, channels, slot) => devTools.evaluate(`window.renderLab.readFloat(${JSON.stringify(name)})
      .then(({ width, height, rgba }) => {
        const sums = ((window.__ssdSums ??= {})[${JSON.stringify(name)}] ??= { width, height, channels: ${channels}, slots: [] });
        const sum = (sums.slots[${slot}] ??= new Float32Array(width * height * ${channels}));
        for (let p = 0; p < width * height; p++) {
          for (let k = 0; k < ${channels}; k++) sum[p * ${channels} + k] += rgba[p * 4 + k];
        }
      })`),
    // 直前のフレームの中間ターゲット name の先頭 channels 成分を、ページの中に name ごとに積む slot 番目の和と二乗和
    // (倍精度)へ足し、画素ごとの成分の和の、原点(画素ごとに最初に積んだ成分の和)からのずれの 1〜MOMENT_ORDER 乗の和
    // (倍精度)を slot によらず足す。積んだ和は takeMoments で受け取る。
    accumulateMoments: (name, channels, slot) => devTools.evaluate(`window.renderLab.readFloat(${JSON.stringify(name)})
      .then(({ width, height, rgba }) => {
        const moments = ((window.__ssdMoments ??= {})[${JSON.stringify(name)}] ??= { width, height, slots: [],
          origin: null, powerSums: Array.from({ length: ${MOMENT_ORDER} }, () => new Float64Array(width * height)) });
        const size = width * height * ${channels};
        const { sum, squareSum } = (moments.slots[${slot}] ??= {
          sum: new Float64Array(size), squareSum: new Float64Array(size) });
        const total = new Float64Array(width * height);
        for (let p = 0; p < width * height; p++) {
          for (let k = 0; k < ${channels}; k++) {
            const v = rgba[p * 4 + k];
            sum[p * ${channels} + k] += v;
            squareSum[p * ${channels} + k] += v * v;
            total[p] += v;
          }
        }
        // 平均に比べて揺れの小さい画素で、冪和から中心モーメントを求めるときの桁落ちを避けるため、原点をずらして積む。
        moments.origin ??= total;
        for (let p = 0; p < width * height; p++) {
          const deviation = total[p] - moments.origin[p];
          let power = 1;
          for (const powerSum of moments.powerSums) {
            power *= deviation;
            powerSum[p] += power;
          }
        }
      })`),
    // 保存しておいた name の和の並び sums(画素ごとに channels 成分)を、ページの中の和として置き直す。以後の
    // accumulateFloat はこれへ足す。
    async restoreAccumulated(name, channels, sums) {
      const destination = `window.__ssdSums[${JSON.stringify(name)}]`;
      await devTools.evaluate(`((window.__ssdSums ??= {})[${JSON.stringify(name)}] = {
        width: ${WIDTH}, height: ${HEIGHT}, channels: ${channels}, slots: [] }, 0)`);
      for (const [slot, sum] of sums.entries()) await sendArray(devTools, `${destination}.slots[${slot}]`, sum);
    },
    // name の全 slot の和を count で割った HDR の平均を、直前のフレームと同じ合成で表示にし、線形 sRGB(画素ごとに
    // 3 つ)で返す。合成の値を [0, 1] へ切ってから線形へ戻すので、撮った PNG と同じ量になる。
    async displayOfMean(name, count) {
      const length = await devTools.evaluate(`(async () => {
        const { width, height, channels, slots } = window.__ssdSums[${JSON.stringify(name)}];
        const rgba = new Float32Array(width * height * 4);
        for (let p = 0; p < width * height; p++) {
          for (let k = 0; k < 3; k++) {
            let v = 0;
            for (const slot of slots) if (slot !== undefined) v += slot[p * channels + k];
            rgba[p * 4 + k] = v / ${count};
          }
          rgba[p * 4 + 3] = 1;
        }
        const display = await window.renderLab.composite({ width, height, rgba });
        const packed = new Float32Array(width * height * 3);
        for (let p = 0; p < width * height; p++) {
          for (let k = 0; k < 3; k++) packed[p * 3 + k] = display.rgba[p * 4 + k];
        }
        window.__ssdFloat = packed;
        return packed.length;
      })()`);
      const encoded = await receiveFloats(devTools, 'window.__ssdFloat', length);
      await devTools.evaluate('delete window.__ssdFloat');
      return encoded.map((v) => srgbToLinear(Math.min(1, Math.max(0, v))));
    },
    // 候補 candidate と収束先 reference(平面の組、width × height)の誤差の指標を、印 mask(Uint8Array)の立った画素で
    // 測る。偽の構造の罰を覆い隠す真の構造は reference の構造。tools/render-lab/error-metric.ts の ErrorMeasurement に、
    // 誤差のベクトルの RMS g を足したもの。magnification は表示倍率 μ。
    async errorMetrics(candidate, reference, mask, width, height, magnification = 1) {
      const error = new Float32Array(width * height * 3);
      const converged = new Float32Array(width * height * 3);
      for (let p = 0; p < width * height; p++) {
        for (let c = 0; c < 3; c++) {
          error[p * 3 + c] = candidate[c][p] - reference[c][p];
          converged[p * 3 + c] = reference[c][p];
        }
      }
      await sendArray(devTools, 'window.__ssdError', error);
      await sendArray(devTools, 'window.__ssdConverged', converged);
      await sendArray(devTools, 'window.__ssdMask', mask);
      const measurement = await devTools.evaluate(`window.renderLab.errorMetrics(window.__ssdError,
        window.__ssdConverged, window.__ssdMask, ${width}, ${height}, ${magnification})
        .finally(() => { delete window.__ssdError; delete window.__ssdConverged; delete window.__ssdMask; })`);
      return { ...measurement, g: rmsOf(candidate, reference, mask) };
    },
    // 直前の errorMetrics の、画素ごとの偽の構造の項(3 成分の和)の Float32Array。
    falseStructureMap: () => receiveResolvedFloats(devTools, 'window.renderLab.falseStructureMap()'),
    // 平面 plane(画素ごとに 1 つ)を、面の画素 surface(Uint8Array)の値だけで、面の画素全体で正規化した標準偏差 sigma [画素] の
    // ガウスで均した Float32Array(面の無い画素は 0)。tools/render-lab/plane-smoother.ts の surfaceBlur。
    async surfaceBlur(plane, surface, sigma) {
      await sendArray(devTools, 'window.__ssdPlane', Float32Array.from(plane));
      await sendArray(devTools, 'window.__ssdSurface', surface);
      return receiveResolvedFloats(devTools, `window.renderLab.surfaceBlur(window.__ssdPlane, window.__ssdSurface,
        ${sigma}).finally(() => { delete window.__ssdPlane; delete window.__ssdSurface; })`);
    },
    // 平面 plane(画素ごとに 1 つ)を、区画 segments(画素ごとの区画の番号の Int32Array。区画の無い画素は負)ごとに、同じ区画の
    // 画素だけで正規化した標準偏差 sigma [画素] のガウスで均した Float32Array(区画の無い画素は 0)。
    // tools/render-lab/plane-smoother.ts の segmentBlur。
    async segmentBlur(plane, segments, sigma) {
      await sendArray(devTools, 'window.__ssdPlane', Float32Array.from(plane));
      await sendArray(devTools, 'window.__ssdSegments', segments);
      return receiveResolvedFloats(devTools, `window.renderLab.segmentBlur(window.__ssdPlane, window.__ssdSegments,
        ${sigma}).finally(() => { delete window.__ssdPlane; delete window.__ssdSegments; })`);
    },
    // 平面の組 planes(R・G・B)を、面の幾何 geometry({ position, normal, footprint } の Float32Array)の重みを付けた、半径
    // radius [画素] の疎なタップで均した平面の組。shift([x, y])はタップを回すブルーノイズのタイルのずれ [テクセル]。
    // tools/render-lab/plane-smoother.ts の sparseBilateral。
    async sparseBilateral(planes, geometry, radius, shift) {
      await sendRgbAndGeometry(devTools, planes, geometry);
      return planesOfRgb(await receiveResolvedFloats(devTools, `window.renderLab.sparseBilateral(window.__ssdRgb,
        window.__ssdGeometry, ${radius}, ${JSON.stringify(shift)})
        .finally(() => { delete window.__ssdRgb; delete window.__ssdGeometry; })`));
    },
    // 走査の解像度(絵の 1/block)の平面の組 scan を全解像度へ拡大した平面の組。全解像度の画素ごとに、中心を囲む 2×2 の走査の
    // 画素から、双線形の重み × 面の幾何 geometry(sparseBilateral と同じ形)の重みを確率として 1 つを選んで写す。
    // tools/render-lab/plane-smoother.ts の stochasticUpscale。
    async stochasticUpscale(scan, geometry, block) {
      await sendRgbAndGeometry(devTools, scan, geometry);
      return planesOfRgb(await receiveResolvedFloats(devTools, `window.renderLab.stochasticUpscale(window.__ssdRgb,
        window.__ssdGeometry, ${block}).finally(() => { delete window.__ssdRgb; delete window.__ssdGeometry; })`));
    },
    // 誤差の指標のスケール(errorMetrics の返すスケールごとの値の順)。
    errorScales: () => devTools.evaluate('window.renderLab.errorScales'),
    // 重みを掛ける前の偽の構造の項の床 ε の並び(errorMetrics の unweightedFalseStructure[帯][ε] の ε の順)。
    falseStructureEpsilons: () => devTools.evaluate('window.renderLab.falseStructureEpsilons'),
    // name の slot 0〜slotCount − 1 の和を受け取り、ページから消す。足していない slot は 0。
    async takeAccumulated(name, slotCount) {
      const source = `window.__ssdSums[${JSON.stringify(name)}]`;
      const size = await devTools.evaluate(`${source}.width * ${source}.height * ${source}.channels`);
      const sums = [];
      for (let slot = 0; slot < slotCount; slot++) {
        const slotSource = `${source}.slots[${slot}]`;
        sums.push(await devTools.evaluate(`${slotSource} !== undefined`)
          ? await receiveFloats(devTools, slotSource, size) : new Float32Array(size));
      }
      await devTools.evaluate(`delete ${source}`);
      return sums;
    },
    // name の和をページから消す。
    dropAccumulated: (name) => devTools.evaluate(`delete window.__ssdSums[${JSON.stringify(name)}]`),
    // accumulateMoments で積んだ name の { width, height, slots, channelSum } を受け取り、ページから消す。slots は slot 0〜
    // slotCount − 1 の { sum, squareSum }(画素ごとに成分を並べた Float64Array)で、どれも 1 回以上足してあること。
    // channelSum は成分の和の { origin, powerSums }(画素ごとに 1 つの Float64Array。powerSums は原点からのずれの 1〜
    // MOMENT_ORDER 乗の和の順)。
    async takeMoments(name, slotCount) {
      const source = `window.__ssdMoments[${JSON.stringify(name)}]`;
      const [width, height, size] = await devTools.evaluate(
        `[${source}.width, ${source}.height, ${source}.slots[0].sum.length]`);
      const slots = [];
      for (let slot = 0; slot < slotCount; slot++) {
        slots.push({
          sum: await receiveFloats(devTools, `${source}.slots[${slot}].sum`, size, Float64Array),
          squareSum: await receiveFloats(devTools, `${source}.slots[${slot}].squareSum`, size, Float64Array),
        });
      }
      const receivePlane = (expression) => receiveFloats(devTools, expression, width * height, Float64Array);
      const origin = await receivePlane(`${source}.origin`);
      const powerSums = [];
      for (let k = 0; k < MOMENT_ORDER; k++) powerSums.push(await receivePlane(`${source}.powerSums[${k}]`));
      await devTools.evaluate(`delete ${source}`);
      return { width, height, slots, channelSum: { origin, powerSums } };
    },
  };
}

// 撮った絵の PNG を線形 sRGB(画素ごとに 3 つ)へ。
export function linearOfPng(png) {
  const { channels, data } = decodePng(png);
  return linearOfSrgbCodes(data, channels, WIDTH * HEIGHT);
}

// .render-lab/ を開いた Chrome の上で work(lab) を走らせる。
export async function withLab(work) {
  const session = await openChromeSession({ serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-render-lab-ss-' });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    await waitFor(devTools,
      "(document.getElementById('error')?.textContent || typeof window.renderLab?.showShot === 'function')",
      'the render lab to initialise');
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`Render lab failed to initialise: ${failure}`);
    return await work(labOf(devTools));
  } finally {
    await session.close();
  }
}

// ---- 基準 ----

// 基準の組 name の置き場と、その中の撮影 entry のファイル suffix。撮影ごとに、近傍の半径(radius.f32)、法線と
// 深度の表示(normal.png・depth.png)、HDR・補正・拡散照度の偶数番目と奇数番目のパスの和(hdr-even.f32 など。続きを
// 足すときの正本)、全パスの HDR の平均の表示(display.f32。線形 sRGB)、作った段とパス数と露出係数と所要秒の
// 記録(json)を置く。
export const referenceDirOf = (name) => path.join(shotsDir, 'ssd-reference', name);
export const referenceFileOf = (name, entry, suffix) => path.join(referenceDirOf(name), `${entry.key}.${suffix}`);

// 浮動小数の並びを、単精度か半精度のままファイルへ書き、単精度で読む。
export const writeFloats = (file, values) => writeFileSync(file, Buffer.from(values.buffer, values.byteOffset, values.byteLength));
export const readFloats = (file) => {
  const bytes = readFileSync(file);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
};
export const writeHalfFloats = (file, values) => writeFloats(file, Float16Array.from(values));
export const readHalfFloats = (file) => {
  const bytes = readFileSync(file);
  return Float32Array.from(new Float16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)));
};

// 基準の組 name の撮影 entry の記録 { slices, steps, passes, exposure, seconds }。まだ作っていなければ null。
export function referenceMetaOf(name, entry) {
  const file = referenceFileOf(name, entry, 'json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

// referenceMetaOf の、まだ作っていなければ投げる版。
export function builtMetaOf(name, entry) {
  const meta = referenceMetaOf(name, entry);
  if (meta === null) throw new Error(`reference ${name} has no ${entry.key}`);
  return meta;
}

// 基準の組 name の撮影 entry の、kind('hdr' は HDR、'correction' は補正 ΔE、'diffuse' は拡散照度。どれも rgb)の、
// 偶数番目と奇数番目のパスの和の組 [even, odd]。
export const referenceSumsOf = (name, entry, kind) => ['even', 'odd']
  .map((half) => readFloats(referenceFileOf(name, entry, `${kind}-${half}.f32`)));

// 基準の組 name の撮影 entry へ、記録 meta と、kind ごとの偶数番目と奇数番目のパスの和の組 sums と、全パスの HDR の
// 平均の表示 display を書く。
export function writeReferencePasses(name, entry, meta, sums, display) {
  for (const [kind, halves] of Object.entries(sums)) {
    for (const [i, half] of ['even', 'odd'].entries()) writeFloats(referenceFileOf(name, entry, `${kind}-${half}.f32`), halves[i]);
  }
  writeFloats(referenceFileOf(name, entry, 'display.f32'), display);
  writeFileSync(referenceFileOf(name, entry, 'json'), JSON.stringify(meta, null, 1));
}

// 基準の組 name の撮影 entries を読む。entry.key ごとの { meta, exposedCorrection, display, diffuse, radius, normal,
// depth }。exposedCorrection は全パスの補正の平均の q(exposedCorrectionOf)、display は全パスの HDR の平均の表示、
// diffuse は全パスの拡散照度の平均(解析値と照らす撮影だけ。ほかは null)。
export function loadReference(name, entries) {
  return Object.fromEntries(entries.map((entry) => {
    const meta = builtMetaOf(name, entry);
    const normal = decodePng(readFileSync(referenceFileOf(name, entry, 'normal.png')));
    const depth = decodePng(readFileSync(referenceFileOf(name, entry, 'depth.png')));
    const meanOf = (kind) => {
      const [even, odd] = referenceSumsOf(name, entry, kind);
      return even.map((v, i) => (v + odd[i]) / meta.passes);
    };
    return [entry.key, {
      meta,
      exposedCorrection: exposedCorrectionOf(meanOf('correction'), meta.exposure),
      display: readFloats(referenceFileOf(name, entry, 'display.f32')),
      diffuse: entry.set === 'correctness' ? meanOf('diffuse') : null,
      radius: readFloats(referenceFileOf(name, entry, 'radius.f32')),
      normal: linearOfSrgbCodes(normal.data, normal.channels, WIDTH * HEIGHT),
      depth: Uint8Array.from({ length: WIDTH * HEIGHT }, (_, p) => depth.data[p * depth.channels]),
    }];
  }));
}

// 近傍の半径 radius [描画バッファの画素] から、測る画素の印(解像度 scale の走査でフェードの外にある面)。
export const maskOf = (radius, scale) => Uint8Array.from(radius, (r) => (r > FADE_OUTER_SCAN_PX / scale ? 1 : 0));

// 画素ごとに rgb を並べた values の、印 mask の立った画素での 3 成分の和の平均。
export function maskedMeanOf(values, mask) {
  let [total, count] = [0, 0];
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    total += values[3 * p] + values[3 * p + 1] + values[3 * p + 2];
    count++;
  }
  return total / count;
}

// 比の表示の色(rgb、0..1): 下がると LOWER_RATIO_COLOR、上がると HIGHER_RATIO_COLOR、同じなら SAME_RATIO_COLOR。
const LOWER_RATIO_COLOR = [0.15, 0.35, 1];
const HIGHER_RATIO_COLOR = [1, 0.2, 0.15];
const SAME_RATIO_COLOR = [0.5, 0.5, 0.5];

// 画素の値 current の、基準の値 baseline に対する比の色。log2 の比を ±octaves で端の色にする。両方が floor 以下なら
// SAME_RATIO_COLOR。
export function ratioColorOf(current, baseline, floor, octaves) {
  if (current <= floor && baseline <= floor) return SAME_RATIO_COLOR;
  const t = Math.max(-1, Math.min(1, Math.log2(current / baseline) / octaves));
  const end = t < 0 ? LOWER_RATIO_COLOR : HIGHER_RATIO_COLOR;
  return SAME_RATIO_COLOR.map((v, c) => v + Math.abs(t) * (end[c] - v));
}

// 符号つきの値の写し方: 成分ごとに 0.5 + g·v を [0, 1] へ切って符号値にする(sRGB の変換をしない。0 が 50% の灰色で、土台の
// 画像を足さない)。差分の係数 DIFFERENCE_GAIN と、補正項の係数を決める百分位と、それに係数を掛けた値の上限。
export const DIFFERENCE_GAIN = 8;
const SIGNED_GAIN_PERCENTILE = 0.995;
const SIGNED_PEAK_LIMIT = 0.45;

// 画素ごとに rgb を並べた符号つきの値 values を係数 gain で写した、画素 p の色(rgb、[0, 1] へ切る前)。
export const signedColorOf = (values, gain) => (p) => [0, 1, 2].map((c) => 0.5 + gain * values[3 * p + c]);

// 補正項を写す係数: 撮影ごとの { values, mask }(画素ごとに rgb の値と、測る画素の印)の並び fields の、印の立った画素の
// |v|(成分ごと)の SIGNED_GAIN_PERCENTILE の百分位 p について、g·p ≤ SIGNED_PEAK_LIMIT を満たす最大の 2 の冪 g。p = 0 なら 1。
export function signedGainOf(fields) {
  const magnitudes = [];
  for (const { values, mask } of fields) {
    for (let p = 0; p < mask.length; p++) {
      if (mask[p]) for (let c = 0; c < 3; c++) magnitudes.push(Math.abs(values[3 * p + c]));
    }
  }
  const sorted = Float64Array.from(magnitudes).sort();
  const peak = sorted[Math.floor(SIGNED_GAIN_PERCENTILE * (sorted.length - 1))];
  return peak > 0 ? 2 ** Math.floor(Math.log2(SIGNED_PEAK_LIMIT / peak)) : 1;
}

// ---- 解析値のある窓 ----

// bay の既定の構図の窓の中心(960×540 の画素、tools/render-lab/bay-cases.ts の注記)と、窓の半幅 [画素]。P_in は −X の
// 内隅に近い床、P_out は荷室の外の遠い床、P_glow は光る箱のそばの床、P_base は奥の壁の足元の床。
export const WINDOWS = { P_in: [412, 179], P_out: [186, 183], P_glow: [547, 225], P_base: [507, 189] };
export const WINDOW_HALF = 2;
// bay の天体照の撮影の P_in / P_out の解析値(遮蔽 / 遮蔽と照り返し)。
const ANALYTIC_RATIOS = {
  'bay-earth-overhead': [0.32, 0.49], 'bay-earth-open': [0.64, 1.06], 'bay-earth-corner': [0, 0],
  'bay-moon-open': [1.0, 1.38], 'bay-moon-corner': [0, 0],
};
// bounce-cosine の、送り手の余弦 1 / 0.5 / 0 の受け手の中心の画素(tools/render-lab/bounce-cosine-case.ts)と、
// 照り返しの比の有限の面光源での解析値。
const BOUNCE_RECEIVERS = [[284, 285], [480, 285], [676, 285]];
const ANALYTIC_BOUNCE_RATIOS = [1, 0.58, 0];

// 撮影 key の、解析値のある窓どうしの比の解析値(windowRatiosOf と同じ並び)。解析値の無い撮影は undefined。
export function analyticRatiosOf(key) {
  const [shot, suffix] = key.split('@');
  if (shot === 'bounce-cosine') return ANALYTIC_BOUNCE_RATIOS;
  return [ANALYTIC_RATIOS[shot]?.[suffix === 'occlusion' ? 0 : 1]];
}

// 拡散照度 diffuse(rgb)の、解析値のある窓どうしの輝度の比。bay は P_in / P_out、bounce-cosine は受け手ごとの
// 余弦 1 の受け手に対する比。
export function windowRatiosOf(entry, diffuse) {
  const luminanceAt = (center) => {
    const [r, g, b] = windowMean(diffuse, 3, WIDTH, center, WINDOW_HALF);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  if (entry.caseName === 'bounce-cosine') return BOUNCE_RECEIVERS.map((c) => luminanceAt(c) / luminanceAt(BOUNCE_RECEIVERS[0]));
  return [luminanceAt(WINDOWS.P_in) / luminanceAt(WINDOWS.P_out)];
}

// ---- 表 ----

// markdown の表の行。header は見出しの並び、rows は行ごとのセルの並び。
export function table(header, rows) {
  return [`| ${header.join(' | ')} |`, `|${' --- |'.repeat(header.length)}`, ...rows.map((cells) => `| ${cells.join(' | ')} |`)];
}

// 小数 digits 桁の文字列。null・undefined・NaN(測れなかった値)は —。
export const fixed = (v, digits) => (v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(digits));
