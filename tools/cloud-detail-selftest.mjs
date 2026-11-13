// cloud-detail-metrics の自己検査。傾き β が既知の合成場(乱相位の FFT 合成)と
// 帯域の限られたノイズ場へ物差しを当て、傾きを ±0.1 で取り戻すこと、周期性の指標が
// 1 オクターブの場でだけ閾値を超えることを判定する。続けて .cloud-detail/reference/ の
// 実写へ塊の寸法分布の冪 b と周長–面積の D を当て、文献値の検算をする(無ければその節は飛ばす)。
// 使い方: node tools/cloud-detail-selftest.mjs — 判定に 1 つでも失敗すれば非 0 で終わる。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fft2, measureCloudDetail } from './cloud-detail-metrics.mjs';
import { decodePng } from './png.mjs';

const root = path.resolve(import.meta.dirname, '..');

// 合成場の一辺 [px] と 1 画素が張る距離 [km]。512² × 1 km/px は実写の 1 km/px の段と同じ設定。
const FIELD_N = 512;
const FIELD_KM_PER_PX = 1;

// 傾きの取り戻しの許容幅(達成目標)。
const SLOPE_TOLERANCE = 0.1;
// 周期性の指標(全オクターブへ当てた冪乗則からの最大の超過比)の閾値。冪乗則の場では
// 実測で 1.3 程度まで、1 オクターブの場では 10 を超えるので、その中間へ置く。
const PERIODICITY_THRESHOLD = 3;
// 周期性の検査に使う帯域ノイズのオクターブ(波数 k0..2k0−1 [cycle/面])。
const BAND_K0 = 32;

// 文献の検算の幅: b は Wood & Field 2011 の 1.66 ± 0.3、D は Lovejoy 1982 の 1.35 ± 0.1。
const B_TARGET = 1.66;
const B_TOLERANCE = 0.3;
const D_TARGET = 1.35;
const D_TOLERANCE = 0.1;

// 再現性のある乱数。
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 動径スペクトルが ampOf(k) に比例する乱相位の場を FFT 合成する。実数場になるよう
// F(−k) = conj(F(k)) を課す。ampOf は 2 次元スペクトルの振幅 — 1 次元波数スペクトルが
// k^−β の場を作るには k^−(β+1)/2 を渡す(動径積分 E(k) = 2πk・|F|² で β が出るため)。
function syntheticField(n, ampOf, seed) {
  const re = new Float64Array(n * n);
  const im = new Float64Array(n * n);
  const rand = mulberry32(seed);
  const half = n / 2;
  for (let ky = 0; ky < n; ky++) {
    const fy = ky <= half ? ky : ky - n;
    for (let kx = 0; kx < n; kx++) {
      const fx = kx <= half ? kx : kx - n;
      // 上半面(負の周波数は共役で埋まる)だけ乱相位を振る。
      if (!(fy > 0 || (fy === 0 && fx > 0))) continue;
      const k = Math.hypot(fx, fy);
      const amp = k < 1 || k > half ? 0 : ampOf(k);
      if (amp === 0) continue;
      const phase = rand() * 2 * Math.PI;
      const i = ky * n + kx;
      const j = ((n - ky) % n) * n + ((n - kx) % n);
      re[i] = amp * Math.cos(phase);
      im[i] = amp * Math.sin(phase);
      re[j] = re[i];
      im[j] = -im[i];
    }
  }
  fft2(re, im, n, true);
  // 標準偏差 1 に正規化(量の絶対値は物差しの対象外、分布の形だけが効く)。
  let mean = 0;
  for (const v of re) mean += v;
  mean /= re.length;
  let variance = 0;
  for (const v of re) variance += (v - mean) * (v - mean);
  const scale = 1 / Math.sqrt(variance / re.length);
  const data = new Float32Array(n * n);
  for (let i = 0; i < re.length; i++) data[i] = (re[i] - mean) * scale;
  return { width: n, height: n, data };
}

// sRGB の 1 チャンネル(0..255)を線形輝度(0..1)へ戻す。
function srgbToLinear(byte) {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// PNG を線形輝度の場へ。Rec.601 ではなく Rec.709 の輝度係数 — 実写の真色画像の
// モニタ輝度として読むため。
function linearLuminanceField(png) {
  const { width, height, channels, data } = decodePng(png);
  const out = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    if (channels === 1) {
      out[i] = srgbToLinear(data[i]);
    } else {
      const r = srgbToLinear(data[i * channels]);
      const g = srgbToLinear(data[i * channels + 1]);
      const b = srgbToLinear(data[i * channels + 2]);
      out[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
  }
  return { width, height, data: out };
}

// manifest.json から { file, kmPerPx, label } の一覧を取り出す。段の km/px が
// 画像の項目に無いときは manifest 側の表(段名 → km/px)かファイル名の末尾
// (…-0.25.png / …-0p25.png)から拾う。
function collectReferenceImages(manifest) {
  const found = [];
  const stageKm = manifest.kmPerPx ?? manifest.kmPerPxByStage ?? null;
  const visit = (node, inherited) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, inherited);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const label = node.name ?? node.scene ?? node.label ?? inherited.label;
    let kmPerPx = node.kmPerPx ?? node.kmperpx ?? node.km_per_px ?? inherited.kmPerPx;
    const file = node.file ?? node.path ?? node.image;
    if (typeof file === 'string' && file.endsWith('.png')) {
      if (kmPerPx === undefined) {
        const stage = file.replace(/\.png$/, '').split('-').pop();
        kmPerPx = (stageKm && stageKm[stage]) ?? Number.parseFloat(stage.replace('p', '.'));
      }
      if (typeof kmPerPx === 'number' && kmPerPx > 0) {
        found.push({ file, kmPerPx, label: label ?? file });
      }
      return;
    }
    for (const key of ['images', 'entries', 'files', 'stages', 'tiers', 'shots', 'scenes']) {
      if (node[key] !== undefined) visit(node[key], { kmPerPx, label });
    }
  };
  visit(manifest, {});
  return found;
}

