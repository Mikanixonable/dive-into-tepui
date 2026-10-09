// 映り込みのぼけ方の表。render-lab:shot が撮った組の dir から、粗さの段のケース(tools/render-lab/reflection-cases.ts)の
// 撮影を読み、5つの表を出す。読むのは PNG だけで、ブラウザは開かない。
//
// 使い方: node tools/render-lab-reflection-levels.mjs <shots-dir>。dir は相対ならリポジトリ根から。
//
// 画素は ladder-roughness で帯へ振り分ける。真値は、画素に写る床の点で F0 = 1 の GGX の鏡面を近似を使わずに数値
// 積分した値。
// 1. 縁の幅: 帯の中心線に沿った縦の断面で、発光球の像(ladder-reflection)と地球の像(ladder-off-specular)の縁が
//    10% から 90% の明るさへ上がるまでの px を測る。球は、同じ場所の球光源をライティングパスで照らした対照の像
//    (天体照を切った ladder-lights-no-planet-specular)の縁の幅と並べ、両方を鏡面ローブの予測幅とも並べる。
//    球の予測は、ローブの円の直径 2·d·tan(2α) を当たった点の奥行きで画面へ写した px、地球の予測は、ローブの角幅 2·2α を画素の角幅で割った px。
//    球の縁は手前側(画面の下側)で測る — 奥側は帯の奥の端が近く、ぼけた縁が帯からはみ出す。
// 2. 像の明るさ: 帯の画素の、発光球の像(ladder-reflection)の明るさの最大と和を、対照の像
//    (ladder-lights-no-planet-specular)のそれと比べる。ぼかしで明るさが失われていないかを読む。明るさの頂の行を
//    球の中心の鏡像の行と発光球の真値の頂の行と並べ、像が粗さとともに対照・真値と同じ向きへずれるかを読む。発光球の
//    像(w·I)も対照(鏡面照度)も反射率 R を掛ける前の値なので、比は R によらない。
// 3. まだらの量: 帯の画素の値と、そのまわり 5×5 の平均との差の平均。発光球の像と、置換の重み w(ladder-weight)で
//    測る。
// 4. チェッカーの縁の幅: チェッカーの発光板の像(ladder-checker-reflection)の、横の境(上下のマスの間)と縦の境(左右の
//    マスの間)の縁が 90% から 10% の明るさへ下がるまでの px を、同じ断面の真値と並べる。横の境は左下のマスの像の
//    中心を通る縦の断面で、縦の境は下のマスの像の中心を通る横の断面で測る。撮影の無い組では飛ばす。
// 5. 像から遠い輝点: 発光球の真値の像が読める明るさを持たない行 — その行の帯の画素の真値の最大が、帯の真値の頂の
//    0.1% に満たない行 — にある帯の画素のうち、発光球の像(ladder-reflection)の明るさが帯の対照の像
//    (ladder-lights-no-planet-specular)の頂の 10% 以上の画素の数。鏡面ローブの裾の標本が像から遠くに落とす疎らな
//    輝点を読む。読める行を真値で決めるのは、8bit の対照の撮影では頂の 0.1% の明るさが 0 に丸まるため。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng } from './png.mjs';

const root = path.resolve(import.meta.dirname, '..');
const USAGE = 'usage: node tools/render-lab-reflection-levels.mjs <shots-dir>';

// ケースの配置(tools/render-lab/reflection-cases.ts と同じ値)。長さは m、角度は deg。
const ROUGHNESSES = [0.05, 0.075, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6];
const CAMERA_HEIGHT = 2;
const CAMERA_PITCH_DEG = 10;
const BAND_OUTER_RADIUS = 24;
const BAND_SPACING_DEG = 6.6;
const BAND_WIDTH_DEG = 5.6;
const SPHERE_HEIGHT = 2;
const SPHERE_RADIUS = 0.4;
// 発光球とチェッカーの発光するマスの放射輝度と、チェッカーの発光板の幅(帯の奥の端での帯の幅の弦)と高さ。
const EMITTER_RADIANCE = 0.5;
const PLATE_WIDTH = 2 * BAND_OUTER_RADIUS * Math.tan((BAND_WIDTH_DEG / 2) * Math.PI / 180);
const PLATE_HEIGHT = 6;
// 描画の大きさと縦の画角(tools/render-lab/lab-case.ts)。
const VIEW_WIDTH = 960;
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
// 真値の積分の、床の点ごとの標本数。倍にしても真値の縁の幅が 0.5 px 以上変わらない数。
const TRUE_SAMPLES = 16384;
// 発光球の真値の頂を探す、帯の中心線の上の行の刻み [px]。
const PEAK_ROW_STEP = 0.25;
// 頂へ放物線を当てる行の、明るさの最大からの下がり幅の上限(最大に対する比)。粗い帯では標本の揺らぎが明るさの
// 1〜2% あり、それより十分広く取る。
const PEAK_FIT_DROP = 0.05;
// ローブの半幅が、床の点から見た発光球の視半径のこの割合に満たない帯では、像が一様な円盤で頂が平らなので、
// 頂の代わりに重心の行を取る(帯0)。
const FLAT_TOP_LOBE_RATIO = 0.25;
// チェッカーの真値の縁が断面に収まるのに、暗い側の明るさが下回らなければならない、基準に対する比。
const DARK_FLOOR = 0.05;
// 像から遠い輝点の表で、真値の像が読める行とみなす、その行の帯の画素の真値の最大の、帯の真値の頂に対する比の下限と、
// 輝点とみなす発光球の像の明るさの、帯の対照の頂に対する比の下限。
const READABLE_ROW_FLOOR = 0.001;
const DISTANT_SPOT_FLOOR = 0.1;
// 真値の像が読める行を決めるのに、行ごとに真値を求める帯の画素の列の数。その行の帯の区間の両端と中心を含めて等間隔に
// 取る — 粗い帯では、隣の帯の発光球の裾が帯の端でいちばん明るい。
const READABLE_ROW_COLUMNS = 5;
// 円錐の積分の、床の点・発光球ごとの標本数。倍にしても真値の像が読める行の範囲が変わらない数。
const CONE_SAMPLES = 1024;

