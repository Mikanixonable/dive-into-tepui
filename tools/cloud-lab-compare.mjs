// 雲の実験環境の生成(合成ビュー)と実写(実写ビュー)の統計比較。ヘッドレス Chrome で
// .cloud-lab/ を開き、全球と地域別 cap の両面を撮って、帯状平均・階調・行方向スペクトルの表を出す。
// 画像は .cloud-lab/compare/ に残るので、数値で見つけた差は目でも確かめられる。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

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

// 8bit・非インターレースの PNG(グレー/RGB/RGBA)の R チャンネルを 0..1 で返す。
// tools/png.mjs はグレーの復号しか持たず、撮影はキャンバス由来の RGBA を書くのでここで解く。
function decodeRed(png) {
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      channels = { 0: 1, 2: 3, 6: 4 }[body[9]];
      if (body[8] !== 8 || channels === undefined || body[12] !== 0) {
        throw new Error(`unsupported PNG: depth=${body[8]} colorType=${body[9]} interlace=${body[12]}`);
      }
    } else if (type === 'IDAT') idat.push(body);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels + 1;
  const data = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * stride];
    const rowIn = y * stride + 1;
    const rowOut = y * width * channels;
    for (let i = 0; i < width * channels; i++) {
      const value = raw[rowIn + i];
      const left = i >= channels ? data[rowOut + i - channels] : 0;
      const up = y > 0 ? data[rowOut - width * channels + i] : 0;
      const upLeft = y > 0 && i >= channels ? data[rowOut - width * channels + i - channels] : 0;
      let predictor;
      if (filter === 0) predictor = 0;
      else if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else throw new Error(`unknown PNG filter ${filter}`);
      data[rowOut + i] = (value + predictor) & 0xff;
    }
  }
  const red = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) red[i] = data[i * channels] / 255;
  return { width, red };
}

// 画像 img の (x0, y) から n px の行。
function rowOf(img, x0, y, n) {
  return img.red.subarray(y * img.width + x0, y * img.width + x0 + n);
}

// 平均と、両端(<0.06 / >0.94)・中間調の割合。
function toneStats(img, x0, y0, w, h) {
  let low = 0;
  let mid = 0;
  let high = 0;
  let sum = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (const v of rowOf(img, x0, y, w)) {
      if (v < 0.06) low++;
      else if (v > 0.94) high++;
      else mid++;
      sum += v;
    }
  }
  const n = w * h;
  return { low: low / n, mid: mid / n, high: high / n, mean: sum / n };
}

// 行方向の 1 次元パワースペクトルをオクターブ束(波数 1-2, 2-4, ...)で。行は 1 本おきに間引く。
function rowSpectrum(img, x0, y0, w, h) {
  const power = new Float64Array(Math.floor(w / 2));
  let rows = 0;
  for (let y = y0; y < y0 + h; y += 2) {
    const row = rowOf(img, x0, y, w);
    let mean = 0;
    for (const v of row) mean += v;
    mean /= w;
    for (let k = 1; k < w / 2; k++) {
      let re = 0;
      let im = 0;
      const angle = (2 * Math.PI * k) / w;
      for (let x = 0; x < w; x++) {
        const v = row[x] - mean;
        re += v * Math.cos(angle * x);
        im -= v * Math.sin(angle * x);
      }
      power[k] += (re * re + im * im) / (w * w);
    }
    rows++;
  }
  const octaves = [];
  for (let k0 = 1; k0 < w / 2; k0 *= 2) {
    let sum = 0;
    for (let k = k0; k < Math.min(k0 * 2, w / 2); k++) sum += power[k];
    octaves.push({ k0, k1: Math.min(k0 * 2, Math.floor(w / 2)), value: sum / rows });
  }
  return octaves;
}

// 緯度 [°] → 全球面の行。
function rowAtLatitude(latitude) {
  return Math.round(((90 - latitude) / 180) * HEIGHT);
}

