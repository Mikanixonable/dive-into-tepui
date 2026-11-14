// 雲影の幾何評価。形の分かっている合成の雲場(render-lab の cloud-shadow-geometry ケース)へ
// 実機の CloudShadowRenderer を結び、地表の受け手の透過率を画素から読んで、太陽と反対向きの
// 軸に沿った影の位置・長さを測る。期待値の式は tools/render-lab/cloud-shadow-geometry-model.ts。
// 使い方: node tools/cloud-shadow-geometry-check.mjs — 引数は無し。切り替えは作業ツリー直下の
// .loop-shadow-geometry-config.json(任意):
//   { "tag": "base",   // 出力先 .cloud-detail/shadow-geometry/<tag>/ の名前
//     "build": true }  // false なら webpack を飛ばして既存の .render-lab/ を使う
// 各条件(天頂角 × 円板)で、透過率が 0.9 を割る最も遠い位置(影の遠端)・1−透過率の重み付き
// 重心のずれ・最小透過率を出す。細部なし(d0)は期待の ±25%(期待値が小さいときは円板の半径・
// 細部タップの間隔基準の下限)と単調増加を判定する。細部あり(dstd)は細部が柱の雲頂を書き換える
// ため式は当てはまらず、影が消えていない・遠端が式の上限を越えない・重心が円板より恒星側へ
// 逸れないことだけを見る。外れたら終了コード 1。
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { openChromeSession, waitFor, collectFatalEvents } from './chrome-session.mjs';
import { decodePng } from './png.mjs';
import {
  DISCS, ZENITH_DEG, MAP, FINE_STEP_M, DETAIL_TOP_RELIEF_M, expectedFarEdgeM,
  expectedCentroidOffsetM, expectedMinTransmittance,
} from './render-lab/cloud-shadow-geometry-model.ts';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
// 他の計測(cloud-shadow-check 8775/9454 など)と衝突しない固定ポート。
const PORT = 8780;
const DEBUG_PORT = 9459;

const configPath = path.join(root, '.loop-shadow-geometry-config.json');
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
const tag = config.tag ?? 'base';
const outRoot = path.join(root, '.cloud-detail', 'shadow-geometry', tag);

const CASE = 'cloud-shadow-geometry';
const DETAILS = ['d0', 'dstd'];

// webpack の本番ビルド。npm run render-lab:shot などと同じ入口を子プロセスで直に起動する。
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

const dataUrlToPng = (url) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');

// 画素 → 地表の実寸(MAP の写像。x は恒星方位の実寸で、影は −x 側へ落ちる)。
const xiOfX = (x, width) => (x / width - 0.5) * MAP.widthM + MAP.centerXM;
const yOfZeta = (zetaM, height) => (0.5 - zetaM / MAP.heightM) * height;

// 円板の影を PNG から測る。遠端(0.9 を割る最も遠い位置)・暗さの重み付き重心・
// 最小透過率を返す。
function measureDisc(png, disc) {
  const { width, height, channels, data } = png;
  const yCenter = Math.round(yOfZeta(disc.zetaM, height));
  const band = Math.max(1, Math.round((disc.radiusM / MAP.heightM) * height * 0.6));
  const rows = [];
  for (let y = Math.max(0, yCenter - band); y <= Math.min(height - 1, yCenter + band); y++) {
    rows.push(y);
  }
  // 円板のある高さ ±(r+15km) の範囲を重心の窓にする。列は遠端より先まで読める左端から、
  // 円板の恒星側へ少し超えるまで。
  const tOf = (x, y) => data[(y * width + x) * channels] / 255;
  const yLo = Math.max(0, Math.round(yOfZeta(disc.zetaM + disc.radiusM + 15e3, height)));
  const yHi = Math.min(height - 1, Math.round(yOfZeta(disc.zetaM - disc.radiusM - 15e3, height)));
  const xHi = Math.min(width - 1, Math.round(
    (0.5 + (disc.radiusM + 20e3 - MAP.centerXM) / MAP.widthM) * width));
  let far = 0, sumW = 0, sumXW = 0, minT = 1;
  for (let x = 0; x <= xHi; x++) {
    const xi = xiOfX(x, width);
    // 遠端は帯のうち最も暗い行で読む。先端では影の横幅が狭まるので中央値だと薄まる。
    const t = Math.min(...rows.map((y) => tOf(x, y)));
    if (t < 0.9 && xi < 0) far = Math.max(far, -xi);
  }
  for (let y = yLo; y <= yHi; y++) {
    for (let x = 0; x <= xHi; x++) {
      const t = tOf(x, y);
      // 1−透過率の重み。8bit 量子化の滲みを載せないために 2% 未満の暗さは切る。
      const w = t < 0.98 ? Math.max(0, 1 - t) : 0;
      if (w <= 0) continue;
      const xi = xiOfX(x, width);
      sumW += w;
      sumXW += -xi * w;
      minT = Math.min(minT, t);
    }
  }
  return { far, centroid: sumW > 0 ? sumXW / sumW : 0, minT, weight: sumW };
}