let failures = 0;
const judge = (ok, label, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(28)}  ${detail}`);
};

console.log('=== 傾き β の取り戻し(乱相位の合成場 512² × 1 km/px) ===');
console.log('β(真値)  β(計測)   誤差');
for (const beta of [1.2, 5 / 3, 2.5]) {
  const field = syntheticField(FIELD_N, (k) => Math.pow(k, -(beta + 1) / 2), 1000 + Math.round(beta * 100));
  const measured = measureCloudDetail(field, FIELD_KM_PER_PX).spectrum.beta;
  const error = measured - beta;
  judge(Math.abs(error) <= SLOPE_TOLERANCE, `傾き β = ${beta.toFixed(3)}`,
    `${beta.toFixed(3)}  ${measured.toFixed(3)}  ${error >= 0 ? '+' : ''}${error.toFixed(3)}`);
}

console.log('\n=== 周期性の指標(冪乗則からの最大の超過比、閾値 ' + PERIODICITY_THRESHOLD + ') ===');
const bandField = syntheticField(FIELD_N, (k) => (k >= BAND_K0 && k < 2 * BAND_K0 ? 1 : 0), 7);
const bandRatio = measureCloudDetail(bandField, FIELD_KM_PER_PX).periodicity.maxExcessRatio;
judge(bandRatio > PERIODICITY_THRESHOLD, `1 オクターブ(k=${BAND_K0}..${2 * BAND_K0 - 1})`,
  `超過比 ${bandRatio.toFixed(2)} > ${PERIODICITY_THRESHOLD}`);
const powerLawField = syntheticField(FIELD_N, (k) => Math.pow(k, -(5 / 3 + 1) / 2), 8);
const powerLawRatio = measureCloudDetail(powerLawField, FIELD_KM_PER_PX).periodicity.maxExcessRatio;
judge(powerLawRatio <= PERIODICITY_THRESHOLD, '多オクターブ(β = 5/3)',
  `超過比 ${powerLawRatio.toFixed(2)} <= ${PERIODICITY_THRESHOLD}`);

console.log('\n=== 実写の検算(b = 1.66 ± 0.3、D = 1.35 ± 0.1) ===');
// 実写の節は判定を表に出すだけで終了コードへは入れない — 幅外が出たときに物差しと
// 場面のどちらを見直すかは計画側の判断で、ここでは事実を並べるに留める。
const manifestFile = path.join(root, '.cloud-detail', 'reference', 'manifest.json');
if (!existsSync(manifestFile)) {
  console.log('.cloud-detail/reference/manifest.json が無いのでこの節は飛ばす');
} else {
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const images = collectReferenceImages(manifest);
  if (images.length === 0) {
    console.log('manifest.json に画像が 1 枚も無い');
  }
  let inB = 0;
  let inD = 0;
  console.log('画像  km/px  塊の数(内側)  b      D      判定');
  for (const image of images) {
    // file はリポジトリのルートからの相対。ベース名だけの場合は reference/ の中と見なす。
    const file = image.file.includes('/') ? path.join(root, image.file)
      : path.join(root, '.cloud-detail', 'reference', image.file);
    const png = readFileSync(file);
    const measured = measureCloudDetail(linearLuminanceField(png), image.kmPerPx);
    const { sizeExponent, perimeterAreaDimension, count, interiorCount } = measured.shapes;
    const okB = sizeExponent !== null && Math.abs(sizeExponent - B_TARGET) <= B_TOLERANCE;
    const okD = perimeterAreaDimension !== null
      && Math.abs(perimeterAreaDimension - D_TARGET) <= D_TOLERANCE;
    inB += okB ? 1 : 0;
    inD += okD ? 1 : 0;
    console.log(`${image.label.padEnd(30)}  ${image.kmPerPx}  ${count}(${interiorCount})  `
      + `${sizeExponent === null ? '  n/a' : sizeExponent.toFixed(2)}  `
      + `${perimeterAreaDimension === null ? '  n/a' : perimeterAreaDimension.toFixed(2)}  `
      + `b${okB ? '○' : '×'} D${okD ? '○' : '×'}`);
  }
  if (images.length > 0) {
    console.log(`文献の幅に入った画像: b ${inB}/${images.length}、D ${inD}/${images.length}`);
  }
}

console.log(failures === 0 ? '\n合成場の判定はすべて通った' : `\n${failures} 件の失敗`);
process.exit(failures === 0 ? 0 : 1);