function printSpectrumTable(header, wavelengthOf, photo, composite) {
  console.log(header);
  console.log('波長帯 [km]        実写      合成      比(合成/実写)');
  for (let i = 0; i < photo.length; i++) {
    const coarse = wavelengthOf(photo[i].k0);
    const fine = wavelengthOf(photo[i].k1);
    console.log(
      `${fine.toFixed(0).padStart(5)}-${coarse.toFixed(0).padStart(5)}  ${photo[i].value.toExponential(2)}  `
      + `${composite[i].value.toExponential(2)}  ${(composite[i].value / photo[i].value).toFixed(3)}`);
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
      for (const view of ['photo', 'composite']) {
        await devTools.evaluate(`window.cloudLab.show(${JSON.stringify(view)})`);
        const dataUrl = await devTools.evaluate('window.cloudLab.capture()');
        const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
        writeFileSync(path.join(outDir, `${region.name}-${view}.png`), png);
        shots.set(`${region.name}-${view}`, decodeRed(png));
        console.log(`shot ${region.name} ${view}`);
      }
    }
    if (fatalEvents.length > 0) throw new Error(`Page reported errors during shooting:\n${fatalEvents.join('\n')}`);
  } finally {
    await session.close();
  }

  // 全球面はどの撮影にも同じものが写っているので、先頭の地域の 1 枚から取る。
  const globePhoto = shots.get(`${REGIONS[0].name}-photo`);
  const globeComposite = shots.get(`${REGIONS[0].name}-composite`);

  console.log('\n=== 帯状平均(全球面・5.625° 刻み): 実写, 合成, 比 ===');
  for (let band = 0; band < 32; band++) {
    const latitude = 90 - (band + 0.5) * 5.625;
    const photo = toneStats(globePhoto, 0, band * 16, GLOBE_W, 16);
    const composite = toneStats(globeComposite, 0, band * 16, GLOBE_W, 16);
    console.log(`${latitude.toFixed(1).padStart(6)}°  ${photo.mean.toFixed(3)}  ${composite.mean.toFixed(3)}  ${(composite.mean / photo.mean).toFixed(2)}`);
  }

  console.log('\n=== 階調(全球面・±60°): <0.06 / 中間 / >0.94 / 平均 ===');
  const y60 = rowAtLatitude(60);
  for (const [label, img] of [['実写', globePhoto], ['合成', globeComposite]]) {
    const t = toneStats(img, 0, y60, GLOBE_W, rowAtLatitude(-60) - y60);
    console.log(`${label}: ${(t.low * 100).toFixed(1)}% / ${(t.mid * 100).toFixed(1)}% / ${(t.high * 100).toFixed(1)}% / ${t.mean.toFixed(3)}`);
  }

  console.log('\n=== 行方向スペクトル(全球面)===');
  for (const [label, north, south] of [['35-60°N', 60, 35], ['10°S-10°N', 10, -10], ['35-60°S', -35, -60]]) {
    const y0 = rowAtLatitude(north);
    const h = rowAtLatitude(south) - y0;
    // その帯の中央緯度での 1 周 [km]。行方向の波数 k を波長へ直す目盛り。
    const circumference = 40075 * Math.cos((((north + south) / 2) * Math.PI) / 180);
    printSpectrumTable(
      `--- ${label} ---`, (k) => circumference / k,
      rowSpectrum(globePhoto, 0, y0, GLOBE_W, h), rowSpectrum(globeComposite, 0, y0, GLOBE_W, h));
  }

  console.log('\n=== 地域別 cap(中央 362×362): 実写平均, 合成平均, 実写 <0.06/中間/>0.94, 合成 <0.06/中間/>0.94 ===');
  const boxX0 = GLOBE_W + (CAP_W - CAP_BOX) / 2;
  const boxY0 = (HEIGHT - CAP_BOX) / 2;
  for (const region of REGIONS) {
    const photo = toneStats(shots.get(`${region.name}-photo`), boxX0, boxY0, CAP_BOX, CAP_BOX);
    const composite = toneStats(shots.get(`${region.name}-composite`), boxX0, boxY0, CAP_BOX, CAP_BOX);
    console.log(
      `${region.label}\n  ${photo.mean.toFixed(3)}  ${composite.mean.toFixed(3)}  `
      + `${(photo.low * 100).toFixed(0)}/${(photo.mid * 100).toFixed(0)}/${(photo.high * 100).toFixed(0)}%  `
      + `${(composite.low * 100).toFixed(0)}/${(composite.mid * 100).toFixed(0)}/${(composite.high * 100).toFixed(0)}%`);
  }

  console.log('\n=== 地域別 cap: 行方向スペクトル ===');
  // cap の正方形の幅 [km]。波数 k を波長へ直す目盛り。
  const boxSpan = ((2 * Math.sin((CAP_RADIUS * Math.PI) / 180) * 6371) / CAP_W) * CAP_BOX;
  for (const region of REGIONS) {
    printSpectrumTable(
      `--- ${region.label} ---`, (k) => boxSpan / k,
      rowSpectrum(shots.get(`${region.name}-photo`), boxX0, boxY0, CAP_BOX, CAP_BOX),
      rowSpectrum(shots.get(`${region.name}-composite`), boxX0, boxY0, CAP_BOX, CAP_BOX));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
