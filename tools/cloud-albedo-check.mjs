// 雲の白さと光学的厚みの関係を測る道具。render-lab の cloud-albedo ケース(暗い海の上へ
// 一様な雲板を立てて直下から見る合成の場面)をヘッドレス Chrome で撮り、画面中央の領域の
// 平均の表示値をトーンマップの逆写像で放射輝度へ戻し、反射率相当へ換算して、保存散乱の
// 2 流近似(Eddington、Meador & Weaver 1980)の参照曲線と並べる。
//   使い方: node tools/cloud-albedo-check.mjs — 引数は無し。ポートは環境変数
//   CLOUD_DETAIL_PORT・CLOUD_DETAIL_DEBUG_PORT。切り替えは作業ツリー直下の
//   .loop-albedo-config.json(任意)で行う:
//     { "tag": "base",   // 出力先 .cloud-detail/albedo/<tag>/ の名前
//       "build": true }  // false なら webpack を飛ばして既存の .render-lab/ を使う
// 出力は標準出力の表と .cloud-detail/albedo/ 以下の report.md・shots/*.png・metrics.json。
// 雲板の種類は表示時刻の値で選ぶ(tools/render-lab/cloud-albedo-model.ts の VARIANTS の添字)。
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { openChromeSession, sleep, waitFor, collectFatalEvents } from './chrome-session.mjs';
import { decodePng } from './png.mjs';
import {
  ALTITUDE_M, CIRRUS_AMOUNTS, CUMULUS_AMOUNTS, CLEAR_VARIANT, WHITE_VARIANT,
  cirrusTauOf, cumulusTauOf, eddingtonReflectance, REFERENCE_TAUS, ZENITHS_DEG,
} from './render-lab/cloud-albedo-model.ts';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
// ポートは環境変数で渡す(他の計測と衝突しない値を選ぶのは呼び出し側)。
const PORT = Number(process.env.CLOUD_DETAIL_PORT ?? 8849);
const DEBUG_PORT = Number(process.env.CLOUD_DETAIL_DEBUG_PORT ?? 9549);

const configPath = path.join(root, '.loop-albedo-config.json');
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
const outRoot = config.tag === undefined
  ? path.join(root, '.cloud-detail', 'albedo')
  : path.join(root, '.cloud-detail', 'albedo', config.tag);
const shotsDir = path.join(outRoot, 'shots');

const CASE = 'cloud-albedo';
// 測る画面中央の領域 [px]。960×540 の中央 240×140 px ≈ 960×560 km。
const REGION = { x0: 360, y0: 200, x1: 600, y1: 340 };
// 雲の画素を拾う、雲なし画像に対する明るさの下限(表示輝度の比 + 絶対の床)。
const COVER_RATIO = 1.5;
const COVER_FLOOR = 0.01;
// 環境光の照度の比(ambient-source.ts)。反射率相当の cosZ 基準に足す。
const AMBIENT_FRACTION = 0.03;

// 測る条件の組。積雲は大気のあり・なし × 細部の粗・標準、巻雲は大気あり × 細部の粗・標準
// (巻雲は大気パスの中に描かれるので、大気なしでは描かれない)。
const CUMULUS_DETAIL_LEGS = [
  { tag: 'dcoarse', value: 1 },
  { tag: 'dstd', value: 2 },
];
const CIRRUS_DETAIL_LEGS = [
  { tag: 'dcoarse', value: 0 },
  { tag: 'dstd', value: 1 },
];
const ATMO_LEGS = [
  { tag: 'atm0', value: 0 },
  { tag: 'atm3', value: 3 },
];

// 評価で固定する描画品質設定(高プリセットの雲まわり + 測定用の補正なし)。
const GRAPHICS = [
  ['clouds', true], ['cloudFieldSource', 'generated'],
  ['cumulusDetail', 2], ['cirrusDetail', 1],
  ['sunLightModel', 1], ['ambient', true],
  ['lens', false], ['antialias', 0],
];