// 画素の焦点距離 [px] と、カメラの見下ろす角 [rad]。
const FOCAL = VIEW_HEIGHT / 2 / Math.tan((FOV_DEG / 2) * Math.PI / 180);
const PITCH = CAMERA_PITCH_DEG * Math.PI / 180;
// 帯の中心線の上で、発光球の中心へ鏡の向きで届く床の点の、カメラの真下からの距離と、そこから球の中心までの距離 [m]。
const REFLECTION_DISTANCE = CAMERA_HEIGHT * BAND_OUTER_RADIUS / (CAMERA_HEIGHT + SPHERE_HEIGHT);
const REFLECTION_TO_SPHERE = Math.hypot(BAND_OUTER_RADIUS - REFLECTION_DISTANCE, SPHERE_HEIGHT);

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

// 行 y で帯 band の画素がいちばん長く続く区間 { start, length }(帯の画素が無ければ length 0)。粗さが偶然近い
// 離れた画素を帯に数えないために、その行の帯はこの区間とみなす。
function bandRun(bands, width, y, band) {
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
  return { start: bestStart, length: bestLength };
}

// 帯 band の中心線に沿った縦の断面。value(x, y) を中心線の左右 PROFILE_HALF_WIDTH 画素で平均し、上の行から並べる。
// 断面の要素は { at: 行, value }。
function bandProfile(bands, width, height, band, value) {
  const profile = [];
  for (let y = 0; y < height; y++) {
    const { start: bestStart, length: bestLength } = bandRun(bands, width, y, band);
    if (bestLength < MIN_ROW_PIXELS) continue;
    const center = bestStart + Math.floor(bestLength / 2);
    let total = 0;
    for (let dx = -PROFILE_HALF_WIDTH; dx <= PROFILE_HALF_WIDTH; dx++) total += value(center + dx, y);
    profile.push({ at: y, value: total / (2 * PROFILE_HALF_WIDTH + 1) });
  }
  return profile;
}

