// 雲の実験環境の生成と実写(8k_clouds)の統計比較。ヘッドレス Chrome で .cloud-lab/ を開き、
// 全球と地域別 cap の両面を撮って、帯状平均・階調・行方向スペクトルの表を出す。
//
// 実写は低い厚い雲と高層の巻雲が 1 枚に重なっていて、生成側の被覆率(厚い雲)・薄い雲(巻雲)と
// 成分ごとに比べられないので、tools/cloud-separation.mjs の推定分離を通してから比べる(方法と
// 癖はそちらのコメント)。**分離の判定素材(細かい起伏)は解像度に強く依存し、撮影の面
// (全球 39 km/texel、cap はミップで鈍る)では veil 側へ寄りすぎる。** 成分別の正は原寸で分離する
// `npm run cloud-lab:separate` の出力(.cloud-lab/separated/)にあり、ここの実写厚・実写薄の列は
// 傾向を見る目安に留める。分離した thick / veil は画像でも .cloud-lab/compare/ に残る。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';
import { cropField, decodeRedPng, fieldToGrayPng } from './gray-image.mjs';
import { separateClouds } from './cloud-separation.mjs';

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

// 実写の 1 px が張る長さ [km]。全球面は赤道での値(横は緯度で cos 倍に縮む)。
const GLOBE_KM_PER_PX = 40075 / GLOBE_W / 2;
const CAP_KM_PER_PX = (2 * Math.sin((CAP_RADIUS * Math.PI) / 180) * 6371) / CAP_W;

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

  const globePhoto = globeOf('photo');
  const globeKmPerPx = (y) => {
    const latitude = ((HEIGHT / 2 - y) / HEIGHT) * Math.PI;
    return { x: GLOBE_KM_PER_PX * Math.max(0.2, Math.cos(latitude)), y: GLOBE_KM_PER_PX };
  };
  const globeSeparated = separateClouds(globePhoto, globeKmPerPx, true);
  saveGray('globe-thick.png', globeSeparated.thick);
  saveGray('globe-veil.png', globeSeparated.veil);
  const globe = {
    photo: globePhoto,
    thick: globeSeparated.thick,
    veil: globeSeparated.veil,
    coverage: globeOf('coverage'),
    translucent: brightnessOf(globeOf('translucent')),
    composite: globeOf('composite'),
  };

  const capKmPerPx = () => ({ x: CAP_KM_PER_PX, y: CAP_KM_PER_PX });
  const boxX0 = GLOBE_W + (CAP_W - CAP_BOX) / 2;
  const boxY0 = (HEIGHT - CAP_BOX) / 2;
  const caps = new Map();
  for (const region of REGIONS) {
    const photo = cropField(shots.get(`${region.name}-photo`), boxX0, boxY0, CAP_BOX, CAP_BOX);
    const separated = separateClouds(photo, capKmPerPx, false);
    saveGray(`${region.name}-thick.png`, separated.thick);
    saveGray(`${region.name}-veil.png`, separated.veil);
    caps.set(region.name, {
      photo,
      thick: separated.thick,
      veil: separated.veil,
      coverage: cropField(shots.get(`${region.name}-coverage`), boxX0, boxY0, CAP_BOX, CAP_BOX),
      translucent: brightnessOf(cropField(shots.get(`${region.name}-translucent`), boxX0, boxY0, CAP_BOX, CAP_BOX)),
      composite: cropField(shots.get(`${region.name}-composite`), boxX0, boxY0, CAP_BOX, CAP_BOX),
    });
  }

  console.log('\n注: 実写厚・実写薄の列は撮影解像度での再分離で、veil 側へ寄りすぎる傾向がある。');
  console.log('成分別の正は npm run cloud-lab:separate の原寸の出力(.cloud-lab/separated/)。');
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
