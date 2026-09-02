// 雲の実験環境の生成と実写(8k_clouds)の統計比較。ヘッドレス Chrome で .cloud-lab/ を開き、
// 全球と地域別 cap の両面を撮って、帯状平均・階調・行方向スペクトルの表を出す。
//
// 実写は低い厚い雲と高層の巻雲が 1 枚に重なっていて、生成側の被覆率(厚い雲)・薄い雲(巻雲)と
// 成分ごとに比べられないので、分離した成分と比べる。分離の実装は
// tools/cloud-lab/separation-pipeline.ts(TSL 版)の一本だけ — ここでは再分離せず、
// `npm run cloud-lab:separate` が書いた原寸の出力(.cloud-lab/separated/)を読み込んで、
// 撮影の面(全球の正距円筒と cap の正射影)へ再標本化する。**先に separate を実行しておく。**
// 再標本化した実写厚・実写薄も画像で .cloud-lab/compare/ に残る。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';
import { cropField, decodeRedPng, fieldToGrayPng } from './gray-image.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.cloud-lab');
const outDir = path.join(buildDir, 'compare');
const port = 8769;
const debugPort = 9446;

// 撮る面の大きさ。tools/cloud-lab/lab.ts の VIEW_HEIGHT / GLOBE_WIDTH / CAP_SIZE と対。
const GLOBE_W = 1024;
const HEIGHT = 512;
const CAP_W = 512;
// cap の円板に内接する、統計に使う中央の正方形の1辺 [px](512 / √2 を切り下げ)。
const CAP_BOX = 362;
// cap の照準。半径 20° の円板は 8.5 km/texel で、実写(赤道 4.9 km/texel)とほぼ同じ細かさになる。
const CAP_RADIUS = 20;
const REGIONS = [
  { name: 'typhoon', label: '台風(15N 140E)', latitude: 15, longitude: 140 },
  { name: 'npac-storm', label: '北太平洋の暴風帯(45N 170W)', latitude: 45, longitude: -170 },
  { name: 'sepac-subtrop', label: '南東太平洋の亜熱帯高圧帯(20S 85W)', latitude: -20, longitude: -85 },
  { name: 'sahara', label: 'サハラ(22N 10E)', latitude: 22, longitude: 10 },
  { name: 'itcz-atl', label: '大西洋の収束帯(5N 25W)', latitude: 5, longitude: -25 },
  { name: 'so-ocean', label: '南大洋(55S 100E)', latitude: -55, longitude: 100 },
];
const VIEWS = ['photo', 'composite', 'coverage', 'translucent'];

const CAP_KM_PER_PX = (2 * Math.sin((CAP_RADIUS * Math.PI) / 180) * 6371) / CAP_W;

// 分離済みの成分(原寸の正距円筒)。厚い雲は src/assets の仮テクスチャ、veil は検分用の出力に
// ある。無ければ手順ごと伝える。
function loadSeparated(file) {
  try {
    return decodeRedPng(readFileSync(path.join(root, file)));
  } catch (e) {
    throw new Error(`${file} を読めない — 先に npm run cloud-lab:separate を実行する (${e.message})`);
  }
}

// 全球面への箱の縮小(整数倍を前提にした平均)。
function downsampleTo(field, width, height) {
  const factor = Math.round(field.width / width);
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          sum += field.data[(y * factor + dy) * field.width + (x * factor + dx)];
        }
      }
      out[y * width + x] = sum / (factor * factor);
    }
  }
  return { width, height, data: out };
}

// 経度で巻き付く双一次標本化。u, v は texel 座標。
function sampleBilinear(field, u, v) {
  const x0 = Math.floor(u);
  const y0 = Math.min(field.height - 2, Math.max(0, Math.floor(v)));
  const fx = u - x0;
  const fy = Math.min(1, Math.max(0, v - y0));
  const xa = ((x0 % field.width) + field.width) % field.width;
  const xb = (xa + 1) % field.width;
  const row0 = y0 * field.width;
  const row1 = (y0 + 1) * field.width;
  return (field.data[row0 + xa] * (1 - fx) + field.data[row0 + xb] * fx) * (1 - fy)
    + (field.data[row1 + xa] * (1 - fx) + field.data[row1 + xb] * fx) * fy;
}