// 断面 profile を添字 from から step(±1)の向きへ進み、値が threshold を下回る位置(断面に沿った画素の位置、端数は
// 線形補間)。
function crossing(profile, from, step, threshold) {
  for (let i = from; i + step >= 0 && i + step < profile.length; i += step) {
    const a = profile[i];
    const b = profile[i + step];
    if (b.value < threshold) return a.at + (b.at - a.at) * (a.value - threshold) / (a.value - b.value);
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
  const distance = REFLECTION_TO_SPHERE - SPHERE_RADIUS;
  const hitAlong = REFLECTION_DISTANCE + (BAND_OUTER_RADIUS - REFLECTION_DISTANCE) * distance / REFLECTION_TO_SPHERE;
  const hitHeight = SPHERE_HEIGHT * distance / REFLECTION_TO_SPHERE;
  const azimuth = (band - (ROUGHNESSES.length - 1) / 2) * BAND_SPACING_DEG * Math.PI / 180;
  const depth = hitAlong * Math.cos(azimuth) * Math.cos(PITCH) - (hitHeight - CAMERA_HEIGHT) * Math.sin(PITCH);
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

// 帯 band の中心線の方位角 [rad]。描画座標で +Z から +X の向きへ測り、帯は画面の左から右へ並ぶ。
function bandAzimuth(band) {
  return (180 - (band - (ROUGHNESSES.length - 1) / 2) * BAND_SPACING_DEG) * Math.PI / 180;
}

// 帯 band の中心線の奥の端の、床の上の点 [x, z](描画座標)。発光球の中心とチェッカーの発光板の根元の中心の真下。
function bandEnd(band) {
  const azimuth = bandAzimuth(band);
  return [BAND_OUTER_RADIUS * Math.sin(azimuth), BAND_OUTER_RADIUS * Math.cos(azimuth)];
}

// 描画座標の点 (x, y, z) が写る画面の位置 [px]。端数ありで、画面の左上の角が (0, 0)、画素 i の中心は i + 0.5。
function screenOf(x, y, z) {
  const below = y - CAMERA_HEIGHT;
  const depth = -below * Math.sin(PITCH) - z * Math.cos(PITCH);
  const up = below * Math.cos(PITCH) - z * Math.sin(PITCH);
  return { column: VIEW_WIDTH / 2 + FOCAL * x / depth, row: VIEW_HEIGHT / 2 - FOCAL * up / depth };
}

// 画面の位置 (column, row) [px] に写る床の点 [x, z]。地平より上なら null。
function floorPointAt(column, row) {
  const right = (column - VIEW_WIDTH / 2) / FOCAL;
  const up = (VIEW_HEIGHT / 2 - row) / FOCAL;
  const descent = Math.sin(PITCH) - up * Math.cos(PITCH);
  if (descent <= 0) return null;
  const distance = CAMERA_HEIGHT / descent;
  return [distance * right, -distance * (Math.cos(PITCH) + up * Math.sin(PITCH))];
}

// 方位角 azimuth [rad] の鉛直な半平面のうち、画面の行 row [px] に写る床の点 [x, z]。カメラは原点の真上にいるので、
// この半平面の点(床で鏡映した点も)は画面の同じ線に写る。地平より上なら null。
function floorOnAzimuthAt(azimuth, row) {
  const up = (VIEW_HEIGHT / 2 - row) / FOCAL;
  const descent = Math.sin(PITCH) - up * Math.cos(PITCH);
  if (descent <= 0) return null;
  const distance = CAMERA_HEIGHT * (Math.cos(PITCH) + up * Math.sin(PITCH)) / descent / -Math.cos(azimuth);
  return [distance * Math.sin(azimuth), distance * Math.cos(azimuth)];
}

// 帯 band の中心線の上で、発光球の中心の鏡像が写る画面の行。
function mirrorRow(band) {
  const [x, z] = bandEnd(band);
  return screenOf(x, -SPHERE_HEIGHT, z).row;
}

// count 個の Hammersley 点を、単位円盤の上で面積について一様な極座標の形(半径 √u1 と、角 2π·u2 の cos・sin)で。
function hammersleyDisk(count) {
  const radius = new Float64Array(count);
  const cos = new Float64Array(count);
  const sin = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    // u2 は i のビットを逆順に並べた2進小数(van der Corput 列)。
    let bits = i;
    let u2 = 0;
    for (let scale = 0.5; bits > 0; bits >>>= 1, scale /= 2) u2 += (bits & 1) * scale;
    radius[i] = Math.sqrt((i + 0.5) / count);
    cos[i] = Math.cos(2 * Math.PI * u2);
    sin[i] = Math.sin(2 * Math.PI * u2);
  }
  return { count, radius, cos, sin };
}

const TRUE_POINTS = hammersleyDisk(TRUE_SAMPLES);

// GGX の Smith の Λ。alphaSquared は α²、cos は向きと法線の cos。
function smithLambda(alphaSquared, cos) {
  const cosSquared = cos * cos;
  return (Math.sqrt(1 + alphaSquared * (1 - cosSquared) / cosSquared) - 1) / 2;
}

// 床の点 (px, 0, pz)(法線 +Y)の、F0 = 1 の GGX の鏡面 ∫ L(l)·D(h)·V(l, v)·(n·l) dl。V は高さ相関の Smith、v は
// 床の点からカメラへの向き、L は床の点から l の向きへ出した光線の放射輝度 radiance(px, pz, lx, ly, lz)。向きを
// 可視法線分布(Heitz 2018)から選んで G2 / G1 を掛ける — 期待値がこの積分そのもので、細いローブでも標本が光源へ
// 集まる。標本は固定の Hammersley 点で、同じ引数には同じ値を返す。標本がローブの中に集まるので、像の近く(縁の幅・
// 頂の行)に向く。ローブの裾だけが光源に届く像から遠い点では、光源に当たる標本がまれで値が粗い — そこは発光球ごとの
// 円錐で積分する coneSpecular で求める。
function ggxSpecular(px, pz, alpha, radiance) {
  // 床の接平面の座標 (X, Z, Y) で、視線を α で引き伸ばした半球の上に標本を取る。
  const toCamera = Math.hypot(px, CAMERA_HEIGHT, pz);
  const vx = -px / toCamera;
  const vy = -pz / toCamera;
  const vz = CAMERA_HEIGHT / toCamera;
  const stretched = Math.hypot(alpha * vx, alpha * vy, vz);
  const hx = alpha * vx / stretched;
  const hy = alpha * vy / stretched;
  const hz = vz / stretched;
  const tangent = Math.hypot(hx, hy);
  const t1x = tangent > 0 ? -hy / tangent : 1;
  const t1y = tangent > 0 ? hx / tangent : 0;
  const t2x = -hz * t1y;
  const t2y = hz * t1x;
  const t2z = hx * t1y - hy * t1x;
  const s = (1 + hz) / 2;
  const alphaSquared = alpha * alpha;
  const lambdaView = smithLambda(alphaSquared, vz);
  const { count, radius, cos, sin } = TRUE_POINTS;
  let sum = 0;
  for (let i = 0; i < count; i++) {
    // 引き伸ばした半球の微小法線を、元の粗さの微小法線へ戻して視線を反射する。
    const a = radius[i] * cos[i];
    const b = (1 - s) * Math.sqrt(1 - a * a) + s * radius[i] * sin[i];
    const c = Math.sqrt(Math.max(0, 1 - a * a - b * b));
    let nx = alpha * (a * t1x + b * t2x + c * hx);
    let ny = alpha * (a * t1y + b * t2y + c * hy);
    let nz = Math.max(0, b * t2z + c * hz);
    const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
    nx /= length;
    ny /= length;
    nz /= length;
    const dot = 2 * (vx * nx + vy * ny + vz * nz);
    const lz = dot * nz - vz;
    // 面の下へ潜った向きは、積分の範囲(上の半球)の外。
    if (lz <= 0) continue;
    const incoming = radiance(px, pz, dot * nx - vx, lz, dot * ny - vy);
    if (incoming > 0) sum += incoming * (1 + lambdaView) / (1 + lambdaView + smithLambda(alphaSquared, lz));
  }
  return sum / count;
}

// 発光球の中心 [x, y, z](描画座標)。
const SPHERE_CENTERS = ROUGHNESSES.map((_, band) => {
  const [x, z] = bandEnd(band);
  return [x, SPHERE_HEIGHT, z];
});

// 床の点 (px, 0, pz) から向き (lx, ly, lz) へ出した光線が当たる発光球の放射輝度。どの球も同じ放射輝度で、球の
// ほかに当たるものは無い。
function sphereRadiance(px, pz, lx, ly, lz) {
  for (const [cx, cy, cz] of SPHERE_CENTERS) {
    const ox = px - cx;
    const oy = -cy;
    const oz = pz - cz;
    const along = ox * lx + oy * ly + oz * lz;
    const discriminant = along * along - (ox * ox + oy * oy + oz * oz - SPHERE_RADIUS * SPHERE_RADIUS);
    if (discriminant >= 0 && -along - Math.sqrt(discriminant) > 0) return EMITTER_RADIANCE;
  }
  return 0;
}

const CONE_POINTS = hammersleyDisk(CONE_SAMPLES);

// 床の点 (px, 0, pz)(法線 +Y)の、発光球すべてから来る F0 = 1 の GGX の鏡面 ∫ L·D(h)·V(l, v)·(n·l) dl(V と v は
// ggxSpecular と同じ)。発光球ごとに、床の点から見込む円錐の中の向きを立体角について一様に選ぶ — どの標本も球に
// 当たるので、ローブの裾だけが球に届く像から遠い点の小さな値も、相対誤差を小さく求まる。球は床のどの点から見ても
// 重ならないので、球ごとの積分を足す。標本は固定の Hammersley 点で、同じ引数には同じ値を返す。
function coneSpecular(px, pz, alpha) {
  const toCamera = Math.hypot(px, CAMERA_HEIGHT, pz);
  const viewX = -px / toCamera;
  const viewY = CAMERA_HEIGHT / toCamera;
  const viewZ = -pz / toCamera;
  const alphaSquared = alpha * alpha;
  const rootView = Math.sqrt(viewY * viewY * (1 - alphaSquared) + alphaSquared);
  const { count, radius, cos, sin } = CONE_POINTS;
  let total = 0;
  for (const [cx, cy, cz] of SPHERE_CENTERS) {
    // 球の中心への向き w と、それに直交する基底 t1・t2(Duff ら 2017)、円錐の半頂角の 1 − cos。
    const distance = Math.hypot(cx - px, cy, cz - pz);
    const wx = (cx - px) / distance;
    const wy = cy / distance;
    const wz = (cz - pz) / distance;
    const sign = wz >= 0 ? 1 : -1;
    const a = -1 / (sign + wz);
    const b = wx * wy * a;
    const t1 = [1 + sign * wx * wx * a, sign * b, -sign * wx];
    const t2 = [b, sign + wy * wy * a, -wy];
    const coneOneMinusCos = 1 - Math.sqrt(1 - (SPHERE_RADIUS / distance) ** 2);
    let sum = 0;
    for (let i = 0; i < count; i++) {
      // 円盤の点の半径の 2 乗を 1 − cosθ へ写すと、円錐の中で立体角について一様になる。
      const oneMinusCos = radius[i] * radius[i] * coneOneMinusCos;
      const cosTheta = 1 - oneMinusCos;
      const sinTheta = Math.sqrt(oneMinusCos * (2 - oneMinusCos));
      const u = sinTheta * cos[i];
      const v = sinTheta * sin[i];
      const lx = u * t1[0] + v * t2[0] + cosTheta * wx;
      const ly = u * t1[1] + v * t2[1] + cosTheta * wy;
      const lz = u * t1[2] + v * t2[2] + cosTheta * wz;
      if (ly <= 0) continue;
      // D(h)·V(l, v)·(n·l)。h は l と v の中間の向きで、n·h はその y 成分。
      const halfY = (ly + viewY) / Math.hypot(lx + viewX, ly + viewY, lz + viewZ);
      const denominator = halfY * halfY * (alphaSquared - 1) + 1;
      const distribution = alphaSquared / (Math.PI * denominator * denominator);
      const rootLight = Math.sqrt(ly * ly * (1 - alphaSquared) + alphaSquared);
      sum += distribution * 0.5 / (ly * rootView + viewY * rootLight) * ly;
    }
    total += EMITTER_RADIANCE * 2 * Math.PI * coneOneMinusCos * sum / count;
  }
  return total;
}

// 帯 band の中心線の上の、発光球の真値の明るさの頂の行(端数あり)。中心線の床の点を行で刻んで積分し、最大の
// まわりへ放物線を当てた頂点 — 頂の近くは平らで、刻みごとの最大は標本の揺らぎで跳ぶ。ローブが球の視半径より
// 十分細い帯では、像が一様な円盤で頂が決まらないので、重心の行。
function trueSphereRow(band, alpha) {
  const azimuth = bandAzimuth(band);
  const [x, z] = bandEnd(band);
  // 帯の奥の端から、球の中心の鏡像を挟んで同じ幅だけ手前まで。
  const far = screenOf(x, 0, z).row;
  const center = mirrorRow(band);
  const samples = [];
  for (let row = far + PEAK_ROW_STEP; row <= 2 * center - far; row += PEAK_ROW_STEP) {
    const [px, pz] = floorOnAzimuthAt(azimuth, row);
    samples.push({ row, value: ggxSpecular(px, pz, alpha, sphereRadiance) });
  }
  if (LOBE_HALF_WIDTH_PER_ALPHA * alpha < FLAT_TOP_LOBE_RATIO * Math.asin(SPHERE_RADIUS / REFLECTION_TO_SPHERE)) {
    const total = samples.reduce((sum, { value }) => sum + value, 0);
    return samples.reduce((sum, { row, value }) => sum + row * value, 0) / total;
  }
  // 放物線は、最大の行から明るさが最大の PEAK_FIT_DROP 倍だけ下がるまで続く行に当てる — 平らな頂ほど広い行で
  // 揺らぎを均す。
  let peak = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i].value > samples[peak].value) peak = i;
  const floor = (1 - PEAK_FIT_DROP) * samples[peak].value;
  let first = peak;
  let last = peak;
  while (first > 0 && samples[first - 1].value >= floor) first--;
  while (last < samples.length - 1 && samples[last + 1].value >= floor) last++;
  const near = samples.slice(first, last + 1).map(({ row, value }) => [row - samples[peak].row, value]);
  return samples[peak].row + parabolaVertex(near);
}