function buildRenderLab() {
  const cli = path.join(root, 'node_modules', 'webpack-cli', 'bin', 'cli.js');
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [cli, '--config', 'webpack.render-lab.config.js', '--mode', 'production'],
      { cwd: root, stdio: 'inherit' },
    );
    child.on('exit', (code) => (
      code === 0 ? resolve() : reject(new Error(`webpack exited with code ${code}`))
    ));
    child.on('error', reject);
  });
}

// 絵が落ち着くまで撮り直す(連続 2 回の一致で判定)。
async function captureSettled(evaluate, label) {
  let previous = await evaluate('window.renderLab.capture()');
  for (let count = 0; count < 6; count++) {
    await sleep(150);
    const next = await evaluate('window.renderLab.capture()');
    if (next === previous) return next;
    previous = next;
  }
  throw new Error(`${label}: capture did not settle`);
}

const dataUrlToPng = (url) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');

// sRGB 8bit → 線形(逆ガンマだけ)。
const lin = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

// ニュートラルトーンマップ(Khronos PBR Neutral)の圧縮開始点と、彩度床として全チャネルから
// 引かれる量。cloud-detail-features.mjs と同じ値。
const NEUTRAL_COMPRESSION_START = 0.76;
const NEUTRAL_DESATURATION_FLOOR = 0.04;
const NEUTRAL_INVERSE_INPUT_MAX = 0.98;

// 表示用の値を、トーンマップ前の放射輝度相当へ戻す(cloud-detail-features.mjs の写し)。
// チャネルごとに掛けるので、色つきの画素では近似になる — ほぼ無彩色の雲と白い面では誤差が小さい。
function invertNeutralDisplay(value) {
  const s = NEUTRAL_COMPRESSION_START;
  const d = 1 - s;
  const peak = value > s
    ? (s - d) + (d * d) / (1 - Math.min(value, NEUTRAL_INVERSE_INPUT_MAX))
    : value;
  return peak >= NEUTRAL_DESATURATION_FLOOR ? peak + NEUTRAL_DESATURATION_FLOOR : Math.sqrt(peak / 6.25);
}

// PNG の中央領域の表示値の平均と、トーンマップ逆写像後の放射輝度の平均を返す。
function measureRegion(png) {
  const { width, height, channels, data } = png;
  let r = 0, g = 0, b = 0, count = 0;
  for (let y = REGION.y0; y < Math.min(REGION.y1, height); y++) {
    for (let x = REGION.x0; x < Math.min(REGION.x1, width); x++) {
      const o = (y * width + x) * channels;
      r += lin(data[o]);
      g += lin(data[o + 1]);
      b += lin(data[o + 2]);
      count++;
    }
  }
  const display = [r / count, g / count, b / count];
  const radiance = display.map(invertNeutralDisplay);
  return {
    display,
    radiance,
    lum: 0.2126 * radiance[0] + 0.7152 * radiance[1] + 0.0722 * radiance[2],
  };
}

// 中央領域のうち、雲なし画像より COVER_RATIO 倍(床 COVER_FLOOR)明るい画素の割合。
// display は表示輝度で比べる — トーンマップは単調なので覆いの判定はどちらの域でも同じ。
function coveredFraction(png, clearDisplayLum) {
  const { width, height, channels, data } = png;
  const threshold = clearDisplayLum * COVER_RATIO + COVER_FLOOR;
  let covered = 0, count = 0;
  for (let y = REGION.y0; y < Math.min(REGION.y1, height); y++) {
    for (let x = REGION.x0; x < Math.min(REGION.x1, width); x++) {
      const o = (y * width + x) * channels;
      const lum = 0.2126 * lin(data[o]) + 0.7152 * lin(data[o + 1]) + 0.0722 * lin(data[o + 2]);
      if (lum > threshold) covered++;
      count++;
    }
  }
  return covered / count;
}