// cap の面(正射影)の中央 362×362 を、原寸の正距円筒から再標本化する。式は
// src/render/cloud/field-projection.ts の OrthographicCap / equirectUvFromDirection と対。
function resampleCap(field, latitudeDeg, longitudeDeg) {
  const latitude = (latitudeDeg * Math.PI) / 180;
  const longitude = (longitudeDeg * Math.PI) / 180;
  const cosLat = Math.cos(latitude);
  const sinLat = Math.sin(latitude);
  const cosLon = Math.cos(longitude);
  const sinLon = Math.sin(longitude);
  const center = [cosLat * sinLon, sinLat, cosLat * cosLon];
  const east = [cosLon, 0, -sinLon];
  const north = [-sinLat * sinLon, cosLat, -sinLat * cosLon];
  const sinRadius = Math.sin((CAP_RADIUS * Math.PI) / 180);
  const margin = (CAP_W - CAP_BOX) / 2;
  const out = new Float32Array(CAP_BOX * CAP_BOX);
  for (let by = 0; by < CAP_BOX; by++) {
    const v = (margin + by + 0.5) / CAP_W;
    for (let bx = 0; bx < CAP_BOX; bx++) {
      const u = (margin + bx + 0.5) / CAP_W;
      const px = (u * 2 - 1) * sinRadius;
      const py = (1 - v * 2) * sinRadius;
      const along = Math.sqrt(Math.max(1 - px * px - py * py, 0));
      const dir = [
        east[0] * px + north[0] * py + center[0] * along,
        east[1] * px + north[1] * py + center[1] * along,
        east[2] * px + north[2] * py + center[2] * along,
      ];
      const eu = Math.atan2(dir[0], dir[2]) / (2 * Math.PI) + 0.5;
      const ev = 0.5 - Math.asin(Math.min(1, Math.max(-1, dir[1]))) / Math.PI;
      out[by * CAP_BOX + bx] = sampleBilinear(field, eu * field.width - 0.5, ev * field.height - 0.5);
    }
  }
  return { width: CAP_BOX, height: CAP_BOX, data: out };
}

function saveGray(name, field) {
  writeFileSync(path.join(outDir, name), fieldToGrayPng(field));
}

// 平均と、両端(<0.06 / >0.94)・中間調の割合。
function toneStats(field) {
  let low = 0;
  let mid = 0;
  let high = 0;
  let sum = 0;
  for (const v of field.data) {
    if (v < 0.06) low++;
    else if (v > 0.94) high++;
    else mid++;
    sum += v;
  }
  const n = field.data.length;
  return { low: low / n, mid: mid / n, high: high / n, mean: sum / n };
}

// 行方向の 1 次元パワースペクトルをオクターブ束(波数 1-2, 2-4, ...)で。行は 1 本おきに間引く。
function rowSpectrum(field) {
  const { width, height, data } = field;
  const power = new Float64Array(Math.floor(width / 2));
  let rows = 0;
  for (let y = 0; y < height; y += 2) {
    const row = data.subarray(y * width, (y + 1) * width);
    let mean = 0;
    for (const v of row) mean += v;
    mean /= width;
    for (let k = 1; k < width / 2; k++) {
      let re = 0;
      let im = 0;
      const angle = (2 * Math.PI * k) / width;
      for (let x = 0; x < width; x++) {
        const v = row[x] - mean;
        re += v * Math.cos(angle * x);
        im -= v * Math.sin(angle * x);
      }
      power[k] += (re * re + im * im) / (width * width);
    }
    rows++;
  }
  const octaves = [];
  for (let k0 = 1; k0 < width / 2; k0 *= 2) {
    let sum = 0;
    for (let k = k0; k < Math.min(k0 * 2, width / 2); k++) sum += power[k];
    octaves.push({ k0, k1: Math.min(k0 * 2, Math.floor(width / 2)), value: sum / rows });
  }
  return octaves;
}

