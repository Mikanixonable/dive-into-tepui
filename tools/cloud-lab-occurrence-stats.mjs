// 積雲・対流の発生しやすさの層別統計。cloud-lab の weather-probe ページで全球の気象状態と雲の量を
// 浮動小数で読み、地表の種類(海・低地・丘陵・山地)×緯度帯×地方太陽時で、被覆・晴天率・深い対流の頻度・
// 対流の活発度・セル径を面積で重み付けして平均する。海上の気温の分布も出す。
// 前後比較の物差し(`memos/mikanixonable/cumulus-occurrence-literature-survey_2026-11-16.md` §7)。
// 使い方: npm run cloud-lab:occurrence-stats -- <ラベル>(既定 baseline)。
// 結果は .cloud-lab/occurrence-stats/<ラベル>.json と標準出力の表へ出す。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.cloud-lab');
const outDir = path.join(buildDir, 'occurrence-stats');
const port = 8779;
const debugPort = 9456;
const label = process.argv[2] ?? 'baseline';

// 読む世界時刻 [h]。地方太陽時の窓へ全経度が入るよう 3 時間刻みで 1 日を覆う。
const UTC_HOURS = [0, 3, 6, 9, 12, 15, 18, 21];
// 地方太陽時の帯 [h]。3 時間刻み。
const LOCAL_BIN_HOURS = 3;
// 緯度帯の境 [°]。絶対値で数え、南北を合わせる。
const LAT_EDGES = [0, 15, 30, 45, 60, 90];
// 地表の種類。陸らしさと標高 [m] で分ける。
const SURFACES = ['ocean', 'lowland', 'hills', 'mountain'];
// 晴天と数える被覆と、深い対流と数える氷雲の放出の強さの段。積雲の量は塔の高さを持たないので、
// 塔が上層へ氷雲を放出する強さ(detrain)を深い対流の指標にする。
const CLEAR_COVERAGE = 0.05;
const DEEP_DETRAINS = [0.05, 0.2, 0.5];
// 昼夜の差を見る緯度の上限 [°]。
const DIURNAL_MAX_LAT = 45;

function surfaceOf(land, elevation) {
  if (land < 0.05) return 'ocean';
  if (land < 0.95) return null; // 海岸の渡りは層別に入れない。
  if (elevation >= 1500) return 'mountain';
  if (elevation >= 500) return 'hills';
  return 'lowland';
}

class Accumulator {
  constructor() {
    this.weight = 0;
    this.coverage = 0;
    this.clear = 0;
    this.deep = DEEP_DETRAINS.map(() => 0);
    this.detrain = 0;
    this.deepPotential = 0;
    this.shallowForcing = 0;
    this.activity = 0;
    this.cellKm = 0;
  }

  add(weight, coverage, activity, cellKm, detrain, deepPotential, shallowForcing) {
    this.weight += weight;
    this.coverage += weight * coverage;
    this.clear += weight * (coverage < CLEAR_COVERAGE ? 1 : 0);
    this.detrain += weight * detrain;
    this.deepPotential += weight * deepPotential;
    this.shallowForcing += weight * shallowForcing;
    DEEP_DETRAINS.forEach((level, i) => {
      this.deep[i] += weight * (detrain >= level ? 1 : 0);
    });
    this.activity += weight * activity;
    this.cellKm += weight * cellKm;
  }

  summary() {
    const w = this.weight;
    if (w === 0) return null;
    return {
      area: w,
      coverage: this.coverage / w,
      clearFraction: this.clear / w,
      detrain: this.detrain / w,
      deepPotential: this.deepPotential / w,
      shallowForcing: this.shallowForcing / w,
      ...Object.fromEntries(DEEP_DETRAINS.map((level, i) => [`deep${level}`, this.deep[i] / w])),
      activity: this.activity / w,
      cellKm: this.cellKm / w,
    };
  }
}

