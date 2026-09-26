// 全球雲場(MeteorologicalCloudField)の視覚検証。render-lab の earth ケースを駆動し、
// 全球場の初回ジョブが完成するまで暖機してから、全球・中距離・近距離の構図と
// 生成(気象モデル)/実写の比較を撮る。PNG と画素統計を
// .render-lab-shots/cloud-field-check/ へ書く。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
const outDir = path.join(root, '.render-lab-shots', 'cloud-field-check');
const port = 8797;
const debugPort = 9474;

const R_EARTH = 6.371e6;
const R_EARTH_EQ = 6.378137e6;
const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 540;
const FOV_DEG = 50;

// 暖機。全球場の供給ジョブは 1 フレーム(= 1 prepare)あたり数 ms しか進まないので、
// 世代が 2(空の場の初焼き=1、届いた場=2)へ進むまでフレームを回す。
const WARM_BATCH_FRAMES = 20;
const WARM_MAX_FRAMES = 4000;
// 1 枚の絵が落ち着くまで撮り直す上限。非同期に届くテクスチャ(実写・旧経路の焼き上げ)は
// 届くフレームで絵が変わるので、連続する 2 枚が一致したものを「落ち着いた絵」として使う。
const MAX_SETTLE_CAPTURES = 8;

// 低軌道のケースが使う地表の注視点までの深度 [m]。earth-cases の EARTH_PLACEMENT と
// 同じ式: 高度 420 km で地平線が視線上へ来る置き方の、地球の中心の -Z 成分。
const LEO_ALTITUDE = 420e3;
const LEO_TILT = Math.asin(R_EARTH / (R_EARTH + LEO_ALTITUDE));
const VIEW_TARGET_DEPTH = (R_EARTH + LEO_ALTITUDE) * Math.cos(LEO_TILT);
// 赤道・本初子午線を直下へ来る地表を注視点へ重ねる置き方(earth-cases の EARTH_NADIR_PLACEMENT)。
const NADIR_PLACEMENT = {
  earthAzimuthDeg: 180,
  earthElevationDeg: 0,
  earthAltitudeLog: Math.log10(VIEW_TARGET_DEPTH + R_EARTH_EQ - R_EARTH),
  earthLatitudeDeg: 0,
  earthLongitudeDeg: 0,
};
const nadirView = (cameraDistanceM, extra = {}) => ({
  ...NADIR_PLACEMENT,
  cameraDistanceLog: Math.log10(cameraDistanceM / VIEW_TARGET_DEPTH),
  ...extra,
});

// 全球視: 円盤全体が画角へ収まる距離(視半径 ~15°)から、恒星をカメラの背後へ置いて
// 昼側を正面に撮る。直下点はそれぞれ大西洋/アフリカ・中太平洋・北極。
const DISK_ALTITUDE = 1.8e7;
const DISK_SUN = { sunAzimuthDeg: 0, sunElevationDeg: 16.7 };
const diskView = (latitudeDeg, longitudeDeg) => ({
  earthAzimuthDeg: 180,
  earthElevationDeg: 0,
  earthAltitudeLog: Math.log10(DISK_ALTITUDE),
  earthLatitudeDeg: latitudeDeg,
  earthLongitudeDeg: longitudeDeg,
  ...DISK_SUN,
});
// 円盤の画面上の半径 [px]。地球は正面(画角の中心)にある。
const DISK_RADIUS_PX = (VIEW_HEIGHT / 2)
  * (Math.asin(R_EARTH / (R_EARTH + DISK_ALTITUDE)) * 180 / Math.PI) / (FOV_DEG / 2);
const DISK_CIRCLE = { cx: VIEW_WIDTH / 2, cy: VIEW_HEIGHT / 2, r: DISK_RADIUS_PX * 0.98 };

