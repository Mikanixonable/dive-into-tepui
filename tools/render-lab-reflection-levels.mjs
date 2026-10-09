// 映り込みのぼけ方の表。render-lab:shot が撮った組の dir から、粗さの段のケース(tools/render-lab/reflection-cases.ts)の
// 撮影を読み、2つの表を出す。読むのは PNG だけで、ブラウザは開かない。
//
// 使い方: node tools/render-lab-reflection-levels.mjs <shots-dir>。dir は相対ならリポジトリ根から。
//
// 画素は ladder-roughness で帯へ振り分ける。
// 1. 縁の幅: 帯の中心線に沿った縦の断面で、発光球の像(ladder-reflection)と地球の像(ladder-off-specular)の縁が
//    10% から 90% の明るさへ上がるまでの px を測る。球は、同じ場所の球光源をライティングパスで照らした対照の像
//    (天体照を切った ladder-lights-no-planet-specular)の縁の幅と並べ、両方を鏡面ローブの予測幅とも並べる。
//    球の予測は、ローブの円の直径 2·d·tan(2α) を当たった点の奥行きで画面へ写した px、地球の予測は、ローブの角幅 2·2α を画素の角幅で割った px。
//    球の縁は手前側(画面の下側)で測る — 奥側は帯の奥の端が近く、ぼけた縁が帯からはみ出す。
// 2. 像の明るさ: 帯の画素の、発光球の像(ladder-reflection)の明るさの最大と和を、対照の像
//    (ladder-lights-no-planet-specular)のそれと比べる。ぼかしで明るさが失われていないかを読む。明るさの頂の行を
//    球の中心の鏡像の行と並べ、像が粗さとともに対照と同じ向きへずれるかを読む。
// 3. まだらの量: 帯の画素の明るさと、そのまわり 5×5 の平均との差の平均。発光球の像と、置換で弱めた遠方の鏡面照度
//    (ladder-specular)で測り、映り込みを切った鏡面照度(ladder-off-specular)と並べる。
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
// 鏡面ローブの半幅 [rad] の、GGX の α に対する比(src/render/pipeline/lighting/ggx.ts の LOBE_HALF_WIDTH_PER_ALPHA)。
const LOBE_HALF_WIDTH_PER_ALPHA = 2;

// 粗さのデバッグ表示から帯を決めるときの、粗さの許す差。いちばん狭い帯の間隔(0.0525 と 0.075)の半分より小さい。
const ROUGHNESS_TOLERANCE = 0.01;
// three の MeshStandardNodeMaterial が G バッファへ渡す粗さの下限(getRoughness.js)。これより滑らかな帯は、
// この粗さの面として照合し、予測する。
const MIN_ROUGHNESS = 0.0525;
const effectiveRoughness = (roughness) => Math.max(roughness, MIN_ROUGHNESS);
// 断面の 1 行として扱うのに要る、その行の帯の画素の数と、中心線の左右に平均する画素の数。
const MIN_ROW_PIXELS = 5;
const PROFILE_HALF_WIDTH = 2;
// 縁の内側の明るさの基準を探す行数の、予測幅に対する比と下限。
const EDGE_REACH_PER_WIDTH = 3;
const MIN_EDGE_REACH = 20;
// 縁の内側とみなすのに、明るさが続いていなければならない行数。
const EDGE_RUN = 8;
// まだらの量で、画素と比べる平均を取る正方形の半径 [px](5×5)。
const MOTTLE_RADIUS = 2;

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

// 表 1: 帯ごとの縁の幅と、対照の球光源の縁の幅・予測幅。
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

// 撮影 shot の帯ごとの、画素の明るさの最大と和。
function bandBrightness(bands, shot) {
  const rows = ROUGHNESSES.map(() => ({ peak: 0, sum: 0 }));
  for (let y = 0; y < shot.height; y++) {
    for (let x = 0; x < shot.width; x++) {
      const band = bands[y * shot.width + x];
      if (band < 0) continue;
      const luminance = tonemappedLuminance(shot.at(x, y));
      rows[band].peak = Math.max(rows[band].peak, luminance);
      rows[band].sum += luminance;
    }
  }
  return rows;
}

// 帯 band の中心線の上で、発光球の中心の鏡像が写る画面の行。
function mirrorRow(band) {
  const azimuth = (band - (ROUGHNESSES.length - 1) / 2) * BAND_SPACING_DEG * Math.PI / 180;
  const pitch = CAMERA_PITCH_DEG * Math.PI / 180;
  const forward = SPHERE_DISTANCE * Math.cos(azimuth);
  const below = -SPHERE_HEIGHT - CAMERA_HEIGHT;
  const depth = forward * Math.cos(pitch) - below * Math.sin(pitch);
  const up = below * Math.cos(pitch) + forward * Math.sin(pitch);
  return VIEW_HEIGHT / 2 - FOCAL * up / depth;
}

// 断面 profile を縦に幅 width 行の箱で均してから、いちばん明るい行。断面の端では、断面の中にある行だけで均す。
function peakRow(profile, width) {
  const half = Math.floor(Math.max(1, width) / 2);
  let best = null;
  for (let i = 0; i < profile.length; i++) {
    let total = 0;
    let count = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(profile.length - 1, i + half); k++) {
      total += profile[k].value;
      count++;
    }
    const value = total / count;
    if (value > 0 && (best === null || value > best.value)) best = { y: profile[i].y, value };
  }
  return best?.y ?? null;
}