function decodeFloats(base64) {
  const bytes = Buffer.from(base64, 'base64');
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

async function main() {
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-cloud-occurrence-', onEvent,
    requestTimeoutMs: 300_000,
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/weather-probe.html` });
    await waitFor(
      devTools,
      "(document.getElementById('error')?.textContent || typeof window.weatherProbe === 'object')",
      'the weather probe to initialise',
    );
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`Weather probe failed to initialise: ${failure}`);
    const { width, height, channels } = await devTools.evaluate(
      '({ width: window.weatherProbe.width, height: window.weatherProbe.height, channels: window.weatherProbe.channels })');
    const index = Object.fromEntries(channels.map((name, i) => [name, i]));
    const plane = width * height;

    const byLat = Object.fromEntries(SURFACES.map((s) => [s, LAT_EDGES.slice(1).map(() => new Accumulator())]));
    const byHour = Object.fromEntries(SURFACES.map((s) => [s, Array.from({ length: 24 / LOCAL_BIN_HOURS }, () => new Accumulator())]));
    const seaTemperatures = [];
    const landMarks = [];

    for (const utc of UTC_HOURS) {
      await devTools.evaluate(`window.weatherProbe.prepare(${utc})`);
      const flat = decodeFloats(await devTools.evaluate('window.weatherProbe.readGlobal()'));
      const channel = (name) => flat.subarray(index[name] * plane, (index[name] + 1) * plane);
      const land = channel('landFraction');
      const elevation = channel('elevation');
      const temperature = channel('temperatureK');
      const coverage = channel('coverage');
      const activity = channel('convectiveActivity');
      const cellKm = channel('cumulusCellKm');
      const detrain = channel('detrain');
      const deepPotential = channel('deepPotential');
      const shallowForcing = channel('shallowForcing');
      // 太陽直下経度 [rad]。weather-model の既定(平均太陽日で西へ一周)と同じ式。
      const sunLongitude = (utc * 3600 * -2 * Math.PI / 86400) % (2 * Math.PI);
      for (let row = 0; row < height; row += 1) {
        const latitude = 90 - (row + 0.5) * 180 / height;
        const absLatitude = Math.abs(latitude);
        const weight = Math.cos(latitude * Math.PI / 180);
        const latBand = LAT_EDGES.findIndex((edge, i) => i > 0 && absLatitude < edge) - 1;
        for (let col = 0; col < width; col += 1) {
          const i = row * width + col;
          const longitude = (-180 + (col + 0.5) * 360 / width) * Math.PI / 180;
          const surface = surfaceOf(land[i], elevation[i]);
          if (utc === 0 && row % 30 === 15 && col % 60 === 30) {
            landMarks.push({ lat: latitude, lon: longitude * 180 / Math.PI, land: land[i], elevation: elevation[i] });
          }
          if (surface === null) continue;
          byLat[surface][latBand].add(weight, coverage[i], activity[i], cellKm[i], detrain[i], deepPotential[i], shallowForcing[i]);
          if (absLatitude < DIURNAL_MAX_LAT) {
            const fraction = ((longitude - sunLongitude) / (2 * Math.PI) + 0.5) % 1;
            const localHour = (fraction < 0 ? fraction + 1 : fraction) * 24;
            const bin = Math.min(Math.floor(localHour / LOCAL_BIN_HOURS), 24 / LOCAL_BIN_HOURS - 1);
            byHour[surface][bin].add(weight, coverage[i], activity[i], cellKm[i], detrain[i], deepPotential[i], shallowForcing[i]);
          }
          if (surface === 'ocean' && absLatitude < 30 && utc === 0) seaTemperatures.push(temperature[i]);
        }
      }
      if (utc === 12) {
        // 各チャンネルの分布(全球・面積重みなし)。読み出しの単位や写像の取り違えを見つけるための診断。
        for (const name of channels) {
          const sorted = Float32Array.from(channel(name)).sort();
          const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toPrecision(4);
          console.log(`channel ${name.padEnd(18)} min ${q(0)} p50 ${q(0.5)} p90 ${q(0.9)} p99 ${q(0.99)} max ${q(1)}`);
        }
      }
      console.log(`read ${utc} h`);
    }

    seaTemperatures.sort((a, b) => a - b);
    const result = {
      label,
      utcHours: UTC_HOURS,
      latEdges: LAT_EDGES,
      byLatitude: Object.fromEntries(SURFACES.map((s) => [s, byLat[s].map((a) => a.summary())])),
      byLocalHour: Object.fromEntries(SURFACES.map((s) => [s, byHour[s].map((a) => a.summary())])),
      oceanTemperatureK: Object.fromEntries([0.05, 0.25, 0.5, 0.75, 0.95].map((p) => [p, percentile(seaTemperatures, p)])),
      landMarks,
    };
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, `${label}.json`), JSON.stringify(result, null, 2));
    printTables(result);
    if (fatalEvents.length > 0) throw new Error(`Page reported errors:\n${fatalEvents.join('\n')}`);
  } finally {
    await session.close();
  }
}

function formatCell(s, key) {
  return s === null ? '   -  ' : s[key].toFixed(3).padStart(6);
}

function printTables(result) {
  const latHeads = LAT_EDGES.slice(1).map((edge, i) => `${LAT_EDGES[i]}-${edge}°`.padStart(7));
  for (const key of ['coverage', 'clearFraction', 'deepPotential', 'shallowForcing', 'detrain', ...DEEP_DETRAINS.map((t) => `deep${t}`), 'activity', 'cellKm']) {
    console.log(`\n## ${key} — 地表 × 緯度帯(全時刻)`);
    console.log(`surface   ${latHeads.join(' ')}`);
    for (const s of SURFACES) {
      console.log(`${s.padEnd(9)} ${result.byLatitude[s].map((x) => formatCell(x, key)).join(' ')}`);
    }
  }
  const hourHeads = Array.from({ length: 24 / LOCAL_BIN_HOURS }, (_, i) => `${i * LOCAL_BIN_HOURS}h`.padStart(6));
  for (const key of ['coverage', 'clearFraction', 'deepPotential', 'shallowForcing', 'detrain', ...DEEP_DETRAINS.map((t) => `deep${t}`), 'activity']) {
    console.log(`\n## ${key} — 地表 × 地方太陽時(|緯度| < ${DIURNAL_MAX_LAT}°)`);
    console.log(`surface   ${hourHeads.join(' ')}`);
    for (const s of SURFACES) {
      console.log(`${s.padEnd(9)} ${result.byLocalHour[s].map((x) => formatCell(x, key)).join(' ')}`);
    }
  }
  console.log('\n## 海上(|緯度| < 30°)の平均気温 [K] のパーセンタイル');
  console.log(JSON.stringify(result.oceanTemperatureK));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