const fmtKm = (m) => (m / 1e3).toFixed(1);

async function main() {
  if (config.build !== false || !existsSync(path.join(buildDir, 'index.html'))) {
    console.log('=== webpack --config webpack.render-lab.config.js --mode production ===');
    await buildRenderLab();
  }
  const { onEvent, fatalEvents } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port: PORT, debugPort: DEBUG_PORT,
    profilePrefix: 'tepui-shadow-geometry-', onEvent,
    requestTimeoutMs: 120_000,
  });
  const rows = [];
  const failures = [];
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    await waitFor(devTools, 'typeof window.renderLab?.shoot === "function"', 'renderLab API');
    // 測定のためアンチエイリアスは切る — 縁の輪郭を画素で読むので、ぼかした値は位置をずらす。
    const shots = await devTools.evaluate(
      `window.renderLab.shoot(${JSON.stringify(CASE)}, ${JSON.stringify({ antialias: 0 })})`);
    mkdirSync(outRoot, { recursive: true });
    for (const zenith of ZENITH_DEG) {
      for (const detail of DETAILS) {
        const shotName = `csgeom-z${zenith}-${detail}`;
        const url = shots[shotName];
        if (url === undefined) throw new Error(`shot ${shotName} missing`);
        const buf = dataUrlToPng(url);
        const dir = path.join(outRoot, `z${zenith}-${detail}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, `${shotName}.png`), buf);
        const png = decodePng(buf);
        const zenithRad = zenith * Math.PI / 180;
        for (const disc of DISCS) {
          const m = measureDisc(png, disc);
          const expFar = expectedFarEdgeM(disc.radiusM, disc.topAltitudeM, zenithRad);
          const expCtr = expectedCentroidOffsetM(disc.radiusM, disc.topAltitudeM, zenithRad);
          const expMinT = expectedMinTransmittance(disc.topAltitudeM);
          // 影の深さ。d0 は式の最深部へ緩い倍数で見る。dstd は細部が柱の厚みを再配分するので
          // 深さの式は当てはまらず、意味のある減光が残ることだけを見る。
          const minOk = detail === 'd0'
            ? m.minT <= Math.max(0.6, expMinT * 3)
            : m.minT <= 0.7;
          let farOk, ctrOk, farBound, ctrBound;
          if (detail === 'd0') {
            // 許容は ±25%。期待値が小さい条件では絶対の下限(円板半径の 1/4、重心はさらに
            // 細部タップ 1 歩の幅 — タップの按分が重心をその粒でずらす)へ切り替える。
            const tolFar = Math.max(0.25 * expFar, disc.radiusM * 0.25);
            const tolCtr = Math.max(0.25 * Math.abs(expCtr), disc.radiusM * 0.25, FINE_STEP_M);
            farOk = Math.abs(m.far - expFar) <= tolFar;
            ctrOk = Math.abs(m.centroid - expCtr) <= tolCtr;
            farBound = `${fmtKm(expFar)}±${fmtKm(tolFar)}`;
            ctrBound = `${fmtKm(expCtr)}±${fmtKm(tolCtr)}`;
          } else {
            // dstd: 細部で柱の雲頂が動くので式とは比べず、影が消えていない(円板か式の遠端の
            // 3 割は届く)・細部を最大に乗せた雲頂の式より遠くへ逸れない・重心が円板より恒星側へ
            // 出ないことだけを見る。
            const farUpper = expectedFarEdgeM(disc.radiusM,
              disc.topAltitudeM + DETAIL_TOP_RELIEF_M, zenithRad) * 1.35 + disc.radiusM;
            const farFloor = 0.3 * Math.min(disc.radiusM, expFar);
            farOk = m.far >= farFloor && m.far <= farUpper;
            ctrOk = m.centroid >= -1.2 * disc.radiusM;
            farBound = `${fmtKm(farFloor)}..${fmtKm(farUpper)}`;
            ctrBound = `>=${fmtKm(-1.2 * disc.radiusM)}`;
          }
          const ok = farOk && ctrOk && minOk;
          rows.push({
            shot: shotName, disc: disc.key, zenithDeg: zenith, detail,
            expFarKm: expFar / 1e3, farKm: m.far / 1e3,
            expCtrKm: expCtr / 1e3, ctrKm: m.centroid / 1e3,
            minT: m.minT, expMinT, ok,
          });
          if (!ok) {
            failures.push(`${shotName} ${disc.key}`
              + ` far=${fmtKm(m.far)}(${farBound})`
              + ` ctr=${fmtKm(m.centroid)}(${ctrBound})`
              + ` minT=${m.minT.toFixed(3)}`);
          }
        }
      }
    }
  } finally {
    await session.close();
  }
  // 単調増加の判定: 同じ円板で天頂角が上がるほど遠端が伸びる。測定のゆらぎは 10% + 1 km まで戻す。
  // 判定するのは細部なし(d0)だけ — 細部ありでは柱の形そのものが変わり、順序は幾何の性質ではない。
  for (const disc of DISCS) {
    for (const detail of ['d0']) {
      const series = ZENITH_DEG.map((z) => rows.find(
        (r) => r.disc === disc.key && r.detail === detail && r.zenithDeg === z)).map((r) => r.farKm);
      for (let i = 1; i < series.length; i++) {
        if (series[i] < series[i - 1] - Math.max(0.1 * series[i - 1], 1)) {
          failures.push(`${disc.key} ${detail}: far not increasing`
            + ` z${ZENITH_DEG[i - 1]}=${series[i - 1].toFixed(1)} z${ZENITH_DEG[i]}=${series[i].toFixed(1)}`);
        }
      }
    }
  }
  // 高い雲ほど長い影: 同じ半径・天頂角で H が大きいほど遠端が伸びる。こちらも d0 だけ。
  for (const r of [...new Set(DISCS.map((d) => d.radiusM))]) {
    for (const detail of ['d0']) {
      for (const zenith of ZENITH_DEG) {
        const series = DISCS.filter((d) => d.radiusM === r)
          .map((d) => rows.find((x) => x.disc === d.key && x.detail === detail && x.zenithDeg === zenith));
        for (let i = 1; i < series.length; i++) {
          if (series[i].farKm < series[i - 1].farKm - Math.max(0.1 * series[i - 1].farKm, 1)) {
            failures.push(`r${r / 1e3} ${detail} z${zenith}: far not increasing with H`
              + ` ${series[i - 1].disc}=${series[i - 1].farKm.toFixed(1)} ${series[i].disc}=${series[i].farKm.toFixed(1)}`);
          }
        }
      }
    }
  }

  console.log('shot              disc      farKm(exp)      ctrKm(exp)      minT  ok');
  for (const r of rows) {
    console.log(
      `${r.shot.padEnd(17)} ${r.disc.padEnd(9)} `
      + `${r.farKm.toFixed(1).padStart(7)}(${r.expFarKm.toFixed(1).padStart(6)}) `
      + `${r.ctrKm.toFixed(1).padStart(7)}(${r.expCtrKm.toFixed(1).padStart(6)}) `
      + `${r.minT.toFixed(3).padStart(5)}  ${r.ok ? 'ok' : 'FAIL'}`,
    );
  }
  writeFileSync(path.join(outRoot, 'summary.json'), JSON.stringify({ rows, failures }, null, 2));
  if (fatalEvents.length > 0) console.log('fatal events:', fatalEvents);
  console.log(`\nwrote ${outRoot}/`);
  if (failures.length > 0) {
    console.log(`\nFAIL ${failures.length}:`);
    for (const f of failures) console.log(`  ${f}`);
    process.exit(1);
  }
  console.log('\nPASS');
}

main().catch((e) => { console.error(e); process.exit(1); });
