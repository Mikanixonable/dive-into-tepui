// 生成器の気象状態を全球の浮動小数の面として書き出す。tools/cloud-lab/weather-probe.html の
// ページ(window.weatherProbe)が、表示時刻ごとに地球の生成雲場を焼き、天気のモデル
// (WeatherSample)と雲の量を色へ写す前の物理量のまま RGBA32F の写しから返す — 全球の
// 正距円筒 720×360(0.5°、行は北→南、列は西経 180° → 東経 180°)、チャンネルごとの面が
// channels の順に連なる生の Float32(リトルエンディアン)。
//
// 使い方: CLOUD_LAB_PORT=8841 CLOUD_LAB_DEBUG_PORT=9541 node tools/cloud-regime-weather.mjs
//   --hours=0,24 で読み出す時刻を差し替える(既定 [0,60,...,420] h)。
// 出力: .cloud-detail/regime/generated-weather/h<時刻を4桁0埋め>.f32 と manifest.json。
// 読み込みは loadGeneratedWeather()。
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.cloud-lab');
const outDir = path.join(root, '.cloud-detail', 'regime', 'generated-weather');
const manifestPath = path.join(outDir, 'manifest.json');

const port = Number(process.env.CLOUD_LAB_PORT ?? 8841);
const debugPort = Number(process.env.CLOUD_LAB_DEBUG_PORT ?? 9541);
const DEFAULT_HOURS = [0, 60, 120, 180, 240, 300, 360, 420];
const hours = (() => {
  const arg = process.argv.find((a) => a.startsWith('--hours='));
  if (arg === undefined) return DEFAULT_HOURS;
  return arg.slice('--hours='.length).split(',').map(Number);
})();

function buildCloudLab() {
  const cli = path.join(root, 'node_modules', 'webpack-cli', 'bin', 'cli.js');
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [cli, '--config', 'webpack.cloud-lab.config.js', '--mode', 'production'],
      { cwd: root, stdio: 'inherit' },
    );
    child.on('exit', (code) => (
      code === 0 ? resolve() : reject(new Error(`webpack exited with code ${code}`))
    ));
    child.on('error', reject);
  });
}

// 時刻 hours [h] のファイル名。整数は 4 桁へ 0 埋めする。
function weatherFile(hoursValue) {
  return path.join(outDir, `h${String(hoursValue).padStart(4, '0')}.f32`);
}