// 点 [d, v] の組へ最小二乗で当てた放物線 v = a·d² + b·d + c の頂点の d。
function parabolaVertex(points) {
  // 正規方程式 [Σd⁴ Σd³ Σd²; Σd³ Σd² Σd; Σd² Σd n]·[a b c] = [Σd²v Σdv Σv] を Cramer の公式で解く。
  const moment = [0, 0, 0, 0, 0];
  const weighted = [0, 0, 0];
  for (const [d, v] of points) {
    for (let k = 0; k < moment.length; k++) moment[k] += d ** k;
    for (let k = 0; k < weighted.length; k++) weighted[k] += d ** k * v;
  }
  const det3 = (a, b, c, d, e, f, g, h, i) => a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const [m0, m1, m2, m3, m4] = moment;
  const [w0, w1, w2] = weighted;
  // a と b はどちらも係数の行列式で割る前の値 — 頂点は比なので割らなくてよい。
  const a = det3(w2, m3, m2, w1, m2, m1, w0, m1, m0);
  const b = det3(m4, w2, m2, m3, w1, m1, m2, w0, m0);
  return -b / (2 * a);
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
    if (value > 0 && (best === null || value > best.value)) best = { at: profile[i].at, value };
  }
  return best?.at ?? null;
}

// 表 2: 帯ごとの、発光球の像の明るさの最大と和の、対照の像に対する比と、明るさの頂の行。頂の行は、断面を予測幅の
// 1/4 の箱で均してから取り、発光球の真値の頂の行(帯0は重心の行)と、球の中心の鏡像の行と並べる。
function brightnessTable(bands, sphereShot, lightShot) {
  const { width, height } = sphereShot;
  const sphere = bandBrightness(bands, sphereShot);
  const light = bandBrightness(bands, lightShot);
  const ratio = (measured, reference) => (reference <= 0 ? '-' : (measured / reference).toFixed(2));
  const row = (v) => (v === null ? '-' : String(v));
  const header = [
    '帯', '粗さ', '頂 球 / 球光源', '和 球 / 球光源', '頂の行 球', '頂の行 球光源', '頂の行 真値', '鏡像の中心の行',
  ];
  const lines = [header, header.map(() => '---')];
  for (const [index, roughness] of ROUGHNESSES.entries()) {
    const alpha = effectiveRoughness(roughness) ** 2;
    const box = predictedSphereWidth(index, alpha) / 4;
    const peak = (shot) => peakRow(
      bandProfile(bands, width, height, index, (x, y) => tonemappedLuminance(shot.at(x, y))), box);
    lines.push([
      index, roughness, ratio(sphere[index].peak, light[index].peak), ratio(sphere[index].sum, light[index].sum),
      row(peak(sphereShot)), row(peak(lightShot)), trueSphereRow(index, alpha).toFixed(1), mirrorRow(index).toFixed(1),
    ]);
  }
  return lines.map((cells) => `| ${cells.join(' | ')} |`).join('\n');
}