// 極の撮影と同じ置き方: 視半径が画面高の 80% になる距離から北極を見下ろす。
const POLAR_APPARENT = (FOV_DEG / 2) * 0.8;
const POLAR_VIEW = {
  earthAzimuthDeg: 180,
  earthElevationDeg: 0,
  earthAltitudeLog: Math.log10(R_EARTH / Math.sin(POLAR_APPARENT * Math.PI / 180) - R_EARTH),
  earthLatitudeDeg: 90,
  earthLongitudeDeg: 0,
  sunAzimuthDeg: 45,
  sunElevationDeg: 0,
};
const POLAR_RADIUS_PX = (VIEW_HEIGHT / 2) * 0.8;
const POLAR_CIRCLE = { cx: VIEW_WIDTH / 2, cy: VIEW_HEIGHT / 2, r: POLAR_RADIUS_PX * 0.98 };

// 斜視: earth-cases の EARTH_OBLIQUE_PLACEMENT(地平線を視線から 0.49 rad 上げた構図)。
const OBLIQUE_TILT_DEG = (LEO_TILT - 0.49) * 180 / Math.PI;
const OBLIQUE_VIEW = {
  earthAzimuthDeg: 180,
  earthElevationDeg: -OBLIQUE_TILT_DEG,
  earthAltitudeLog: Math.log10(LEO_ALTITUDE),
  earthLatitudeDeg: OBLIQUE_TILT_DEG,
  earthLongitudeDeg: 0,
};

// 画素統計。dataURL をデコードし、circle(null 可)の内側だけで輝度の分布・
// 「白い雲らしい」画素(彩度が低く明るい)の割合を数える。
const STATS_JS = `async (dataUrl, circle) => {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(bmp, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  let n = 0, lumaSum = 0, whitish = 0, bright = 0, dark = 0;
  const hist = new Array(8).fill(0);
  for (let i = 0; i < d.length; i += 4) {
    const p = i / 4, px = p % c.width, py = (p / c.width) | 0;
    if (circle) {
      const dx = px - circle.cx, dy = py - circle.cy;
      if (dx * dx + dy * dy > circle.r * circle.r) continue;
    }
    n++;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lumaSum += l;
    hist[Math.min(7, Math.floor(l / 32))]++;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx - mn < 45 && l > 150) whitish++;
    if (l > 190) bright++;
    if (l < 12) dark++;
  }
  return {
    pixels: n, meanLuma: lumaSum / n, whitishFraction: whitish / n,
    brightFraction: bright / n, darkFraction: dark / n,
    lumaHistogram: hist.map((v) => v / n),
  };
}`;

// 同寸の 2 枚の輝度差。構成の近い経路どうしのずれの大きさを見る。
const DIFF_JS = `async (a, b) => {
  const [ba, bb] = await Promise.all([a, b].map(
    async (u) => createImageBitmap(await (await fetch(u)).blob())));
  const c = new OffscreenCanvas(ba.width, ba.height);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(ba, 0, 0);
  const da = x.getImageData(0, 0, c.width, c.height).data;
  x.clearRect(0, 0, c.width, c.height);
  x.drawImage(bb, 0, 0);
  const db = x.getImageData(0, 0, c.width, c.height).data;
  let n = 0, sum = 0, moved = 0;
  for (let i = 0; i < da.length; i += 4) {
    n++;
    const dl = Math.abs(
      0.2126 * (da[i] - db[i]) + 0.7152 * (da[i + 1] - db[i + 1]) + 0.0722 * (da[i + 2] - db[i + 2]));
    sum += dl;
    if (dl > 32) moved++;
  }
  return { meanAbsLumaDiff: sum / n, movedFraction: moved / n };
}`;

