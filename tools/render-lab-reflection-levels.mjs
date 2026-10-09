// 映り込みのぼけ方の表。render-lab:shot が撮った組の dir から、粗さの段のケース(tools/render-lab/reflection-cases.ts)の
// 撮影を読み、2つの表を出す。読むのは PNG だけで、ブラウザは開かない。
//
// 使い方: node tools/render-lab-reflection-levels.mjs <shots-dir>。dir は相対ならリポジトリ根から。
//
// 1. 帯 × 縮小段: ladder-roughness で画素を帯へ振り分け、ladder-level を段へ戻して、置換の重みが正の画素を段ごとに
//    数える。「張り付き」は縮小列のいちばん粗い段に張り付いた画素の、重みが正の画素に対する割合。
// 2. 縁の幅: 帯の中心線に沿った縦の断面で、発光球の像(ladder-reflection)と地球の像(ladder-off-specular)の縁が
//    10% から 90% の明るさへ上がるまでの px を測る。球は、同じ場所の球光源をライティングパスで照らした対照の像
//    (天体照を切った ladder-lights-no-planet-specular)の縁の幅と並べ、両方を鏡面ローブの予測幅とも並べる。
//    球の予測は、ローブの円の直径 2·d·tan(2α) を当たった点の奥行きで画面へ写した px、地球の予測は、ローブの角幅 2·2α を画素の角幅で割った px。
//    球の縁は手前側(画面の下側)で測る — 奥側は帯の奥の端が近く、ぼけた縁が帯からはみ出す。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng } from './png.mjs';

const root = path.resolve(import.meta.dirname, '..');
const USAGE = 'usage: node tools/render-lab-reflection-levels.mjs <shots-dir>';

// ケースの配置(tools/render-lab/reflection-cases.ts と同じ値)。長さは m、角度は deg。
const ROUGHNESSES = [0.05, 0.075, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6];
const CAMERA_HEIGHT = 2;
const CAMERA_PITCH_DEG = 10;
const BAND_SPACING_DEG = 6.6;
const SPHERE_DISTANCE = 24;
const SPHERE_HEIGHT = 2;
const SPHERE_RADIUS = 0.4;
// 描画の大きさと縦の画角(tools/render-lab/lab-case.ts)。
const VIEW_HEIGHT = 540;
const FOV_DEG = 50;
// 縮小列の段数は src の定数から読む。縮小段のデバッグ表示は、段 + 1 を段数で割った灰(src/render/pipeline/render-pipeline.ts)。
const LEVEL_COUNT = (() => {
  const source = readFileSync(path.join(root, 'src/render/pipeline/reflection-pass.ts'), 'utf8');
  const match = /^export const REFLECTION_LEVEL_COUNT = (\d+);/m.exec(source);
  if (match === null) throw new Error('REFLECTION_LEVEL_COUNT not found in reflection-pass.ts');
  return Number(match[1]);
})();
// 鏡面ローブの半幅 [rad] の、GGX の α に対する比(src/render/pipeline/lighting/ggx.ts の LOBE_HALF_WIDTH_PER_ALPHA)。
const LOBE_HALF_WIDTH_PER_ALPHA = 2;

// 粗さのデバッグ表示から帯を決めるときの、粗さの許す差。いちばん狭い帯の間隔(0.0525 と 0.075)の半分より小さい。
const ROUGHNESS_TOLERANCE = 0.01;
// three の MeshStandardNodeMaterial が G バッファへ渡す粗さの下限(getRoughness.js)。これより滑らかな帯は、
// この粗さの面として照合し、予測する。
const MIN_ROUGHNESS = 0.0525;
const effectiveRoughness = (roughness) => Math.max(roughness, MIN_ROUGHNESS);
// いちばん粗い段に張り付いたとみなす、段の端からの差。8bit の灰の白の側の刻み(段数 13 で段約 0.12)を覆う。
const STUCK_MARGIN = 0.15;
// 断面の 1 行として扱うのに要る、その行の帯の画素の数と、中心線の左右に平均する画素の数。
const MIN_ROW_PIXELS = 5;
const PROFILE_HALF_WIDTH = 2;
// 縁の内側の明るさの基準を探す行数の、予測幅に対する比と下限。
const EDGE_REACH_PER_WIDTH = 3;
const MIN_EDGE_REACH = 20;
// 縁の内側とみなすのに、明るさが続いていなければならない行数。
const EDGE_RUN = 8;