// 撮影 shot の帯ごとの、まだらの量 — 帯の画素の値と、そのまわり 5×5 の同じ帯の画素の平均との差の平均。帯の
// 画素の値の平均も返す。画素の値は、画素の符号 [r, g, b] から valueOf で読む。
function bandMottle(bands, shot, valueOf) {
  const { width, height } = shot;
  const luminance = new Float64Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) luminance[y * width + x] = valueOf(shot.at(x, y));
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

// 表 3: 帯ごとのまだらの量。発光球の像(ladder-reflection)はトーンマッピングを戻した輝度で、置換の重み
// (ladder-weight)はトーンマッピングを通さずに出る w で測る。比は帯の画素の値の平均に対する割合。
function mottleTable(bands, sphereShot, weightShot) {
  const sphere = bandMottle(bands, sphereShot, tonemappedLuminance);
  const weight = bandMottle(bands, weightShot, (code) => srgbToLinear(code[0] / 255));
  const format = (v) => v.toExponential(2);
  const relative = ({ mottle, mean }) => (mean <= 0 ? '-' : (mottle / mean).toFixed(3));
  const header = ['帯', '粗さ', '球 まだら', '球 まだら / 平均', 'w まだら', 'w まだら / 平均'];
  const lines = [header, header.map(() => '---')];
  for (const [index, roughness] of ROUGHNESSES.entries()) {
    lines.push([
      index, roughness, format(sphere[index].mottle), relative(sphere[index]),
      format(weight[index].mottle), relative(weight[index]),
    ]);
  }
  return lines.map((cells) => `| ${cells.join(' | ')} |`).join('\n');
}