// 表 2: 帯ごとの、発光球の像の明るさの最大と和の、対照の像に対する比と、明るさの頂の行。頂の行は、断面を予測幅の
// 1/4 の箱で均してから取り、球の中心の鏡像の行と並べる。
function brightnessTable(bands, sphereShot, lightShot) {
  const { width, height } = sphereShot;
  const sphere = bandBrightness(bands, sphereShot);
  const light = bandBrightness(bands, lightShot);
  const ratio = (measured, reference) => (reference <= 0 ? '-' : (measured / reference).toFixed(2));
  const row = (v) => (v === null ? '-' : String(v));
  const header = ['帯', '粗さ', '頂 球 / 球光源', '和 球 / 球光源', '頂の行 球', '頂の行 球光源', '鏡像の中心の行'];
  const lines = [header, header.map(() => '---')];
  for (const [index, roughness] of ROUGHNESSES.entries()) {
    const box = predictedSphereWidth(index, effectiveRoughness(roughness) ** 2) / 4;
    const peak = (shot) => peakRow(
      bandProfile(bands, width, height, index, (x, y) => tonemappedLuminance(shot.at(x, y))), box);
    lines.push([
      index, roughness, ratio(sphere[index].peak, light[index].peak), ratio(sphere[index].sum, light[index].sum),
      row(peak(sphereShot)), row(peak(lightShot)), mirrorRow(index).toFixed(1),
    ]);
  }
  return lines.map((cells) => `| ${cells.join(' | ')} |`).join('\n');
}

// 撮影 shot の帯ごとの、まだらの量 — 帯の画素の明るさと、そのまわり 5×5 の同じ帯の画素の平均との差の平均。帯の
// 画素の明るさの平均も返す。
function bandMottle(bands, shot) {
  const { width, height } = shot;
  const luminance = new Float64Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) luminance[y * width + x] = tonemappedLuminance(shot.at(x, y));
  const rows = ROUGHNESSES.map(() => ({ difference: 0, value: 0, count: 0 }));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const band = bands[y * width + x];
      if (band < 0) continue;
      let total = 0;
      let count = 0;
      for (let dy = -MOTTLE_RADIUS; dy <= MOTTLE_RADIUS; dy++) {
        for (let dx = -MOTTLE_RADIUS; dx <= MOTTLE_RADIUS; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height || bands[ny * width + nx] !== band) continue;
          total += luminance[ny * width + nx];
          count++;
        }
      }
      const value = luminance[y * width + x];
      rows[band].difference += Math.abs(value - total / count);
      rows[band].value += value;
      rows[band].count++;
    }
  }
  return rows.map(({ difference, value, count }) => ({
    mottle: count === 0 ? 0 : difference / count, mean: count === 0 ? 0 : value / count,
  }));
}

// 表 3: 帯ごとのまだらの量。発光球の像(ladder-reflection)と、置換で弱めた遠方の鏡面照度(ladder-specular)を、
// 映り込みを切った鏡面照度(ladder-off-specular — 地球の像の模様だけを持つ)と並べる。比は帯の画素の明るさの平均に
// 対する割合。
function mottleTable(bands, sphereShot, specularShot, offSpecularShot) {
  const sphere = bandMottle(bands, sphereShot);
  const specular = bandMottle(bands, specularShot);
  const offSpecular = bandMottle(bands, offSpecularShot);
  const format = (v) => v.toExponential(2);
  const relative = ({ mottle, mean }) => (mean <= 0 ? '-' : (mottle / mean).toFixed(3));
  const header = [
    '帯', '粗さ', '球 まだら', '球 まだら / 平均', '鏡面照度 まだら', '鏡面照度 まだら / 平均', 'オフ まだら', 'オフ まだら / 平均',
  ];
  const lines = [header, header.map(() => '---')];
  for (const [index, roughness] of ROUGHNESSES.entries()) {
    lines.push([
      index, roughness, format(sphere[index].mottle), relative(sphere[index]),
      format(specular[index].mottle), relative(specular[index]),
      format(offSpecular[index].mottle), relative(offSpecular[index]),
    ]);
  }
  return lines.map((cells) => `| ${cells.join(' | ')} |`).join('\n');
}

function main() {
  const [dirArg] = process.argv.slice(2);
  if (dirArg === undefined) throw new Error(USAGE);
  const dir = path.resolve(root, dirArg);
  const bands = bandMap(readShot(dir, 'ladder-roughness'));
  const sphereShot = readShot(dir, 'ladder-reflection');
  const lightShot = readShot(dir, 'ladder-lights-no-planet-specular');
  console.log('縁の幅 [px](10% → 90%)\n');
  console.log(edgeTable(bands, sphereShot, lightShot, readShot(dir, 'ladder-off-specular')));
  console.log('\n像の明るさ(トーンマッピングを戻した輝度)\n');
  console.log(brightnessTable(bands, sphereShot, lightShot));
  console.log('\nまだらの量(トーンマッピングを戻した輝度)\n');
  console.log(mottleTable(
    bands, sphereShot, readShot(dir, 'ladder-specular'), readShot(dir, 'ladder-off-specular')));
}

main();