async function main() {
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-render-lab-cfc-', onEvent,
  });
  const report = { shots: {}, comparisons: {}, notes: [] };
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    await waitFor(
      devTools,
      "(document.getElementById('error')?.textContent || typeof window.renderLab?.cloudFieldGeneration === 'function')",
      'the render lab to initialise',
    );
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`Render lab failed to initialise: ${failure}`);

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    const savePng = (name, dataUrl) => {
      writeFileSync(
        path.join(outDir, `${name}.png`),
        Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
      console.log(`shot ${name}`);
    };
    // dataURL は長いのでページ側の変数へ置いてから統計・差分を取る。
    const statsFor = async (name, dataUrl, circle = null) => {
      await devTools.evaluate(`window.__cfcData = ${JSON.stringify(dataUrl)}`);
      const stats = await devTools.evaluate(`(${STATS_JS})(window.__cfcData, ${JSON.stringify(circle)})`);
      report.shots[name] = stats;
      return stats;
    };
    const diffOf = async (name, aUrl, bUrl) => {
      await devTools.evaluate(`window.__cfcA = ${JSON.stringify(aUrl)}; window.__cfcB = ${JSON.stringify(bUrl)}`);
      const diff = await devTools.evaluate(`(${DIFF_JS})(window.__cfcA, window.__cfcB)`);
      report.comparisons[name] = diff;
      return diff;
    };
    // 連続する 2 枚が一致するまで撮り直す(非同期の焼き上げ・転送が乗るフレームを避ける)。
    const captureSettled = async (name) => {
      let previous = await devTools.evaluate('window.renderLab.capture()');
      for (let i = 1; i < MAX_SETTLE_CAPTURES; i++) {
        const next = await devTools.evaluate('window.renderLab.capture()');
        if (next === previous) {
          savePng(name, next);
          return { png: next, settledAt: i + 1 };
        }
        previous = next;
      }
      report.notes.push(`${name}: did not settle within ${MAX_SETTLE_CAPTURES} captures`);
      savePng(name, previous);
      return { png: previous, settledAt: null };
    };
    const captureView = async (name, view, circle = null) => {
      await devTools.evaluate(`window.renderLab.setView(${JSON.stringify(view)})`);
      const { png } = await captureSettled(name);
      return statsFor(name, png, circle);
    };

    // ケースを開き、固定の視点で基準世代を取る。**同じ置き方では世代が進むのは供給ジョブの
    // 場が届いて焼き直したときだけ** — 置き方の違う焼き直し(空の場でも進む)と区別するため
    // 視点を固定してから差を見る。
    await devTools.evaluate('window.renderLab.show("earth")');
    await devTools.evaluate(`window.renderLab.setView(${JSON.stringify(diskView(10, 0))})`);
    await devTools.evaluate('window.renderLab.capture()');
    const warmStartedAt = Date.now();
    const baselineGeneration = await devTools.evaluate('window.renderLab.cloudFieldGeneration()');
    let generation = baselineGeneration;
    let warmFrames = 0;
    while (generation <= baselineGeneration && warmFrames < WARM_MAX_FRAMES) {
      await devTools.evaluate(
        `for (let f = 0; f < ${WARM_BATCH_FRAMES}; f++) window.renderLab.setView({}); true`);
      warmFrames += WARM_BATCH_FRAMES;
      // GPU の命令列を詰まらせないよう、束ごとに readback で排出する。
      await devTools.evaluate('window.renderLab.capture()');
      generation = await devTools.evaluate('window.renderLab.cloudFieldGeneration()');
    }
    report.warmup = {
      frames: warmFrames, wallMs: Date.now() - warmStartedAt,
      baselineGeneration, generation,
      jobCompleted: generation > baselineGeneration,
    };
    console.log(`warmup: ${warmFrames} frames, generation ${baselineGeneration} -> ${generation}, ${report.warmup.wallMs} ms`);
    if (generation <= baselineGeneration) {
      report.notes.push('global field job did not complete within the warmup budget');
    }

    // 場の中身を描画を通さず読む — 被覆がどこにどれだけあるかの基準値。
    report.globalField = await devTools.evaluate('window.renderLab.probeGlobalField(0)');
    console.log(`global field: meanCoverage=${report.globalField.meanCoverage.toFixed(4)}, `
      + `max=${report.globalField.maxCoverage.toFixed(3)} @ (${report.globalField.maxCoverageLatitudeDeg.toFixed(1)}, ${report.globalField.maxCoverageLongitudeDeg.toFixed(1)}), `
      + `events=${report.globalField.eventCount} (truncated ${report.globalField.truncatedEventCount})`);

    // 全球視。円盤が収まる距離で、雲量が 0 でも全面でもないかを読む。
    await captureView('disk-atlantic', diskView(10, 0), DISK_CIRCLE);
    await captureView('disk-pacific', diskView(0, -150), DISK_CIRCLE);
    await captureView('disk-polar', POLAR_VIEW, POLAR_CIRCLE);
    // 場の被覆が最大の地点を直下にする円盤 — 場が持っている雲が絵に出るかの直接確認。
    await captureView(
      'disk-maxcoverage',
      diskView(report.globalField.maxCoverageLatitudeDeg, report.globalField.maxCoverageLongitudeDeg),
      DISK_CIRCLE);

    // 中距離・近距離。直下点構図(600 km / 250 km)・斜視を撮る。直下 600 km は
    // ±250 km の局所光学場が全球場と両立するかを見る構図でもある。
    await captureView('nadir-600km', nadirView(600e3, { sunElevationDeg: 10 }));
    await captureView('nadir-250km', nadirView(250e3));
    await captureView('oblique', OBLIQUE_VIEW);
    // 被覆の厚い地点の直下点構図 — 場に質量がある所で積雲が立つかを見る。
    await captureView('nadir600-maxcoverage', nadirView(600e3, {
      sunElevationDeg: 10,
      earthLatitudeDeg: report.globalField.maxCoverageLatitudeDeg,
      earthLongitudeDeg: report.globalField.maxCoverageLongitudeDeg,
    }));

    // 生成(気象モデル)と実写の比較。同じ構図・同じ時刻で、生成雲と実写を並べる。
    // 実写との差は分布の出どころが別なので参考。
    // 出どころを切り替えたあと、その場が届いて焼き直されるまで待つ。世代は焼き直しごとに
    // 進むので、切り替え直後の世代から +1 で「少なくとも1回焼いた」、+2 で「届いた画像を
    // 含む焼き直しが済んだ」目安になる(最初の焼き直しに届いた画像が間に合った場合は +1 で
    // 止まるので、世代が一定のまま続く場合も抜ける)。1 回の評価でまとめて回すと画像取得が
    // 進まないので、フレームごとに呼び分ける。
    const waitSourceLoaded = async (name, baseGeneration) => {
      let generation = baseGeneration;
      let unchanged = 0;
      for (let i = 0; i < 240; i++) {
        await devTools.evaluate('window.renderLab.setView({})');
        if (i % 5 !== 4) continue;
        const g = await devTools.evaluate('window.renderLab.cloudFieldGeneration()');
        if (g >= baseGeneration + 2) {
          report.notes.push(`${name}: source loaded after ~${i + 1} frames (generation ${g})`);
          return;
        }
        unchanged = g === generation ? unchanged + 1 : 0;
        generation = g;
        if (g >= baseGeneration + 1 && unchanged >= 8 && i >= 60) return;
      }
      report.notes.push(`${name}: source may not have loaded (generation ${generation})`);
    };
    const compareAt = async (tag, view, circle) => {
      await devTools.evaluate(`window.renderLab.setView(${JSON.stringify(view)})`);
      await devTools.evaluate('window.renderLab.setGraphicsOption("cloudFieldSource", "generated")');
      const pngNew = (await captureSettled(`${tag}-new`)).png;
      await statsFor(`${tag}-new`, pngNew, circle);

      await devTools.evaluate('window.renderLab.setGraphicsOption("cloudFieldSource", "observed")');
      const baseObs = await devTools.evaluate('window.renderLab.cloudFieldGeneration()');
      await waitSourceLoaded(`${tag}-observed`, baseObs);
      const pngObs = (await captureSettled(`${tag}-observed`)).png;
      await statsFor(`${tag}-observed`, pngObs, circle);

      await diffOf(`${tag}-new-vs-observed`, pngNew, pngObs);
    };
    await compareAt('disk', diskView(10, 0), DISK_CIRCLE);
    await compareAt('nadir600', nadirView(600e3, { sunElevationDeg: 10 }));

    // 直下点の ±250 km 局所光学場の焼き上げ記録。全球場と両立して出ているかを見る。
    report.localFieldBakeStats = await devTools.evaluate('window.renderLab.cloudLocalFieldBakeStats()');

    if (fatalEvents.length > 0) {
      report.notes.push(`page errors: ${fatalEvents.join(' | ')}`);
      throw new Error(`Page reported errors during shooting:\n${fatalEvents.join('\n')}`);
    }
    writeFileSync(path.join(outDir, 'stats.json'), JSON.stringify(report, null, 2));
    console.log(`Wrote results to ${path.relative(root, outDir)}`);
  } finally {
    await session.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