// チェッカーの発光板。根元の中心の床の点 (x, z) と、外向き(カメラの真下から離れる向き)とカメラから見て右向きの
// 水平な単位ベクトル。
const PLATES = ROUGHNESSES.map((_, band) => {
  const azimuth = bandAzimuth(band);
  const [x, z] = bandEnd(band);
  return {
    x, z, outX: Math.sin(azimuth), outZ: Math.cos(azimuth), rightX: -Math.cos(azimuth), rightZ: Math.sin(azimuth),
  };
});

// 床の点 (px, 0, pz) から向き (lx, ly, lz) へ出した光線が最初に当たるチェッカーのマスの放射輝度。カメラから見て
// 左下と右上のマスが EMITTER_RADIANCE、黒いマスと、どの板にも当たらない光線は 0。
function checkerRadiance(px, pz, lx, ly, lz) {
  let nearest = Infinity;
  let radiance = 0;
  for (const plate of PLATES) {
    // 床の点はどの板よりもカメラの真下の側にあるので、外へ向かう光線だけが板の表に当たる。
    const outward = lx * plate.outX + lz * plate.outZ;
    if (outward <= 0) continue;
    const distance = (BAND_OUTER_RADIUS - px * plate.outX - pz * plate.outZ) / outward;
    const height = distance * ly;
    if (distance >= nearest || height > PLATE_HEIGHT) continue;
    const across = (px + distance * lx - plate.x) * plate.rightX + (pz + distance * lz - plate.z) * plate.rightZ;
    if (Math.abs(across) > PLATE_WIDTH / 2) continue;
    nearest = distance;
    radiance = (across < 0) === (height < PLATE_HEIGHT / 2) ? EMITTER_RADIANCE : 0;
  }
  return radiance;
}

// 断面に直交する向きに平均する画素を、中心からのずれ −PROFILE_HALF_WIDTH..PROFILE_HALF_WIDTH ごとに pixelAt で並べる。
function perpendicularPixels(pixelAt) {
  return Array.from({ length: 2 * PROFILE_HALF_WIDTH + 1 }, (_, k) => pixelAt(k - PROFILE_HALF_WIDTH));
}

// 画素 [x, y] の組 pixels がどれも画面の中で帯 band の上にあれば pixels、でなければ null。
function onBand(bands, band, pixels) {
  const inside = ([x, y]) => x >= 0 && y >= 0 && x < VIEW_WIDTH && y < VIEW_HEIGHT && bands[y * VIEW_WIDTH + x] === band;
  return pixels.every(inside) ? pixels : null;
}

// 方位角 azimuth の鉛直な半平面の像に沿った縦の断面の候補 { at: 行, pixels }。各行で、その行に写る半平面の列の
// 画素の左右に PROFILE_HALF_WIDTH 画素ずつ並べ、上の行から。
function verticalCandidates(bands, band, azimuth) {
  return Array.from({ length: VIEW_HEIGHT }, (_, y) => {
    const floor = floorOnAzimuthAt(azimuth, y + 0.5);
    if (floor === null) return { at: y, pixels: null };
    const x = Math.floor(screenOf(floor[0], 0, floor[1]).column);
    return { at: y, pixels: onBand(bands, band, perpendicularPixels((d) => [x + d, y])) };
  });
}

// 行 row に沿った横の断面の候補 { at: 列, pixels }。各列で上下に PROFILE_HALF_WIDTH 行ずつ並べ、左の列から。
function horizontalCandidates(bands, band, row) {
  return Array.from({ length: VIEW_WIDTH }, (_, x) => ({
    at: x, pixels: onBand(bands, band, perpendicularPixels((d) => [x, row + d])),
  }));
}