// 画素の焦点距離 [px]。
const FOCAL = VIEW_HEIGHT / 2 / Math.tan((FOV_DEG / 2) * Math.PI / 180);

// sRGB で符号化した 0..1 の値の線形の値。
const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

// PBR Neutral(three の neutralToneMapping)の順写像。
function neutral(c) {
  const x = Math.min(c[0], c[1], c[2]);
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  const shifted = c.map((v) => v - offset);
  const peak = Math.max(...shifted);
  if (peak < 0.76) return shifted;
  const d = 0.24;
  const newPeak = 1 - (d * d) / (peak + d - 0.76);
  const g = 1 - 1 / (0.15 * (peak - newPeak) + 1);
  return shifted.map((v) => v * (newPeak / peak) * (1 - g) + newPeak * g);
}

// PBR Neutral の逆写像。圧縮の掛からない範囲は閉じた式で、掛かる範囲は順写像を繰り返し当てて解く。
function inverseNeutral(t) {
  if (Math.max(...t) < 0.76) {
    const low = Math.min(...t);
    const x = low < 0.04 ? 0.4 * Math.sqrt(low) : low + 0.04;
    return t.map((v) => v + x - low);
  }
  let c = [...t];
  for (let i = 0; i < 100; i++) {
    const f = neutral(c);
    c = c.map((v, k) => v + (t[k] - f[k]));
  }
  return c;
}

// 撮影 name の PNG を { width, height, at(x, y) → [r, g, b](0..255) } へ。
function readShot(dir, name) {
  const { width, height, channels, data } = decodePng(readFileSync(path.join(dir, `${name}.png`)));
  return {
    width,
    height,
    at: (x, y) => {
      const p = (y * width + x) * channels;
      return [data[p], data[p + 1], data[p + 2]];
    },
  };
}

