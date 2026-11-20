// 天気図(総観規模)の量を生成モデルから計測し、tools/cloud-lab/synoptic-targets.json の
// 実測目標値と突き合わせる。weather-probe ページで全球の面(海上気圧・上層風)を月 1 枚ずつ
// 焼いて年平均を取り、気圧配置は CPU で求まるので日次 1 年ぶんを場の焼き直しなしに読む。
// 使い方: `npm run cloud-lab:synoptic-stats -- <label>`。結果は
// `.cloud-lab/synoptic-stats/<label>.json` へ書き、表を標準出力へ出す。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.cloud-lab');
const outDir = path.join(buildDir, 'synoptic-stats');
const port = Number(process.env.CLOUD_LAB_PORT ?? 8781);
const debugPort = Number(process.env.CLOUD_LAB_DEBUG_PORT ?? 9458);
const label = process.argv[2] ?? 'baseline';
const targets = JSON.parse(
  readFileSync(path.join(root, 'tools/cloud-lab/synoptic-targets.json'), 'utf8')).metrics;

// 年平均を取る場の標本。月の真ん中へ置く 12 時刻 [h](年 8760 h 想定)。
const MONTH_HOURS = Array.from({ length: 12 }, (_, i) => (i + 0.5) * 730);
// 配置を読む日数。日次。
const PLACEMENT_DAYS = 365;
// 海上気圧の平年値 [hPa]。場の pressure チャンネルはこれからの偏差。
const MSLP_HPA = 1013;
// ジェットを探す中緯度の帯 [°]。波数はその芯の前後 ±5° の帯で測る。
const JET_BAND = [30, 70];
const JET_HALF_WIDTH = 5;
// 卓越波数を数える波数の範囲。k=0・1 は帯状平均と大規模な定常波が混ざるので外す。
const WAVENUMBERS = [2, 3, 4, 5, 6, 7, 8, 9, 10];
// 低気圧の追跡で、同一 index の連続 2 日でこれを超える経度差は追い切れなかった跳びとして捨てる [°/日]。
const MAX_PLAUSIBLE_DRIFT = 40;
// 熱帯低気圧の発生海域の仕分け。経度は連続な数で来るので −180〜180 へ畳んでから比べる。
const GENESIS_BASINS = [
  { name: 'northWestPacific', test: (lat, lon) => lat >= 0 && lat <= 40 && lon >= 100 && lon <= 180 },
  { name: 'northEastPacific', test: (lat, lon) => lat >= 0 && lat <= 35 && (lon <= -90 || lon > 180) },
  { name: 'northAtlantic', test: (lat, lon) => lat >= 0 && lat <= 40 && lon > -90 && lon <= -10 },
  { name: 'northIndian', test: (lat, lon) => lat >= 0 && lat <= 30 && lon >= 40 && lon < 100 },
  { name: 'southern', test: (lat) => lat < 0 },
];