// 断面の候補 candidates のうち、境 boundary(断面に沿った画素の位置、端数あり)を含んで途切れずに帯の上を続く区間。
// 無ければ null。
function sectionAround(candidates, boundary) {
  let run = [];
  for (const candidate of [...candidates, { pixels: null }]) {
    if (candidate.pixels !== null) {
      run.push(candidate);
      continue;
    }
    if (run.length > 0 && run[0].at <= boundary && boundary <= run.at(-1).at) return run;
    run = [];
  }
  return null;
}

// 断面 section の各位置で value(x, y) を平均した断面 { at, value }。
function sectionProfile(section, value) {
  return section.map(({ at, pixels }) => ({
    at, value: pixels.reduce((sum, [x, y]) => sum + value(x, y), 0) / pixels.length,
  }));
}

// 断面 profile の、先頭(明るい側)から境 boundary を越えて暗い側へ下がる縁。基準の明るさは境より明るい側の最大 —
// 明るい側のマスの像のうち、縁のぼけのいちばん届いていない所。基準から暗い側へ、明るさが基準の 90% と 10% を
// 下回る位置 high・low(見つからなければ null)と、基準 reference を返す。明るい側が無いか真っ暗なら null。
function checkerEdge(profile, boundary) {
  let peak = null;
  for (let i = 0; i < profile.length && profile[i].at < boundary; i++) {
    if (peak === null || profile[i].value > profile[peak].value) peak = i;
  }
  if (peak === null || profile[peak].value <= 0) return null;
  const reference = profile[peak].value;
  return {
    reference, high: crossing(profile, peak, 1, 0.9 * reference), low: crossing(profile, peak, 1, 0.1 * reference),
  };
}

// 縁 edge の 90% から 10% までの幅 [px]。測れなければ null。
function edgeSpan(edge) {
  return edge === null || edge.high === null || edge.low === null ? null : edge.low - edge.high;
}

// 真値の縁 edge が断面 profile に収まるか。90% の位置が明るい側のマスの像の境の側の半分にあり(縁のぼけが明るい側の
// マスの像を半分より深く削らない)、暗い側が基準の DARK_FLOOR 倍を下回る所まで下がる(10% の位置が、ほかのマスの像
// から漏れた明るさの上に乗らない)。
function edgeFits(profile, boundary, edge) {
  if (edgeSpan(edge) === null || edge.high < (profile[0].at + boundary) / 2) return false;
  return profile.some(({ at, value }) => at > boundary && value < DARK_FLOOR * edge.reference);
}

// 断面 section の、境 boundary の縁の幅の実測 measured(x, y) と真値 truth(x, y) [px]。真値の縁が断面に収まらなければ、
// どちらも null。
function boundaryWidths(section, boundary, measured, truth) {
  if (section === null) return { measured: null, truth: null };
  const trueProfile = sectionProfile(section, truth);
  const trueEdge = checkerEdge(trueProfile, boundary);
  if (!edgeFits(trueProfile, boundary, trueEdge)) return { measured: null, truth: null };
  return { measured: edgeSpan(checkerEdge(sectionProfile(section, measured), boundary)), truth: edgeSpan(trueEdge) };
}

// 表 4: 帯ごとの、チェッカーの発光板の像(ladder-checker-reflection)の横の境と縦の境の縁の幅と、同じ断面・同じ平均・
// 同じ測り方の真値。比は 実測 / 真値 で、真値の 横の境 / 縦の境 は床の映り込みの縦と横のぼけ方の違い。
function checkerTable(bands, checkerShot) {
  const measured = (x, y) => tonemappedLuminance(checkerShot.at(x, y));
  const format = (v) => (v === null || !Number.isFinite(v) ? '-' : v.toFixed(1));
  const ratio = (numerator, denominator) => (
    numerator === null || denominator === null || denominator <= 0 ? '-' : (numerator / denominator).toFixed(2)
  );
  const header = [
    '帯', '粗さ', '横の境 実測', '横の境 真値', '横の境 実測 / 真値', '縦の境 実測', '縦の境 真値', '縦の境 実測 / 真値',
    '真値 横の境 / 縦の境', '球 予測',
  ];
  const lines = [header, header.map(() => '---')];
  for (const [index, roughness] of ROUGHNESSES.entries()) {
    const alpha = effectiveRoughness(roughness) ** 2;
    const truth = (x, y) => {
      const floor = floorPointAt(x + 0.5, y + 0.5);
      return floor === null ? 0 : ggxSpecular(floor[0], floor[1], alpha, checkerRadiance);
    };
    // マスと境の像は、板の点を床で鏡映して画面へ写した所。画素の添字で数える断面の位置は、写した位置から 0.5 引く。
    const plate = PLATES[index];
    const cellX = plate.x - plate.rightX * PLATE_WIDTH / 4;
    const cellZ = plate.z - plate.rightZ * PLATE_WIDTH / 4;
    // 横の境は、左下のマスの中心の方位角の縦の断面を、上(左下のマスの像)から下へ越える。
    const rowBoundary = screenOf(cellX, -PLATE_HEIGHT / 2, cellZ).row - 0.5;
    const columnSection = sectionAround(verticalCandidates(bands, index, Math.atan2(cellX, cellZ)), rowBoundary);
    const horizontal = boundaryWidths(columnSection, rowBoundary, measured, truth);
    // 縦の境は、左下のマスの中心の像の行の横の断面を、左(左下のマスの像)から右へ越える。
    const cellRow = Math.floor(screenOf(cellX, -PLATE_HEIGHT / 4, cellZ).row);
    const columnBoundary = screenOf(plate.x, -PLATE_HEIGHT / 4, plate.z).column - 0.5;
    const rowSection = sectionAround(horizontalCandidates(bands, index, cellRow), columnBoundary);
    const vertical = boundaryWidths(rowSection, columnBoundary, measured, truth);
    lines.push([
      index, roughness,
      format(horizontal.measured), format(horizontal.truth), ratio(horizontal.measured, horizontal.truth),
      format(vertical.measured), format(vertical.truth), ratio(vertical.measured, vertical.truth),
      ratio(horizontal.truth, vertical.truth), format(predictedSphereWidth(index, alpha)),
    ]);
  }
  return lines.map((cells) => `| ${cells.join(' | ')} |`).join('\n');
}