const displayLum = (m) => 0.2126 * m.display[0] + 0.7152 * m.display[1] + 0.0722 * m.display[2];
const cosZ = (zenithDeg) => Math.cos(zenithDeg * Math.PI / 180);
const f2 = (v) => v.toFixed(2);
const f3 = (v) => v.toFixed(3);

async function main() {
  if (config.build !== false || !existsSync(path.join(buildDir, 'index.html'))) {
    console.log('=== webpack --config webpack.render-lab.config.js --mode production ===');
    await buildRenderLab();
  }
  mkdirSync(shotsDir, { recursive: true });
  const { onEvent, fatalEvents } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port: PORT, debugPort: DEBUG_PORT,
    profilePrefix: 'tepui-cloud-albedo-', onEvent,
    requestTimeoutMs: 120_000,
  });
  const metrics = [];
  const baselines = {};
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    await waitFor(devTools, 'typeof window.renderLab?.capture === "function"', 'renderLab API');
    const evaluate = devTools.evaluate.bind(devTools);
    const setG = (key, value) => evaluate(
      `window.renderLab.setGraphicsOption(${JSON.stringify(key)}, ${JSON.stringify(value)})`);
    // 直下点の上は描画座標の +Z。仰角は水平面から測るので、天頂角 zenith には 90 − zenith を渡す。
    const setView = (zenithDeg) => evaluate(
      `window.renderLab.setView(${JSON.stringify({ sunAzimuthDeg: 0, sunElevationDeg: 90 - zenithDeg })})`);
    const setVariant = (index) => evaluate(`window.renderLab.setDisplayTime(${index})`);

    for (const [key, value] of GRAPHICS) await setG(key, value);
    await evaluate(`window.renderLab.show(${JSON.stringify(CASE)})`);

    const shoot = async (name, variant) => {
      await setVariant(variant);
      const url = await captureSettled(evaluate, name);
      const buf = dataUrlToPng(url);
      writeFileSync(path.join(shotsDir, `${name}.png`), buf);
      const png = decodePng(buf);
      return { png, measure: measureRegion(png) };
    };

    // 雲なし(海だけ)と白い拡散面の基準。大気の段と天頂角ごとに撮る。
    await setG('clouds', false);
    for (const atmo of ATMO_LEGS) {
      await setG('atmosphere', atmo.value);
      for (const zenith of ZENITHS_DEG) {
        await setView(zenith);
        baselines[`${atmo.tag}-z${zenith}`] = {
          clear: (await shoot(`clear-z${zenith}-${atmo.tag}`, CLEAR_VARIANT)).measure,
          white: (await shoot(`white-z${zenith}-${atmo.tag}`, WHITE_VARIANT)).measure,
        };
      }
    }
    await setG('clouds', true);

    // 積雲の板。大気のあり・なし × 細部の粗・標準 × 天頂角で量を掃引する。
    await setG('cumulus', true);
    await setG('cirrus', false);
    for (const atmo of ATMO_LEGS) {
      await setG('atmosphere', atmo.value);
      for (const detail of CUMULUS_DETAIL_LEGS) {
        await setG('cumulusDetail', detail.value);
        for (const zenith of ZENITHS_DEG) {
          await setView(zenith);
          for (const [i, amount] of CUMULUS_AMOUNTS.entries()) {
            const name = `cu-a${String(Math.round(amount * 100)).padStart(3, '0')}-z${zenith}-${atmo.tag}-${detail.tag}`;
            const { png, measure } = await shoot(name, i);
            const baseline = baselines[`${atmo.tag}-z${zenith}`];
            metrics.push({
              name, kind: 'cumulus', amount, tau: cumulusTauOf(amount), zenithDeg: zenith,
              atmosphere: atmo.value, detail: detail.tag, ...measure,
              covered: coveredFraction(png, displayLum(baseline.clear)),
              rWhite: measure.lum / baseline.white.lum,
              rCosZ: measure.lum / (cosZ(zenith) + AMBIENT_FRACTION),
            });
          }
        }
      }
    }

    // 巻雲の板。大気の中へ立つ殻なので大気ありだけ。細部の粗・標準 × 天頂角で量を掃引する。
    await setG('atmosphere', 3);
    await setG('cumulus', false);
    await setG('cirrus', true);
    for (const detail of CIRRUS_DETAIL_LEGS) {
      await setG('cirrusDetail', detail.value);
      for (const zenith of ZENITHS_DEG) {
        await setView(zenith);
        for (const [i, amount] of CIRRUS_AMOUNTS.entries()) {
          const name = `ci-a${String(Math.round(amount * 100)).padStart(3, '0')}-z${zenith}-atm3-${detail.tag}`;
          const { measure } = await shoot(name, CUMULUS_AMOUNTS.length + i);
          const baseline = baselines[`atm3-z${zenith}`];
          metrics.push({
            name, kind: 'cirrus', amount, tau: cirrusTauOf(amount), zenithDeg: zenith,
            atmosphere: 3, detail: detail.tag, ...measure,
            covered: null,
            rWhite: measure.lum / baseline.white.lum,
            rCosZ: measure.lum / (cosZ(zenith) + AMBIENT_FRACTION),
          });
        }
      }
    }
  } finally {
    await session.close();
  }

  const gOf = { cumulus: 0.85, cirrus: 0.75 };
  const refOf = (kind, tau, zenithDeg) => eddingtonReflectance(tau, cosZ(zenithDeg), gOf[kind]);

  // 表を組む。行 = 雲の量(τ)、列 = 天頂角ごとの R(描画)・R_ref・比。
  const lines = [];
  lines.push('# 雲の白さと光学的厚み(描画器の計測)');
  lines.push('');
  lines.push(`場面: 暗い海の上の一様な雲板を直下から見る(高度 ${(ALTITUDE_M / 1e3).toFixed(0)} km、中心で 4 km/px)。`
    + `領域は画面中央 ${REGION.x1 - REGION.x0}×${REGION.y1 - REGION.y0} px。`);
  lines.push('条件: レンズ効果なし・アンチエイリアスなし・環境光あり・球光源・恒星距離 1 AU。'
    + 'atm0 は大気パスを切った条件(衛星画像と同じ条件は atm3)。');
  lines.push('R = 領域平均の放射輝度 / 同じ条件で撮った拡散反射率 1 の面の放射輝度。'
    + `括弧内は L/(cosZ + ${AMBIENT_FRACTION}) 基準の値。cover は雲なしより明るい画素の割合。`);
  lines.push('');
  lines.push('## 基準(雲なしの海と白い面の放射輝度)');
  lines.push('');
  lines.push('| 条件 | L(海) | L(白) | 海/白 | 白 ÷ (cosZ+0.03) |');
  lines.push('| --- | ---: | ---: | ---: | ---: |');
  for (const atmo of ATMO_LEGS) {
    for (const zenith of ZENITHS_DEG) {
      const b = baselines[`${atmo.tag}-z${zenith}`];
      lines.push(`| ${atmo.tag} z${zenith} | ${f3(b.clear.lum)} | ${f3(b.white.lum)}`
        + ` | ${f3(b.clear.lum / b.white.lum)} | ${f3(b.white.lum / (cosZ(zenith) + AMBIENT_FRACTION))} |`);
    }
  }

  // 雲の種類 × 条件ごとの表。
  const legRows = (kind, rows) => {
    const kinds = { cumulus: '積雲', cirrus: '巻雲' };
    const amounts = kind === 'cumulus' ? CUMULUS_AMOUNTS : CIRRUS_AMOUNTS;
    const tauOf = kind === 'cumulus' ? cumulusTauOf : cirrusTauOf;
    const out = [];
    out.push('');
    out.push(`| 量 | τ | cover | R(z30) | ref | 比 | R(z60) | ref | 比 | R/B(z30) |`);
    out.push('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const [i, amount] of amounts.entries()) {
      const tau = tauOf(amount);
      const cells = [];
      for (const zenith of ZENITHS_DEG) {
        const row = rows.find((r) => r.amount === amount && r.zenithDeg === zenith);
        const ref = refOf(kind, tau, zenith);
        cells.push(row === undefined
          ? ['—', f3(ref), '—']
          : [f3(row.rWhite), f3(ref), f2(row.rWhite / ref)]);
      }
      const row30 = rows.find((r) => r.amount === amount && r.zenithDeg === ZENITHS_DEG[0]);
      const cover = row30?.covered === null || row30?.covered === undefined ? '—' : f2(row30.covered);
      const rb = row30 === undefined ? '—' : f3(row30.radiance[0] / Math.max(row30.radiance[2], 1e-9));
      out.push(`| ${amount} | ${tau.toFixed(2)} | ${cover} | ${cells.flat().join(' | ')} | ${rb} |`);
    }
    return out;
  };

  for (const atmo of ATMO_LEGS) {
    for (const detail of CUMULUS_DETAIL_LEGS) {
      lines.push('');
      lines.push(`## 積雲(${atmo.tag}・細部 ${detail.tag})`);
      lines.push(...legRows('cumulus',
        metrics.filter((m) => m.kind === 'cumulus' && m.atmosphere === atmo.value && m.detail === detail.tag)));
    }
  }
  for (const detail of CIRRUS_DETAIL_LEGS) {
    lines.push('');
    lines.push(`## 巻雲(atm3・細部 ${detail.tag})`);
    lines.push(...legRows('cirrus',
      metrics.filter((m) => m.kind === 'cirrus' && m.detail === detail.tag)));
  }

  // 参照曲線。描画器の届く上限(τ ≈ 8.3)の外も並べる。
  lines.push('');
  lines.push('## 参照曲線(Eddington・保存散乱)');
  lines.push('');
  lines.push('| τ | g=0.85 z30 | g=0.85 z60 | g=0.75 z30 | g=0.75 z60 |');
  lines.push('| ---: | ---: | ---: | ---: | ---: |');
  for (const tau of REFERENCE_TAUS) {
    lines.push(`| ${tau} | ${f3(eddingtonReflectance(tau, cosZ(30), 0.85))}`
      + ` | ${f3(eddingtonReflectance(tau, cosZ(60), 0.85))}`
      + ` | ${f3(eddingtonReflectance(tau, cosZ(30), 0.75))}`
      + ` | ${f3(eddingtonReflectance(tau, cosZ(60), 0.75))} |`);
  }

  // τ を 2 倍にしたときの R の比(描画と参照)。描画側は log-log の線形補間。
  const doubleRatio = (rows, tau) => {
    const sorted = rows.slice().sort((a, b) => a.tau - b.tau);
    const at = (t) => {
      const above = sorted.find((r) => r.tau >= t);
      const below = [...sorted].reverse().find((r) => r.tau <= t);
      if (above === undefined || below === undefined) return null;
      if (above === below) return above.rWhite;
      const w = Math.log(t / below.tau) / Math.log(above.tau / below.tau);
      return below.rWhite * (above.rWhite / below.rWhite) ** w;
    };
    const a = at(tau), b = at(2 * tau);
    return a === null || b === null || a <= 0 ? null : b / a;
  };
  lines.push('');
  lines.push('## τ を 2 倍にしたときの R の比(τ → 2τ)');
  lines.push('');
  lines.push('| 条件 | τ | 描画 | 参照 |');
  lines.push('| --- | ---: | ---: | ---: |');
  const doublingLegs = [
    ['積雲 atm3 dstd', metrics.filter((m) => m.kind === 'cumulus' && m.atmosphere === 3 && m.detail === 'dstd' && m.zenithDeg === 30), 'cumulus'],
    ['積雲 atm3 dcoarse', metrics.filter((m) => m.kind === 'cumulus' && m.atmosphere === 3 && m.detail === 'dcoarse' && m.zenithDeg === 30), 'cumulus'],
    ['積雲 atm0 dstd', metrics.filter((m) => m.kind === 'cumulus' && m.atmosphere === 0 && m.detail === 'dstd' && m.zenithDeg === 30), 'cumulus'],
    ['巻雲 atm3 dstd', metrics.filter((m) => m.kind === 'cirrus' && m.detail === 'dstd' && m.zenithDeg === 30), 'cirrus'],
  ];
  for (const [label, rows, kind] of doublingLegs) {
    for (const tau of [0.2, 0.4, 0.8, 1.5, 3]) {
      const measured = doubleRatio(rows, tau);
      const ref = refOf(kind, 2 * tau, 30) / refOf(kind, tau, 30);
      lines.push(`| ${label} z30 | ${tau} | ${measured === null ? '—' : f2(measured)} | ${f2(ref)} |`);
    }
  }

  // 読み取れること。飽和は「最大の 95% へ届く最初の τ」で見る。
  const saturateTau = (rows) => {
    const sorted = rows.slice().sort((a, b) => a.tau - b.tau);
    const maxR = Math.max(...sorted.map((r) => r.rWhite));
    const first = sorted.find((r) => r.rWhite >= 0.95 * maxR);
    return { tau: first?.tau, maxR };
  };
  lines.push('');
  lines.push('## 読み取れること');
  const cuStd = metrics.filter((m) => m.kind === 'cumulus' && m.atmosphere === 3 && m.detail === 'dstd' && m.zenithDeg === 30);
  const cuOff = metrics.filter((m) => m.kind === 'cumulus' && m.atmosphere === 0 && m.detail === 'dstd' && m.zenithDeg === 30);
  const ciStd = metrics.filter((m) => m.kind === 'cirrus' && m.detail === 'dstd' && m.zenithDeg === 30);
  for (const [label, rows, kind] of [['積雲 atm3 dstd z30', cuStd, 'cumulus'], ['積雲 atm0 dstd z30', cuOff, 'cumulus'], ['巻雲 atm3 dstd z30', ciStd, 'cirrus']]) {
    if (rows.length === 0) continue;
    const { tau, maxR } = saturateTau(rows);
    const tail = rows.find((r) => Math.abs(r.tau - Math.max(...rows.map((x) => x.tau))) < 1e-9);
    const refTail = refOf(kind, tail.tau, 30);
    lines.push(`- ${label}: R は最大 ${f3(maxR)} で、95% へ届くのは τ ≈ ${tau}。`
      + `掃引の端 τ=${tail.tau.toFixed(2)} では 描画 ${f3(tail.rWhite)}・参照 ${f3(refTail)}(比 ${f2(tail.rWhite / refTail)})。`);
  }
  lines.push(`- 積雲の上限 τ≈8.3 は参照曲線では R_ref ≈ ${f3(eddingtonReflectance(8.33, cosZ(30), 0.85))}(z30)`
    + `・${f3(eddingtonReflectance(8.33, cosZ(60), 0.85))}(z60) — τ = 30〜100 の厚い雲は`
    + ` R_ref ≈ ${f3(eddingtonReflectance(30, cosZ(30), 0.85))}〜${f3(eddingtonReflectance(100, cosZ(30), 0.85))}。`);

  const report = `${lines.join('\n')}\n`;
  console.log(report);
  writeFileSync(path.join(outRoot, 'report.md'), report);
  writeFileSync(path.join(outRoot, 'metrics.json'),
    `${JSON.stringify({ baselines, metrics, region: REGION, altitudeM: ALTITUDE_M }, null, 2)}\n`);
  if (fatalEvents.length > 0) {
    console.error('fatal page events:', fatalEvents);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