// 1 時刻ぶんの、チャンネルごとの最小・平均・最大。面は channels の順に width*height ずつ並ぶ。
function channelStats(data, { width, height, channels }) {
  const plane = width * height;
  return channels.map((name, c) => {
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (let i = c * plane; i < (c + 1) * plane; i += 1) {
      const v = data[i];
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    return { name, min, mean: sum / plane, max };
  });
}

// 時刻ごと・チャンネルごとの最小/平均/最大の表。行はチャンネル、列は時刻。
function printStatsTable(allStats) {
  const fmt = (v) => Number(v.toPrecision(3));
  const rows = allStats[0].stats.map((s) => s.name);
  const cells = rows.map((name, r) => allStats.map(({ stats }) => (
    `${fmt(stats[r].min)}/${fmt(stats[r].mean)}/${fmt(stats[r].max)}`
  )));
  const width = Math.max(...cells.flat().map((cell) => cell.length)) + 2;
  console.log('\n=== 時刻ごと・チャンネルごとの最小/平均/最大 ===');
  console.log('チャンネル'.padEnd(18) + allStats.map(({ hours: h }) => `h${String(h).padStart(4, '0')}`.padStart(width)).join(''));
  for (let r = 0; r < rows.length; r += 1) {
    console.log(rows[r].padEnd(18) + cells[r].map((cell) => cell.padStart(width)).join(''));
  }
}

async function main() {
  console.log('=== webpack --config webpack.cloud-lab.config.js --mode production ===');
  await buildCloudLab();
  mkdirSync(outDir, { recursive: true });

  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'cloud-regime-weather-',
    onEvent, requestTimeoutMs: 300_000,
  });

  // チャンネルの並び・面の大きさはページが持つ。読み取った値を manifest へそのまま写す。
  let probe;
  const allStats = [];
  try {
    await session.devTools.send('Page.navigate', { url: `${session.baseUrl}/weather-probe.html` });
    await waitFor(session.devTools, '!!window.weatherProbe', 'weather probe');
    probe = await session.devTools.evaluate(
      '({ width: window.weatherProbe.width, height: window.weatherProbe.height,'
      + ' channels: [...window.weatherProbe.channels] })');
    console.log(`probe ready: ${probe.width}×${probe.height} × ${probe.channels.length} チャンネル`);
    for (const h of hours) {
      await session.devTools.evaluate(`window.weatherProbe.prepare(${h})`);
      const base64 = await session.devTools.evaluate('window.weatherProbe.readGlobal()');
      const bytes = Buffer.from(base64, 'base64');
      writeFileSync(weatherFile(h), bytes);
      const data = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
      allStats.push({ hours: h, stats: channelStats(data, probe) });
      console.log(`${h} h を書いた(${path.relative(root, weatherFile(h))})`);
    }
  } finally {
    await session.close();
  }
  if (fatalEvents.length > 0) {
    for (const event of fatalEvents) console.error(`[page] ${event}`);
    throw new Error('ページが致命的なイベントを出した');
  }

  const commit = execSync('git rev-parse --short HEAD', { cwd: root, encoding: 'utf8' }).trim();
  // manifest の時刻一覧はディレクトリにある全時刻の和集合を保つ — --hours で一部だけ
  // 書き出しても、残りの時刻を一覧から落とさない。commit かチャンネルの並びが違う
  // manifest の時刻は古い出力なので、ファイルごと捨てて書き直す。
  const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  const compatible = previous !== null && previous.commit === commit
    && JSON.stringify(previous.channels) === JSON.stringify(probe.channels);
  const keepHours = compatible
    ? (previous.hours ?? []).filter((h) => existsSync(weatherFile(h)))
    : [];
  if (previous !== null && !compatible) {
    // 今回書き直した時刻は消さない — そのファイルはもう新しい形式で書かれている。
    for (const h of (previous.hours ?? []).filter((h) => !hours.includes(h))) {
      rmSync(weatherFile(h), { force: true });
    }
  }
  const allHours = [...new Set([...keepHours, ...hours])].sort((a, b) => a - b);
  writeFileSync(manifestPath, `${JSON.stringify({
    tool: 'cloud-regime-weather',
    generatedAt: new Date().toISOString(),
    commit,
    width: probe.width,
    height: probe.height,
    channels: probe.channels,
    hours: allHours,
  })}\n`);
  console.log(`manifest を書いた(${path.relative(root, manifestPath)})`);
  printStatsTable(allStats);
}

// .cloud-detail/regime/generated-weather/h<hours>.f32 を読み、緯度経度 [deg] で双線形補間した
// 全チャンネルの値を返す口を作る。経度は周期、極は端で止める。
export function loadGeneratedWeather(hoursValue) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const { width, height, channels } = manifest;
  const bytes = readFileSync(weatherFile(hoursValue));
  const data = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  const plane = width * height;
  const sampleAt = (latDeg, lonDeg) => {
    // 画素の中心が緯度 +90 − (r + 0.5)·0.5、経度 −180 + (c + 0.5)·0.5。
    const fy = (90 - latDeg) * 2 - 0.5;
    const r0 = Math.max(0, Math.min(height - 2, Math.floor(fy)));
    const ty = Math.max(0, Math.min(1, fy - r0));
    const fx = (lonDeg + 180) * 2 - 0.5;
    const c0f = Math.floor(fx);
    const tx = fx - c0f;
    const c0 = ((c0f % width) + width) % width;
    const c1 = (c0 + 1) % width;
    const out = {};
    channels.forEach((name, c) => {
      const base = c * plane;
      const v00 = data[base + r0 * width + c0];
      const v10 = data[base + r0 * width + c1];
      const v01 = data[base + (r0 + 1) * width + c0];
      const v11 = data[base + (r0 + 1) * width + c1];
      out[name] = (1 - ty) * ((1 - tx) * v00 + tx * v10) + ty * ((1 - tx) * v01 + tx * v11);
    });
    return out;
  };
  return { width, height, channels, sampleAt };
}

// ライブラリとして読み込まれたときは CLI を走らせない。
const invokedAsScript = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