// 昇順の行の番号の列 rows を、続いた区間ごとに「最初〜最後」として並べた文字列。空なら '-'。
function rowRanges(rows) {
  const ranges = [];
  for (const row of rows) {
    const last = ranges.at(-1);
    if (last !== undefined && row === last[1] + 1) last[1] = row;
    else ranges.push([row, row]);
  }
  if (ranges.length === 0) return '-';
  return ranges.map(([first, last]) => (first === last ? String(first) : `${first}〜${last}`)).join(', ');
}

// 帯 band の行ごとの、帯の画素に写る床の点の発光球の真値(coneSpecular)の最大。行の帯の区間(bandRun)の両端と中心を
// 含む READABLE_ROW_COLUMNS 列で求め、帯の画素が無い行は −1。
function trueRowPeaks(bands, width, height, band, alpha) {
  const peaks = new Float64Array(height).fill(-1);
  for (let y = 0; y < height; y++) {
    const { start, length } = bandRun(bands, width, y, band);
    if (length === 0) continue;
    for (let k = 0; k < READABLE_ROW_COLUMNS; k++) {
      const x = start + Math.round(k * (length - 1) / (READABLE_ROW_COLUMNS - 1));
      const floor = floorPointAt(x + 0.5, y + 0.5);
      peaks[y] = Math.max(peaks[y], floor === null ? 0 : coneSpecular(floor[0], floor[1], alpha));
    }
  }
  return peaks;
}

// 表 5: 帯ごとの、像から遠い輝点の数と、輝点を数えない行 — 真値の像が読める行 — の範囲・帯の画素がある行の範囲・
// 数える行の数。真値の像が帯の全行で読める帯は、数える行が無いので数を '-' にする。
function distantSpotTable(bands, sphereShot, lightShot) {
  const { width, height } = sphereShot;
  // 帯ごとの、行ごとの真値の最大と、その最大(帯の真値の頂)。
  const truth = ROUGHNESSES.map((roughness, band) => {
    const rowPeaks = trueRowPeaks(bands, width, height, band, effectiveRoughness(roughness) ** 2);
    return { rowPeaks, peak: Math.max(...rowPeaks) };
  });
  const readable = (band, y) => truth[band].rowPeaks[y] >= READABLE_ROW_FLOOR * truth[band].peak;
  const lightPeaks = bandBrightness(bands, lightShot).map(({ peak }) => peak);
  // 真値の像が読めない行で、発光球の像が明るい帯の画素を数える。
  const spots = ROUGHNESSES.map(() => 0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const band = bands[y * width + x];
      if (band < 0 || readable(band, y)) continue;
      if (tonemappedLuminance(sphereShot.at(x, y)) >= DISTANT_SPOT_FLOOR * lightPeaks[band]) spots[band]++;
    }
  }
  const header = ['帯', '粗さ', '像から遠い輝点', '真値の像が読める行', '帯の行', '数える行の数'];
  const lines = [header, header.map(() => '---')];
  for (const [index, roughness] of ROUGHNESSES.entries()) {
    const bandRows = Array.from({ length: height }, (_, y) => y).filter((y) => truth[index].rowPeaks[y] >= 0);
    const readableRows = bandRows.filter((y) => readable(index, y));
    const counted = bandRows.length - readableRows.length;
    lines.push([
      index, roughness, counted === 0 ? '-' : spots[index], rowRanges(readableRows), rowRanges(bandRows), counted,
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
  console.log('\nまだらの量\n');
  console.log(mottleTable(bands, sphereShot, readShot(dir, 'ladder-weight')));
  console.log('\nチェッカーの縁の幅 [px](90% → 10%)\n');
  if (existsSync(path.join(dir, 'ladder-checker-reflection.png'))) {
    console.log(checkerTable(bands, readShot(dir, 'ladder-checker-reflection')));
  } else {
    console.log('ladder-checker-reflection の撮影が無い組なので飛ばした。');
  }
  console.log('\n像から遠い輝点\n');
  console.log(distantSpotTable(bands, sphereShot, lightShot));
}

main();