// トーンマッピングして出す表示の画素の値の、線形の輝度。
function tonemappedLuminance(code) {
  const [r, g, b] = inverseNeutral(code.map((v) => srgbToLinear(v / 255)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// 粗さのデバッグ表示から、画素ごとの帯の番号(帯の外は −1)。
function bandMap(shot) {
  const bands = new Int8Array(shot.width * shot.height).fill(-1);
  for (let y = 0; y < shot.height; y++) {
    for (let x = 0; x < shot.width; x++) {
      const roughness = srgbToLinear(shot.at(x, y)[0] / 255);
      let best = -1;
      for (const [index, value] of ROUGHNESSES.entries()) {
        if (Math.abs(roughness - effectiveRoughness(value)) <= ROUGHNESS_TOLERANCE) best = index;
      }
      bands[y * shot.width + x] = best;
    }
  }
  return bands;
}

// 縮小段のデバッグ表示の画素の段。置換の重みが 0 の画素(青)と像を書いていない画素(黒)は null。
function levelOf([r, g, b]) {
  if (b > 128 && r < 64 && g < 64) return null;
  if (r === 0 && g === 0 && b === 0) return null;
  return srgbToLinear(r / 255) * LEVEL_COUNT - 1;
}

// 表 1: 帯 × 縮小段の画素数。
function levelTable(bands, levelShot) {
  const top = LEVEL_COUNT - 1;
  const rows = ROUGHNESSES.map(() => ({ weighted: 0, bins: new Array(top).fill(0), stuck: 0 }));
  for (let y = 0; y < levelShot.height; y++) {
    for (let x = 0; x < levelShot.width; x++) {
      const band = bands[y * levelShot.width + x];
      if (band < 0) continue;
      const level = levelOf(levelShot.at(x, y));
      if (level === null) continue;
      const row = rows[band];
      row.weighted++;
      if (level >= top - STUCK_MARGIN) row.stuck++;
      else row.bins[Math.min(Math.max(Math.floor(level), 0), top - 1)]++;
    }
  }
  const header = ['帯', '粗さ', 'w>0', ...Array.from({ length: top }, (_, k) => `段${k}〜${k + 1}`), `段${top}張り付き`, '張り付き%'];
  const lines = [header, header.map(() => '---')];
  for (const [index, row] of rows.entries()) {
    const share = row.weighted === 0 ? '-' : (100 * row.stuck / row.weighted).toFixed(1);
    lines.push([index, ROUGHNESSES[index], row.weighted, ...row.bins, row.stuck, share]);
  }
  return lines.map((cells) => `| ${cells.join(' | ')} |`).join('\n');
}

// 帯 band の中心線に沿った縦の断面。value(x, y) を中心線の左右 PROFILE_HALF_WIDTH 画素で平均し、上の行から並べる。
function bandProfile(bands, width, height, band, value) {
  const profile = [];
  for (let y = 0; y < height; y++) {
    // 帯はその行でいちばん長く続く区間。粗さが偶然近い離れた画素を数えない。
    let bestStart = 0;
    let bestLength = 0;
    for (let x = 0, start = 0; x <= width; x++) {
      if (x < width && bands[y * width + x] === band) continue;
      if (x - start > bestLength) {
        bestStart = start;
        bestLength = x - start;
      }
      start = x + 1;
    }
    if (bestLength < MIN_ROW_PIXELS) continue;
    const center = bestStart + Math.floor(bestLength / 2);
    let total = 0;
    for (let dx = -PROFILE_HALF_WIDTH; dx <= PROFILE_HALF_WIDTH; dx++) total += value(center + dx, y);
    profile.push({ y, value: total / (2 * PROFILE_HALF_WIDTH + 1) });
  }
  return profile;
}

// 断面 profile を添字 from から step(±1)の向きへ進み、値が threshold を下回る位置(行、端数は線形補間)。
function crossing(profile, from, step, threshold) {
  for (let i = from; i + step >= 0 && i + step < profile.length; i += step) {
    const a = profile[i];
    const b = profile[i + step];
    if (b.value < threshold) return a.y + (b.y - a.y) * (a.value - threshold) / (a.value - b.value);
  }
  return null;
}

// 断面 profile の添字 from から to まで(to は含まない)でいちばん明るい添字。
function brightestIndex(profile, from, to) {
  let peak = from;
  for (let i = from + 1; i < to; i++) if (profile[i].value > profile[peak].value) peak = i;
  return peak;
}

// 断面 profile の縁の幅 [px]。縁の内側の明るさの基準から step の向きへ、明るさが基準の 90% と 10% を下回るまでの幅。
// 基準は、断面の外側の端から内側へ向かって初めて断面全体の最大の 10% 以上が EDGE_RUN 行続く位置から、内側へ
// reach 行までの最大 — 像の中の明るさがまちまちでも縁のすぐ内側の明るさで測り、帯の端の数行の照り返しは縁と
// みなさない。
function edgeWidth(profile, step, reach) {
  if (profile.length === 0) return null;
  const max = profile[brightestIndex(profile, 0, profile.length)].value;
  if (max <= 0) return null;
  const lit = (i) => profile[i] !== undefined && profile[i].value >= 0.1 * max;
  const sustained = (i) => Array.from({ length: EDGE_RUN }, (_, k) => i - step * k).every(lit);
  let edge = step > 0 ? profile.length - 1 : 0;
  while (profile[edge] !== undefined && !sustained(edge)) edge -= step;
  if (profile[edge] === undefined) return null;
  const inner = Math.min(Math.max(edge - step * reach, 0), profile.length - 1);
  const peak = brightestIndex(profile, Math.min(edge, inner), Math.max(edge, inner) + 1);
  const reference = profile[peak].value;
  const high = crossing(profile, peak, step, 0.9 * reference);
  const low = crossing(profile, peak, step, 0.1 * reference);
  return high === null || low === null ? null : Math.abs(low - high);
}

// 帯 band の発光球の像の縁の予測幅 [px]。帯の中心線の上で、発光球の中心へ鏡の向きで届く床の点から、当たった点
// (球の手前の面)までの距離 d を、当たった点の奥行きで画面へ写す。ローブの半幅が 90° に届く粗さでは円が閉じない
// ので Infinity。
function predictedSphereWidth(band, alpha) {
  if (LOBE_HALF_WIDTH_PER_ALPHA * alpha >= Math.PI / 2) return Infinity;
  const reflectionAt = CAMERA_HEIGHT * SPHERE_DISTANCE / (CAMERA_HEIGHT + SPHERE_HEIGHT);
  const toCenter = Math.hypot(SPHERE_DISTANCE - reflectionAt, SPHERE_HEIGHT);
  const distance = toCenter - SPHERE_RADIUS;
  const hitAlong = reflectionAt + (SPHERE_DISTANCE - reflectionAt) * distance / toCenter;
  const hitHeight = SPHERE_HEIGHT * distance / toCenter;
  const azimuth = (band - (ROUGHNESSES.length - 1) / 2) * BAND_SPACING_DEG * Math.PI / 180;
  const pitch = CAMERA_PITCH_DEG * Math.PI / 180;
  const depth = hitAlong * Math.cos(azimuth) * Math.cos(pitch) - (hitHeight - CAMERA_HEIGHT) * Math.sin(pitch);
  return 2 * distance * Math.tan(LOBE_HALF_WIDTH_PER_ALPHA * alpha) * FOCAL / depth;
}

// 地球の像の縁の予測幅 [px]。
function predictedEarthWidth(alpha) {
  return 2 * LOBE_HALF_WIDTH_PER_ALPHA * alpha * FOCAL;
}

// 表 2: 帯ごとの縁の幅と、対照の球光源の縁の幅・予測幅。
function edgeTable(bands, sphereShot, lightShot, earthShot) {
  const { width, height } = sphereShot;
  const sphere = (x, y) => tonemappedLuminance(sphereShot.at(x, y));
  const light = (x, y) => tonemappedLuminance(lightShot.at(x, y));
  const earth = (x, y) => tonemappedLuminance(earthShot.at(x, y));
  const format = (v) => (v === null || !Number.isFinite(v) ? '-' : v.toFixed(1));
  const ratio = (measured, reference) => (
    measured === null || reference === null || !Number.isFinite(reference) || reference <= 0
      ? '-' : (measured / reference).toFixed(2)
  );
  const header = [
    '帯', '粗さ', '球 実測', '球光源 実測', '球 / 球光源', '球 予測', '球 / 予測', '地球 実測', '地球 予測', '地球 比',
  ];
  const lines = [header, header.map(() => '---')];
  for (const [index, roughness] of ROUGHNESSES.entries()) {
    const alpha = effectiveRoughness(roughness) ** 2;
    const sphereExpected = predictedSphereWidth(index, alpha);
    const earthExpected = predictedEarthWidth(alpha);
    const reach = (expected) => Math.max(MIN_EDGE_REACH, Math.ceil(EDGE_REACH_PER_WIDTH * expected));
    // 球の像の手前の縁は画面の下へ、地球の像の縁は地球の内側(下)から上へ向かって暗くなる。
    const sphereWidth = edgeWidth(bandProfile(bands, width, height, index, sphere), 1, reach(sphereExpected));
    const lightWidth = edgeWidth(bandProfile(bands, width, height, index, light), 1, reach(sphereExpected));
    // 地球の像は帯の手前の端まで続くので、予測幅が断面の半分を超える粗さでは縁が断面に収まらず、測らない。
    const earthProfile = bandProfile(bands, width, height, index, earth);
    const earthWidth = earthExpected > earthProfile.length / 2 ? null : edgeWidth(earthProfile, -1, reach(earthExpected));
    lines.push([
      index, roughness,
      format(sphereWidth), format(lightWidth), ratio(sphereWidth, lightWidth),
      format(sphereExpected), ratio(sphereWidth, sphereExpected),
      format(earthWidth), format(earthExpected), ratio(earthWidth, earthExpected),
    ]);
  }
  return lines.map((cells) => `| ${cells.join(' | ')} |`).join('\n');
}

function main() {
  const [dirArg] = process.argv.slice(2);
  if (dirArg === undefined) throw new Error(USAGE);
  const dir = path.resolve(root, dirArg);
  const roughnessShot = readShot(dir, 'ladder-roughness');
  const bands = bandMap(roughnessShot);
  console.log(`縮小列の段数 ${LEVEL_COUNT}(段 0〜${LEVEL_COUNT - 1})\n`);
  console.log('帯 × 縮小段(置換の重みが正の画素)\n');
  console.log(levelTable(bands, readShot(dir, 'ladder-level')));
  console.log('\n縁の幅 [px](10% → 90%)\n');
  console.log(edgeTable(
    bands,
    readShot(dir, 'ladder-reflection'),
    readShot(dir, 'ladder-lights-no-planet-specular'),
    readShot(dir, 'ladder-off-specular'),
  ));
}

main();
