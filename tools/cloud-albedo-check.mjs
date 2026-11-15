// 雲の白さ・下地の隠れ方・影の濃さが同じ光学的厚みから釣り合っているかを測る道具。
// render-lab の cloud-albedo ケース(暗い海・白い拡散面の上へ一様な雲板を立てて直下から
// 見る合成の場面)をヘッドレス Chrome で撮り、画面中央の領域の平均の表示値をトーン
// マップの逆写像で放射輝度へ戻し、保存散乱の 2 流近似(Eddington、Meador & Weaver
// 1980)の参照 R = γτ/(1+γτ) と比べて PASS/FAIL を出す。
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
  ALTITUDE_M, CIRRUS_AMOUNTS, CIRRUS_OCEAN_VARIANTS, CIRRUS_WHITE_VARIANTS,
  CUMULUS_AMOUNTS, CUMULUS_OCEAN_VARIANTS, CUMULUS_WHITE_VARIANTS,
  CLEAR_VARIANT, WHITE_VARIANT, DETAIL_TOP_RELIEF_M,
  cirrusTauOf, cloudReflectance, cumulusCoverOf, cumulusTauOf, cumulusTauOfTop,
  cumulusThicknessOf, cumulusTopAltitudeOf, REFERENCE_TAUS, ZENITHS_DEG,
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
// 判定の許容差。反射率は |差| ≤ 0.08、影は |差| ≤ 0.1。
const ALBEDO_TOLERANCE = 0.08;
const SHADOW_TOLERANCE = 0.1;
// 影の測定に使う白い面の上の積雲の量。覆う割合が空く量から覆い尽くす量まで。
const CUMULUS_WHITE_AMOUNTS = [0.05, 0.15, 0.24, 0.35];
// 非対称因子(種類ごと)。cloud-optics.ts の定数と同じ値。
const G_OF = { cumulus: 0.85, cirrus: 0.75 };

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

    // 積雲の板。大気のあり・なし × 細部の粗・標準 × 天頂角で量を掃引する。海の行に加えて、
    // 標準の細部では白い面の上の雲も撮って影の濃さを測る(同じ量で下地だけ白へ変えた組)。
    // **海の行の間は雲の影を切る** — 板の下の海が影で暗くなると「覆っていない画素 = 雲なし」の
    // 前提が崩れて反射率を過小に読む。影は白い面の行でだけ入れる。
    await setG('cloudShadow', false);
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
            const { png, measure } = await shoot(name, CUMULUS_OCEAN_VARIANTS + i);
            const baseline = baselines[`${atmo.tag}-z${zenith}`];
            const covered = coveredFraction(png, displayLum(baseline.clear));
            metrics.push({
              name, kind: 'cumulus', amount, tau: cumulusTauOf(amount), zenithDeg: zenith,
              atmosphere: atmo.value, detail: detail.tag, ...measure,
              covered, rWhite: measure.lum / baseline.white.lum,
            });
            if (detail.tag === 'dstd' && CUMULUS_WHITE_AMOUNTS.includes(amount)) {
              await setG('cloudShadow', true);
              const white = await shoot(`${name}-white`, CUMULUS_WHITE_VARIANTS + i);
              await setG('cloudShadow', false);
              // 影を落とさない同じ画も撮る — 2 枚の差から、雲の下の地表へ届く光が解ける。
              const open = await shoot(`${name}-wopen`, CUMULUS_WHITE_VARIANTS + i);
              metrics.push({
                name: `${name}-white`, kind: 'cumulus-shadow', amount, tau: cumulusTauOf(amount),
                zenithDeg: zenith, atmosphere: atmo.value, detail: detail.tag, ...white.measure,
                covered, lumOpen: open.measure.lum,
                rWhite: white.measure.lum / baseline.white.lum,
              });
            }
          }
        }
      }
    }

    // 巻雲の板。大気の中へ立つ殻なので大気ありだけ。細部の粗・標準 × 天頂角で量を掃引する。
    // 標準の細部では白い面の上の巻雲も撮る。
    await setG('atmosphere', 3);
    await setG('cumulus', false);
    await setG('cirrus', true);
    for (const detail of CIRRUS_DETAIL_LEGS) {
      await setG('cirrusDetail', detail.value);
      for (const zenith of ZENITHS_DEG) {
        await setView(zenith);
        for (const [i, amount] of CIRRUS_AMOUNTS.entries()) {
          const name = `ci-a${String(Math.round(amount * 100)).padStart(3, '0')}-z${zenith}-atm3-${detail.tag}`;
          const { measure } = await shoot(name, CIRRUS_OCEAN_VARIANTS + i);
          const baseline = baselines[`atm3-z${zenith}`];
          metrics.push({
            name, kind: 'cirrus', amount, tau: cirrusTauOf(amount), zenithDeg: zenith,
            atmosphere: 3, detail: detail.tag, ...measure,
            covered: null, rWhite: measure.lum / baseline.white.lum,
          });
          if (detail.tag === 'dstd') {
            await setG('cloudShadow', true);
            const white = await shoot(`${name}-white`, CIRRUS_WHITE_VARIANTS + i);
            await setG('cloudShadow', false);
            metrics.push({
              name: `${name}-white`, kind: 'cirrus-shadow', amount, tau: cirrusTauOf(amount),
              zenithDeg: zenith, atmosphere: 3, detail: detail.tag, ...white.measure,
              covered: null, rWhite: white.measure.lum / baseline.white.lum,
            });
          }
        }
      }
    }
  } finally {
    await session.close();
  }

  const refOf = (kind, tau) => cloudReflectance(tau, G_OF[kind]);
  const judge = (diff, tolerance) => (Math.abs(diff) <= tolerance ? 'PASS' : 'FAIL');
  const verdicts = [];

  // 雲なしの基準を差し引いた反射率の推定値。積雲は覆っていない画素ぶんだけ海が漏れるので
  // rDiff = (L − (1−cover)·L_clear)/L_white。巻雲は層を透けた下地が全域で混ざるので
  // R_est = (L − L_clear)/(L_white − L_clear)。
  const estimate = (row) => {
    const baseline = baselines[`${row.atmosphere === 0 ? 'atm0' : 'atm3'}-z${row.zenithDeg}`];
    if (row.kind === 'cumulus') {
      const cover = row.covered ?? cumulusCoverOf(row.amount);
      const rDiff = (row.lum - (1 - cover) * baseline.clear.lum) / baseline.white.lum;
      const expected = cover * refOf('cumulus', row.tau);
      // 覆う割合が 1 未満の列では、ディザで選ばれた柱の雲頂が細部の起伏ぶん持ち上がるので、
      // 画素の明るさは基準の雲頂の R より高い側へ寄る。判定の帯は [cover·R(τ_in),
      // cover·R(τ_in(雲頂 + 細部の起伏上限))] で、覆う割合 ≈ 1 の列は帯の下端へ厳密に合わせる。
      const top = cumulusTopAltitudeOf(row.amount);
      const hi = cover * cloudReflectance(cumulusTauOfTop(top + DETAIL_TOP_RELIEF_M), G_OF.cumulus);
      const banded = cover < 0.95;
      const verdict = banded
        ? (rDiff >= expected - ALBEDO_TOLERANCE && rDiff <= hi + ALBEDO_TOLERANCE ? 'PASS' : 'FAIL')
        : judge(rDiff - expected, ALBEDO_TOLERANCE);
      return { rEst: rDiff, expected, hi, banded, diff: rDiff - expected, verdict };
    }
    if (row.kind === 'cirrus') {
      const rEst = (row.lum - baseline.clear.lum) / (baseline.white.lum - baseline.clear.lum);
      const expected = refOf('cirrus', row.tau);
      return { rEst, expected, diff: rEst - expected, verdict: judge(rEst - expected, ALBEDO_TOLERANCE) };
    }
    return null;
  };

  // 白い面の上の雲の行と、同じ量の海の行の組を探す(雲自身が返す光の測定値)。
  const oceanRowOf = (row) => metrics.find((m) => (
    m.kind === row.kind.replace('-shadow', '')
    && m.amount === row.amount && m.zenithDeg === row.zenithDeg
    && m.atmosphere === row.atmosphere && m.detail === row.detail
  ));

  // 白い面の上の雲の行から、雲の下の地表の明るさを解く。画面の明るさから雲自身が返す光
  // (海の行で測った分)を差し引いた残りが、雲の下を照らす光で照らされた地表ぶん。
  // 積雲の期待値は 1 − 柱が返す光の平均(同じ光学的厚みで返す光と抜ける光が釣り合うので、
  // 覆う割合 × R の測定値をそのまま使う)。巻雲は太陽側の斜めの光路の厚みで 1 − R(τ·slant)。
  const shadowRatioOf = (row) => {
    const baseline = baselines[`${row.atmosphere === 0 ? 'atm0' : 'atm3'}-z${row.zenithDeg}`];
    const w = row.lum / baseline.white.lum;
    const ocean = oceanRowOf(row);
    if (row.kind === 'cumulus-shadow') {
      const cover = row.covered ?? cumulusCoverOf(row.amount);
      if (ocean === undefined || row.lumOpen === undefined) return null;
      const rDiff = (ocean.lum - (1 - cover) * baseline.clear.lum) / baseline.white.lum;
      const wOpen = row.lumOpen / baseline.white.lum;
      // 地表が張る輝度ぶん = 画面の輝度 − 雲の返す光。影あり・なしの 2 枚でその比を取ると、
      // 覆う画素の割合を知らなくても雲の下の地表へ届く光の割合が出る(雲の画素は両方で同じ)。
      // ほぼ覆い尽くす量では地表ぶんが雲の推定値の誤差より小さく潰れるので対象外にする。
      if (wOpen - rDiff < 0.03) return null;
      const ratio = (w - rDiff) / (wOpen - rDiff);
      const expected = 1 - rDiff;
      const spec = 1 - cover * refOf('cumulus', row.tau);
      return { ratio, expected, spec, diff: ratio - expected };
    }
    if (row.kind === 'cirrus-shadow') {
      if (ocean === undefined) return null;
      const cw = baseline.clear.lum / baseline.white.lum;
      const rEst = (ocean.lum - baseline.clear.lum) / (baseline.white.lum - baseline.clear.lum);
      // 層の上の輝度 = 雲の返す光 + 視線の透過 × 地表の明るさ。雲の返す光は海の行の測定値に、
      // 海が隠れて足りない分(視線の R × 海の明るさ)を足したもの。
      const rView = refOf('cirrus', row.tau);
      const cloudRad = rEst * (1 - cw) + rView * cw;
      const ratio = (w - cloudRad) / Math.max(1 - rView, 1e-3);
      const expected = 1 - rView;
      return { ratio, expected, diff: ratio - expected };
    }
    return null;
  };

  // 表を組む。行 = 雲の量(τ_in / τ)、列 = 天頂角ごとの R 測定・参照・差・判定。
  const lines = [];
  lines.push('# 雲の白さと光学的厚み(描画器の計測)');
  lines.push('');
  lines.push(`場面: 暗い海の上の一様な雲板を直下から見る(高度 ${(ALTITUDE_M / 1e3).toFixed(0)} km、中心で 4 km/px)。`
    + `領域は画面中央 ${REGION.x1 - REGION.x0}×${REGION.y1 - REGION.y0} px。`);
  lines.push('条件: レンズ効果なし・アンチエイリアスなし・環境光あり・球光源・恒星距離 1 AU。'
    + 'atm0 は大気パスを切った条件(衛星画像と同じ条件は atm3)。');
  lines.push('積雲: R測 = (L − (1−cover)·L_clear)/L_white。巻雲: R測 = (L − L_clear)/(L_white − L_clear)。'
    + `参照は保存散乱 2 流近似 R = γτ/(1+γτ)(g: 積雲 ${G_OF.cumulus}・巻雲 ${G_OF.cirrus})。`
    + `判定は |差| ≤ ${ALBEDO_TOLERANCE}。覆う割合が 1 未満の積雲の行は、ディザで選ばれた柱の`
    + '雲頂が細部の起伏ぶん持ち上がるので、ref 欄は帯 [cover·R(τ_in) 〜 cover·R(τ_in(雲頂+起伏))] '
    + 'で判定する(覆う割合 ≈ 1 の行だけ帯の下端へ厳密に合わせる)。');
  lines.push('');
  lines.push('## 基準(雲なしの海と白い面の放射輝度)');
  lines.push('');
  lines.push('| 条件 | L(海) | L(白) | 海/白 |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const atmo of ATMO_LEGS) {
    for (const zenith of ZENITHS_DEG) {
      const b = baselines[`${atmo.tag}-z${zenith}`];
      lines.push(`| ${atmo.tag} z${zenith} | ${f3(b.clear.lum)} | ${f3(b.white.lum)}`
        + ` | ${f3(b.clear.lum / b.white.lum)} |`);
    }
  }

  // 積雲は量 → 雲頂・厚み・τ_in の系列を先に出す。
  lines.push('');
  lines.push('## 積雲の量 → 雲頂高度 → 幾何学的厚み → τ_in');
  lines.push('');
  lines.push('| 量 | 雲頂 [km] | 厚み [km] | τ_in | 覆う割合(式) | R(τ_in, 0.85) |');
  lines.push('| ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const amount of CUMULUS_AMOUNTS) {
    lines.push(`| ${amount} | ${f2(cumulusTopAltitudeOf(amount) / 1e3)}`
      + ` | ${f2(cumulusThicknessOf(amount) / 1e3)} | ${f2(cumulusTauOf(amount))}`
      + ` | ${f2(cumulusCoverOf(amount))} | ${f3(refOf('cumulus', cumulusTauOf(amount)))} |`);
  }

  // 雲の種類 × 条件ごとの表。
  const legRows = (kind, rows) => {
    const amounts = kind === 'cumulus' ? CUMULUS_AMOUNTS : CIRRUS_AMOUNTS;
    const tauOf = kind === 'cumulus' ? cumulusTauOf : cirrusTauOf;
    const out = [];
    out.push('');
    if (kind === 'cumulus') {
      out.push('| 量 | 雲頂 km | 厚み km | τ_in | cover | R測(z30) | ref | 差 | 判定 | R測(z60) | ref | 差 | 判定 |');
      out.push('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- |');
    } else {
      out.push('| 量 | τ | R測(z30) | ref | 差 | 判定 | R測(z60) | ref | 差 | 判定 |');
      out.push('| ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- |');
    }
    for (const amount of amounts) {
      const cells = [];
      for (const zenith of ZENITHS_DEG) {
        const row = rows.find((r) => r.amount === amount && r.zenithDeg === zenith);
        if (row === undefined) {
          cells.push(kind === 'cumulus' ? ['—', '—', '—', '—'] : ['—', '—', '—', '—']);
          continue;
        }
        const est = estimate(row);
        verdicts.push({ name: row.name, verdict: est.verdict, diff: est.diff });
        const ref = est.banded ? `${f3(est.expected)}〜${f3(est.hi)}` : f3(est.expected);
        cells.push([f3(est.rEst), ref, f3(est.diff), est.verdict]);
      }
      if (kind === 'cumulus') {
        const row30 = rows.find((r) => r.amount === amount && r.zenithDeg === ZENITHS_DEG[0]);
        const cover = row30?.covered === null || row30?.covered === undefined ? '—' : f2(row30.covered);
        out.push(`| ${amount} | ${f2(cumulusTopAltitudeOf(amount) / 1e3)}`
          + ` | ${f2(cumulusThicknessOf(amount) / 1e3)} | ${f2(cumulusTauOf(amount))}`
          + ` | ${cover} | ${cells.flat().join(' | ')} |`);
      } else {
        out.push(`| ${amount} | ${tauOf(amount).toFixed(2)} | ${cells.flat().join(' | ')} |`);
      }
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

  // 影: 白い面の上の雲の行から、雲の下の地表の明るさ比と 1 − R の差。
  const shadowRows = metrics.filter((m) => m.kind.endsWith('-shadow'));
  if (shadowRows.length > 0) {
    lines.push('');
    lines.push('## 影(白い面の上の雲板の下の地表の明るさ)');
    lines.push('');
    lines.push('積雲: 影あり・なしの白地ショット 2 枚から雲の返す光(海の行)を引いた地表ぶんの比'
      + ' (L影 − 雲)/(Lなし − 雲) を、雲の下の地表へ届く光の割合とみなす。柱ごとの期待は'
      + ' 1 − 柱が返す光の平均(海の行の測定値。spec 列は cover·R(τ_in) の形だけの近似)。'
      + '**判定は単調性** — 破れた雲の影は、疎な塔では斜光が隙間を抜いて 1−R より浅く、'
      + '密な板では隣の柱を連続して横切って 1−R より深いので、量に対する単調減少だけを見る。'
      + '巻雲: 層の上の輝度から雲の返す光と視線の透過を除いて地表の明るさへ割り戻し、'
      + `1 − R(τ) と比べる。判定は巻雲の |差| ≤ ${SHADOW_TOLERANCE} と積雲の単調性。`);
    lines.push('');
    lines.push('| 種類 | 量 | 条件 | 地表比 | 期待 | spec | 差 | 判定 |');
    lines.push('| --- | ---: | --- | ---: | ---: | ---: | ---: | --- |');
    const kinds = { 'cumulus-shadow': '積雲', 'cirrus-shadow': '巻雲' };
    const cumulusLegs = new Map();
    for (const row of shadowRows) {
      const est = shadowRatioOf(row);
      const cond = `z${row.zenithDeg} ${row.atmosphere === 0 ? 'atm0' : 'atm3'}`;
      if (est === null) {
        lines.push(`| ${kinds[row.kind]} | ${row.amount} | ${cond} | — | — | — | — | 対象外 |`);
        continue;
      }
      if (row.kind === 'cumulus-shadow') {
        const key = cond;
        if (!cumulusLegs.has(key)) cumulusLegs.set(key, []);
        cumulusLegs.get(key).push({ amount: row.amount, ratio: est.ratio });
        lines.push(`| ${kinds[row.kind]} | ${row.amount} | ${cond}`
          + ` | ${f3(est.ratio)} | ${f3(est.expected)} | ${f3(est.spec)} | ${f3(est.diff)} | 参考 |`);
        continue;
      }
      const verdict = judge(est.diff, SHADOW_TOLERANCE);
      verdicts.push({ name: row.name, verdict, diff: est.diff });
      lines.push(`| ${kinds[row.kind]} | ${row.amount} | ${cond}`
        + ` | ${f3(est.ratio)} | ${f3(est.expected)} | — | ${f3(est.diff)} | ${verdict} |`);
    }
    // 積雲の影の判定: 条件ごとに、量が増えるほど地表へ届く光が減ること。
    for (const [cond, entries] of cumulusLegs) {
      const sorted = entries.sort((a, b) => a.amount - b.amount);
      const monotone = sorted.every((e, i) => i === 0 || e.ratio <= sorted[i - 1].ratio + 0.02);
      const verdict = monotone ? 'PASS' : 'FAIL';
      verdicts.push({ name: `cumulus-shadow-monotonic ${cond}`, verdict, diff: monotone ? 0 : 1 });
      lines.push(`| 積雲 | — | ${cond} 単調性 | ${sorted.map((e) => f3(e.ratio)).join(' → ')}`
        + ` | — | — | — | ${verdict} |`);
    }
  }

  // 参照曲線。届く範囲の外側も並べる。
  lines.push('');
  lines.push('## 参照曲線(保存散乱 2 流近似 R = γτ/(1+γτ))');
  lines.push('');
  lines.push('| τ | g=0.85 | g=0.75 |');
  lines.push('| ---: | ---: | ---: |');
  for (const tau of REFERENCE_TAUS) {
    lines.push(`| ${tau} | ${f3(cloudReflectance(tau, 0.85))} | ${f3(cloudReflectance(tau, 0.75))} |`);
  }

  // 合否のまとめ。
  const fails = verdicts.filter((v) => v.verdict === 'FAIL');
  lines.push('');
  lines.push('## 判定');
  lines.push('');
  lines.push(fails.length === 0
    ? `PASS — ${verdicts.length} 行すべて許容差内(反射率 |差| ≤ ${ALBEDO_TOLERANCE}、影 |差| ≤ ${SHADOW_TOLERANCE})。`
    : `FAIL — ${verdicts.length} 行中 ${fails.length} 行が許容差を超えた:`);
  for (const fail of fails) lines.push(`- ${fail.name}: 差 ${f3(fail.diff)}`);

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