// 緯度 [°] → 全球面の行。
function rowAtLatitude(latitude) {
  return Math.round(((90 - latitude) / 180) * HEIGHT);
}

function printSpectrumTable(header, wavelengthOf, reference, generated, referenceLabel, generatedLabel) {
  console.log(header);
  console.log(`波長帯 [km]      ${referenceLabel}   ${generatedLabel}   比(生成/実写)`);
  for (let i = 0; i < reference.length; i++) {
    const coarse = wavelengthOf(reference[i].k0);
    const fine = wavelengthOf(reference[i].k1);
    console.log(
      `${fine.toFixed(0).padStart(5)}-${coarse.toFixed(0).padStart(5)}  ${reference[i].value.toExponential(2)}  `
      + `${generated[i].value.toExponential(2)}  ${(generated[i].value / reference[i].value).toFixed(3)}`);
  }
}

async function main() {
  // 分離済みの成分を先に読む(無いなら撮影の前に気付かせる)。
  // 仮テクスチャの R が被覆率(loadSeparated は R 成分を返す)。
  const separatedThick = loadSeparated(path.join('src', 'assets', 'cloud-field.png'));
  const separatedVeil = loadSeparated(path.join('.cloud-lab', 'separated', 'veil.png'));

  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-cloud-compare-', onEvent,
  });
  const shots = new Map();
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    await waitFor(
      devTools,
      "(document.getElementById('error')?.textContent || typeof window.cloudLab === 'object')",
      'the cloud lab to initialise',
    );
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`Cloud lab failed to initialise: ${failure}`);

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    await devTools.evaluate('window.cloudLab.setTime(0)');
    for (const region of REGIONS) {
      await devTools.evaluate(
        `window.cloudLab.aimCap(${region.latitude}, ${region.longitude}, ${CAP_RADIUS})`);
      for (const view of VIEWS) {
        await devTools.evaluate(`window.cloudLab.show(${JSON.stringify(view)})`);
        const dataUrl = await devTools.evaluate('window.cloudLab.capture()');
        const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
        writeFileSync(path.join(outDir, `${region.name}-${view}.png`), png);
        shots.set(`${region.name}-${view}`, decodeRedPng(png));
        console.log(`shot ${region.name} ${view}`);
      }
    }
    if (fatalEvents.length > 0) throw new Error(`Page reported errors during shooting:\n${fatalEvents.join('\n')}`);
  } finally {
    await session.close();
  }

  // 全球面はどの撮影にも同じものが写っているので、先頭の地域の 1 枚から取る。
  const globeOf = (view) => cropField(shots.get(`${REGIONS[0].name}-${view}`), 0, 0, GLOBE_W, HEIGHT);
  // 薄い雲ビューの表示値は光学的厚み τ そのもの。実写の veil(輝度)と比べるため 1 − e^(−τ) へ。
  const brightnessOf = (field) => ({
    width: field.width, height: field.height, data: Float32Array.from(field.data, (t) => 1 - Math.exp(-t)),
  });

  const globe = {
    photo: globeOf('photo'),
    thick: downsampleTo(separatedThick, GLOBE_W, HEIGHT),
    veil: downsampleTo(separatedVeil, GLOBE_W, HEIGHT),
    coverage: globeOf('coverage'),
    translucent: brightnessOf(globeOf('translucent')),
    composite: globeOf('composite'),
  };
  saveGray('globe-thick.png', globe.thick);
  saveGray('globe-veil.png', globe.veil);

  const boxX0 = GLOBE_W + (CAP_W - CAP_BOX) / 2;
  const boxY0 = (HEIGHT - CAP_BOX) / 2;
  const caps = new Map();
  for (const region of REGIONS) {
    const thick = resampleCap(separatedThick, region.latitude, region.longitude);
    const veil = resampleCap(separatedVeil, region.latitude, region.longitude);
    saveGray(`${region.name}-thick.png`, thick);
    saveGray(`${region.name}-veil.png`, veil);
    caps.set(region.name, {
      photo: cropField(shots.get(`${region.name}-photo`), boxX0, boxY0, CAP_BOX, CAP_BOX),
      thick,
      veil,
      coverage: cropField(shots.get(`${region.name}-coverage`), boxX0, boxY0, CAP_BOX, CAP_BOX),
      translucent: brightnessOf(cropField(shots.get(`${region.name}-translucent`), boxX0, boxY0, CAP_BOX, CAP_BOX)),
      composite: cropField(shots.get(`${region.name}-composite`), boxX0, boxY0, CAP_BOX, CAP_BOX),
    });
  }

  console.log('\n=== 帯状平均(全球面・5.625° 刻み) ===');
  console.log('緯度      実写計  実写厚  実写薄  被覆率  薄い雲  合成   被覆率/実写厚');
  for (let band = 0; band < 32; band++) {
    const latitude = 90 - (band + 0.5) * 5.625;
    const rowMeans = Object.fromEntries(Object.entries(globe).map(([key, field]) =>
      [key, toneStats(cropField(field, 0, band * 16, GLOBE_W, 16)).mean]));
    console.log(
      `${latitude.toFixed(1).padStart(6)}°  ${rowMeans.photo.toFixed(3)}  ${rowMeans.thick.toFixed(3)}  `
      + `${rowMeans.veil.toFixed(3)}  ${rowMeans.coverage.toFixed(3)}  ${rowMeans.translucent.toFixed(3)}  `
      + `${rowMeans.composite.toFixed(3)}  ${(rowMeans.coverage / Math.max(1e-6, rowMeans.thick)).toFixed(2)}`);
  }

  console.log('\n=== 階調(全球面・±60°): <0.06 / 中間 / >0.94 / 平均 ===');
  const y60 = rowAtLatitude(60);
  const bandHeight = rowAtLatitude(-60) - y60;
  for (const [label, key] of [['実写計', 'photo'], ['実写厚', 'thick'], ['合成', 'composite'], ['被覆率', 'coverage']]) {
    const t = toneStats(cropField(globe[key], 0, y60, GLOBE_W, bandHeight));
    console.log(`${label}: ${(t.low * 100).toFixed(1)}% / ${(t.mid * 100).toFixed(1)}% / ${(t.high * 100).toFixed(1)}% / ${t.mean.toFixed(3)}`);
  }

  console.log('\n=== 行方向スペクトル(全球面, 実写厚 vs 被覆率)===');
  for (const [label, north, south] of [['35-60°N', 60, 35], ['10°S-10°N', 10, -10], ['35-60°S', -35, -60]]) {
    const y0 = rowAtLatitude(north);
    const h = rowAtLatitude(south) - y0;
    const circumference = 40075 * Math.cos((((north + south) / 2) * Math.PI) / 180);
    printSpectrumTable(
      `--- ${label} ---`, (k) => circumference / k,
      rowSpectrum(cropField(globe.thick, 0, y0, GLOBE_W, h)), rowSpectrum(cropField(globe.coverage, 0, y0, GLOBE_W, h)),
      '実写厚', '被覆率');
  }

  console.log('\n=== 地域別 cap(中央 362×362)の平均 ===');
  console.log('地域                                  実写計  実写厚  実写薄  被覆率  薄い雲  合成');
  for (const region of REGIONS) {
    const cap = caps.get(region.name);
    const means = Object.fromEntries(Object.entries(cap).map(([key, field]) => [key, toneStats(field).mean]));
    console.log(
      `${region.label.padEnd(24)}  ${means.photo.toFixed(3)}  ${means.thick.toFixed(3)}  ${means.veil.toFixed(3)}  `
      + `${means.coverage.toFixed(3)}  ${means.translucent.toFixed(3)}  ${means.composite.toFixed(3)}`);
  }

  console.log('\n=== 地域別 cap: 行方向スペクトル(実写厚 vs 被覆率)===');
  for (const region of REGIONS) {
    const cap = caps.get(region.name);
    printSpectrumTable(
      `--- ${region.label} ---`, (k) => (CAP_BOX * CAP_KM_PER_PX) / k,
      rowSpectrum(cap.thick), rowSpectrum(cap.coverage), '実写厚', '被覆率');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