function decodeFloats(base64) {
  const bytes = Buffer.from(base64, 'base64');
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

function median(values) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// 緯度 row の中心緯度 [°]。行は北→南。
const latitudeAtRow = (row, height) => 90 - (row + 0.5) * 180 / height;

// 実測値と目標の突合。値が { north, south } の対なら両方に同じ範囲を当て、外れているほうを採る。
function verdict(name, measured) {
  const target = targets[name];
  if (!target) return { name, measured, verdict: '対象外', note: '目標 JSON に項目が無い' };
  const values = typeof measured === 'object' && measured !== null
    ? Object.values(measured) : [measured];
  const inside = values.every((v) => v >= target.range[0] && v <= target.range[1]);
  return {
    name, measured, range: target.range, unit: target.unit,
    verdict: inside ? '範囲内' : '範囲外', source: target.source,
  };
}

async function main() {
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-cloud-synoptic-', onEvent,
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

    // 年を通した場の積算。緯度ごとの帯状平均(気圧・上層風速)と、波数用に
    // 子午面風の年平均を (row, col) で持つ。
    const weightRow = Array.from({ length: height }, (_, row) =>
      Math.cos(latitudeAtRow(row, height) * Math.PI / 180));
    const zonalPressure = new Float64Array(height);
    const zonalSpeed = new Float64Array(height);
    const meridional = new Float64Array(plane);
    let globalSum = 0;
    let globalWeight = 0;
    for (const hours of MONTH_HOURS) {
      await devTools.evaluate(`window.weatherProbe.prepare(${hours})`);
      const flat = decodeFloats(await devTools.evaluate('window.weatherProbe.readGlobal()'));
      const pressure = flat.subarray(index.pressure * plane, (index.pressure + 1) * plane);
      const windEast = flat.subarray(index.upperWindEast * plane, (index.upperWindEast + 1) * plane);
      const windNorth = flat.subarray(index.upperWindNorth * plane, (index.upperWindNorth + 1) * plane);
      for (let row = 0; row < height; row += 1) {
        const w = weightRow[row];
        for (let col = 0; col < width; col += 1) {
          const i = row * width + col;
          globalSum += w * pressure[i];
          globalWeight += w;
          zonalPressure[row] += w * (pressure[i] / MONTH_HOURS.length);
          zonalSpeed[row] += w * (Math.hypot(windEast[i], windNorth[i]) / MONTH_HOURS.length);
          meridional[i] += windNorth[i] / MONTH_HOURS.length;
        }
      }
    }
    const globalDeviation = globalSum / globalWeight;
    // 帯状平均は行ごとの加重平均を月数で割ったもの(上のループで / MONTH_HOURS 済み)。
    const zonalMean = (a, row) => a[row] / (weightRow[row] * width);

    // 緯度帯の帯状平均偏差。対象は全球平均からの偏差なので globalDeviation を引く。
    const bandDeviation = (latMin, latMax, south) => {
      let sum = 0; let wsum = 0;
      for (let row = 0; row < height; row += 1) {
        const lat = latitudeAtRow(row, height);
        const abs = south ? -lat : lat;
        if (abs < latMin || abs >= latMax) continue;
        sum += zonalMean(zonalPressure, row) * weightRow[row];
        wsum += weightRow[row];
      }
      return sum / wsum - globalDeviation;
    };

    // ジェットの芯: 中緯度の帯で帯状平均の上層風速が最大の緯度。半球ごと。
    const jetAt = (south) => {
      let best = { latitude: NaN, speed: -Infinity };
      for (let row = 0; row < height; row += 1) {
        const lat = latitudeAtRow(row, height);
        const abs = south ? -lat : lat;
        if (abs < JET_BAND[0] || abs > JET_BAND[1]) continue;
        const speed = zonalMean(zonalSpeed, row);
        if (speed > best.speed) best = { latitude: lat, speed };
      }
      return best;
    };
    const jetNorth = jetAt(false);
    const jetSouth = jetAt(true);

    // 卓越波数: 芯の前後 ±5° の帯で子午面風を緯度平均し、経度方向へ離散フーリエを掛ける。
    const wavenumberAt = (jetLatitude) => {
      const profile = new Float64Array(width);
      let rows = 0;
      for (let row = 0; row < height; row += 1) {
        if (Math.abs(latitudeAtRow(row, height) - jetLatitude) > JET_HALF_WIDTH) continue;
        rows += 1;
        for (let col = 0; col < width; col += 1) profile[col] += meridional[row * width + col];
      }
      if (rows === 0) return NaN;
      let bestK = NaN; let bestPower = -Infinity;
      for (const k of WAVENUMBERS) {
        let re = 0; let im = 0;
        for (let col = 0; col < width; col += 1) {
          const angle = 2 * Math.PI * k * col / width;
          re += profile[col] * Math.cos(angle);
          im -= profile[col] * Math.sin(angle);
        }
        const power = re * re + im * im;
        if (power > bestPower) { bestPower = power; bestK = k; }
      }
      return bestK;
    };

    // 配置の日次系列。低気圧は index ごとの経度差で移行速度を、発生の表で個数を取る。
    // 熱帯低気圧は null→非null を発生として数え、発生点の海域を仕分ける。
    const lowDrifts = [];
    const lowsByHemisphere = { north: [], south: [] };
    const highCounts = [];
    const tropicalGenesis = [];
    const tropicalWasActive = [];
    const previousLows = [];
    for (let day = 0; day < PLACEMENT_DAYS; day += 1) {
      const placements = await devTools.evaluate(
        `window.weatherProbe.placementsAt(${day * 24})`);
      let north = 0; let south = 0;
      placements.lows.forEach((low, i) => {
        if (!low) { previousLows[i] = null; return; }
        if (low.latitude > 0) north += 1; else south += 1;
        const previous = previousLows[i];
        if (previous) {
          const drift = Math.abs(low.longitude - previous.longitude);
          if (drift <= MAX_PLAUSIBLE_DRIFT) lowDrifts.push(drift);
        }
        previousLows[i] = low;
      });
      lowsByHemisphere.north.push(north);
      lowsByHemisphere.south.push(south);
      highCounts.push(placements.highs.filter(Boolean).length);
      placements.tropicals.forEach((tropical, i) => {
        if (tropical && !tropicalWasActive[i]) {
          const lon = ((tropical.longitude + 180) % 360 + 360) % 360 - 180;
          tropicalGenesis.push({ day, latitude: tropical.latitude, longitude: lon });
        }
        tropicalWasActive[i] = Boolean(tropical);
      });
    }
    const basinCounts = Object.fromEntries(GENESIS_BASINS.map((b) => [b.name, 0]));
    for (const g of tropicalGenesis) {
      const basin = GENESIS_BASINS.find((b) => b.test(g.latitude, g.longitude));
      if (basin) basinCounts[basin.name] += 1;
    }
    const genesisShare = tropicalGenesis.length === 0 ? NaN
      : Math.max(...Object.values(basinCounts)) / tropicalGenesis.length;

    const metrics = {
      mslpGlobalMeanHpa: MSLP_HPA + globalDeviation,
      // 赤道帯は南北対称に取る(|緯度| < 10°)。
      mslpEquatorialDeviationHpa: (() => {
        let sum = 0; let wsum = 0;
        for (let row = 0; row < height; row += 1) {
          if (Math.abs(latitudeAtRow(row, height)) >= 10) continue;
          sum += zonalMean(zonalPressure, row) * weightRow[row];
          wsum += weightRow[row];
        }
        return sum / wsum - globalDeviation;
      })(),
      mslpSubtropicalDeviationHpa: {
        north: bandDeviation(25, 40, false), south: bandDeviation(25, 40, true),
      },
      mslpSubpolarDeviationHpa: {
        north: bandDeviation(55, 68, false), south: bandDeviation(55, 68, true),
      },
      jetAxisLatitudeDeg: {
        north: Math.abs(jetNorth.latitude), south: Math.abs(jetSouth.latitude),
      },
      jetZonalMeanSpeedMs: { north: jetNorth.speed, south: jetSouth.speed },
      dominantWavenumber: {
        north: wavenumberAt(jetNorth.latitude), south: wavenumberAt(jetSouth.latitude),
      },
      lowTranslationDegPerDay: median(lowDrifts),
      simultaneousLowsPerHemisphere: {
        north: median(lowsByHemisphere.north), south: median(lowsByHemisphere.south),
      },
      simultaneousHighs: median(highCounts),
      tropicalCyclonesPerYear: tropicalGenesis.length * (365 / PLACEMENT_DAYS),
      tropicalGenesisMaxShare: genesisShare,
    };

    const rows = Object.entries(metrics).map(([name, measured]) => verdict(name, measured));
    const result = {
      label,
      samples: { fieldHours: MONTH_HOURS, placementDays: PLACEMENT_DAYS },
      metrics,
      tropicalGenesis,
      verdicts: rows,
    };
    mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `${label}.json`);
    writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);

    console.log(`\n# 総観の計測 — ${label}  (${file})`);
    for (const row of rows) {
      const shown = typeof row.measured === 'object' && row.measured !== null
        ? Object.entries(row.measured).map(([k, v]) => `${k}=${Number(v).toFixed(2)}`).join(' ')
        : Number(row.measured).toFixed(2);
      const range = row.range ? `[${row.range[0]}, ${row.range[1]}]` : '-';
      console.log(`${row.verdict.padEnd(4)} ${row.name.padEnd(32)} ${shown.padEnd(24)} 目標 ${range}`);
    }
    const misses = rows.filter((row) => row.verdict === '範囲外');
    console.log(misses.length === 0 ? '全項目が目標の範囲内。' : `${misses.length} 項目が範囲外。`);
    for (const event of fatalEvents) console.warn(event);
  } finally {
    await session.close();
  }
}

await main();
