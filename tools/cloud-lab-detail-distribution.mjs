// ランダム抽出の実写の教師と生成の撮影を、特徴量の分布どうしで比べる。
// .cloud-lab/detail/random-teacher/manifest.json の点と同じ緯度経度・同じ段で cloud-lab の detail ページが撮った
// 画像(.cloud-lab/detail/random-shots/)へ、実写と同じ物差しを当て、区分 × 段 × 特徴量の分布
// (分位点)と、正規化したワッサースタイン距離(分位点の差の絶対値の平均を実写の p10〜p90 の幅で
// 割った値)を出す。家族ごとの平均を区分 × 段の表にし、重要な特徴量は実写と生成の分位点を
// 並べて表示する — 分布の幅(緩急)が揃っているかを目で読めるようにするため。
// 結果は .cloud-lab/detail/history/ へ残し、前回の同じ道具のレポートとの差分を出す。
// --fresh で撮影を撮り直す。既にある撮影は飛ばす。
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';
import { measureDetailImage } from './cloud-lab-detail-features.mjs';
import { fitLine, normalizedDistance, quantiles } from './cloud-lab-detail-metrics.mjs';
import {
  collectNumericDiffs, formatDiffValue, gitHead, readReport, saveReport,
} from './cloud-report-history.mjs';

const root = path.resolve(import.meta.dirname, '..');
const cloudLabDir = path.join(root, '.cloud-lab');
const teacherDir = path.join(root, '.cloud-lab', 'detail', 'random-teacher');
const shotsDir = path.join(root, '.cloud-lab', 'detail', 'random-shots');
const historyDir = path.join(root, '.cloud-lab', 'detail', 'history');
const teacherManifestFile = path.join(teacherDir, 'manifest.json');

// 配信と CDP のポート。環境変数で上書きできる(別の作業ツリーの計測と並行して走らせられる)。
const port = Number(process.env.CLOUD_LAB_DETAIL_PORT ?? 8819);
const debugPort = Number(process.env.CLOUD_LAB_DETAIL_DEBUG_PORT ?? 9519);

// 撮る段 [km/px]。実写の教師の段と揃える。
const TIERS_KM_PER_PX = [1, 4];
// 分布を並べる分位点。
const QUANTILE_FRACTIONS = [0.1, 0.25, 0.5, 0.75, 0.9];
// 生成の撮影の雲場の進行時刻を決める乱数の種。撮影名から決定的に時刻を引くので、
// 再実行・撮り直しでも同じ時刻で撮る。
const SHOT_SEED = 20240507;
// 区分の並び(manifest の抽出順)。報告の表もこの順にする。
const CATEGORY_ORDER = [
  'tropical-sea', 'temperate-sea', 'highlat-sea', 'tropical-land', 'temperate-land', 'highlat-land', 'arid-land',
];
// 動作確認(smoke の npm script)で撮る区分と点数。
const SMOKE_CATEGORY = 'tropical-sea';
const SMOKE_SLOTS = 4;
// 撮影の太陽の時角(現地の太陽時刻 10:30)。撮影側の定義(tools/render-lab/cloud-detail-cases.ts
// の sunAnglesForLocal1030)と同じ — 赤緯は分点固定なので、直下点の緯度だけで天頂角が決まる。
const SHOT_SUN_HOUR_ANGLE_RAD = (22.5 * Math.PI) / 180;
// 撮影の描画設定で点いている一様な環境光の、太陽放射照度に対する割合
// (src/render/pipeline/lighting/ambient-source.ts の AMBIENT_FRACTION)。拡散面へ届く照明は
// 直射の cos(天頂角) にこの値が足される — 放射輝度を反射率相当へ割る除数の一部。
const SHOT_AMBIENT_FRACTION = 0.03;
// 監査で個別に比と天頂角の関係を出す特徴量。
const ZENITH_AUDIT_FEATURES = ['toneMean', 'toneP50', 'toneP90', 'toneP99'];

// 撮影の太陽天頂角の余弦。直下点の緯度 latitudeDeg [deg] で、cosZ = cos(緯度)·cos(時角)。
function sunCosZenithOf(latitudeDeg) {
  return Math.cos((latitudeDeg * Math.PI) / 180) * Math.cos(SHOT_SUN_HOUR_ANGLE_RAD);
}
const FAMILIES = ['spectrum', 'intermittency', 'periodicity', 'shapes', 'anisotropy', 'heterogeneity', 'tone'];
// 分位点を個別に並べて出す特徴量。分布の中心と幅のずれが直接見えるものを選ぶ。
const KEY_FEATURES = ['cloudyShare', 'toneMean', 'toneP90', 'toneP99', 'hetSlope', 'hetI@64', 'hetI@256'];

// 撮影名と点の対応。実写の教師と同じ <区分>-<番号>-<km/px>km。
const shotName = (category, slot, kmPerPx) => `${category}-${String(slot).padStart(3, '0')}-${kmPerPx}km`;

// 名前から決定的に引く雲場の進行時刻 [s]。0〜24 時の一様な揺らぎ — 実写の点と同じ場所を、
// 生成の雲場の別の時刻の姿で撮ることで、分布比較が 1 時刻の姿に寄らないようにする。
function displayTimeOf(name) {
  let hash = 2166136261 ^ SHOT_SEED;
  for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) % 86400;
}

// 値の列の分位点(この道具が使う分位点の並び)。
const quantilesAt = (values) => quantiles(values, QUANTILE_FRACTIONS);

// 足りない撮影を .cloud-lab のページで撮る。missing の各要素に返った centerKmPerPx・altitudeM を書き込む。
async function shootMissing(missing) {
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: cloudLabDir, port, debugPort, profilePrefix: 'tepui-cloud-dist-', onEvent,
    requestTimeoutMs: 120_000,
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/detail.html` });
    await waitFor(
      devTools,
      "(document.getElementById('error')?.textContent || typeof window.cloudLabDetail?.shootCloudDetailRandom === 'function')",
      'the cloud lab detail page to initialise',
    );
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`Render lab failed to initialise: ${failure}`);
    let taken = 0;
    for (const entry of missing) {
      const result = await devTools.evaluate(
        `window.cloudLabDetail.shootCloudDetailRandom(${JSON.stringify(entry.name)}, ${JSON.stringify(entry.point)})`);
      writeFileSync(
        path.join(shotsDir, `${entry.name}.png`),
        Buffer.from(result.png.slice(result.png.indexOf(',') + 1), 'base64'),
      );
      entry.centerKmPerPx = result.centerKmPerPx;
      entry.altitudeM = result.altitudeM;
      taken++;
      if (taken % 10 === 0 || taken === missing.length) console.log(`shot ${taken}/${missing.length} ${entry.name}`);
    }
    if (fatalEvents.length > 0) throw new Error(`Page reported errors during shooting:\n${fatalEvents.join('\n')}`);
    return taken;
  } finally {
    await session.close();
  }
}

async function main() {
  if (!existsSync(teacherManifestFile)) {
    throw new Error(`${teacherManifestFile} が無い — 先に npm run cloud-lab:detail-random-teacher を実行する`);
  }
  const teacher = JSON.parse(readFileSync(teacherManifestFile, 'utf8'));
  // 反復用の設定(作業ツリー直下の .loop-random-config.json)。slots は区分ごとに撮る
  // 番号の上限、fresh は対象の撮影を撮り直す、reflectanceNormalize は生成の撮影を
  // 反射率相当へ換算してから測る(既定で有効)。
  const loopConfigFile = path.join(root, '.loop-random-config.json');
  const loopConfig = existsSync(loopConfigFile)
    ? JSON.parse(readFileSync(loopConfigFile, 'utf8'))
    : {};
  const slotLimits = loopConfig.slots ?? {};
  const reflectanceNormalize = loopConfig.reflectanceNormalize !== false;
  // 動作確認は少数の点だけを撮る軽い版。npm script cloud-lab:detail-distribution-smoke
  // (npm_lifecycle_event に 'smoke' が入る)で、この区分の先頭数点へ絞る。
  const smoke = (process.env.npm_lifecycle_event ?? '').includes('smoke');
  const eligible = (teacher.points ?? []).filter((point) => point.status === 'ok'
    && (!smoke || (point.category === SMOKE_CATEGORY && point.slot <= SMOKE_SLOTS)));
  // 生成の撮影は実写と同じ緯度経度を要るので緯度経度のある点だけ。実写側の計測は
  // 画像があれば緯度経度を持たない点(manifest の無い既存を採用したもの)も数える —
  // 分布の比較なので 1 対 1 の対応は要らない。
  const genPoints = eligible.filter((point) => point.latitude !== null
    && point.slot <= (slotLimits[point.category] ?? Infinity));

  // --- 撮影の対象: 実写の点 × 段。既にある撮影は飛ばし、--fresh は撮り直す ---
  const targets = [];
  for (const point of genPoints) {
    for (const kmPerPx of TIERS_KM_PER_PX) {
      const name = shotName(point.category, point.slot, kmPerPx);
      targets.push({
        name,
        category: point.category,
        slot: point.slot,
        kmPerPx,
        point: {
          category: point.category,
          latitudeDeg: point.latitude,
          longitudeDeg: point.longitude,
          displayTime: displayTimeOf(`${point.category}-${point.slot}`),
          tierKmPerPx: kmPerPx,
        },
      });
    }
  }
  mkdirSync(shotsDir, { recursive: true });
  if (process.argv.includes('--fresh') || loopConfig.fresh === true) {
    for (const target of targets) rmSync(path.join(shotsDir, `${target.name}.png`), { force: true });
  }
  const missing = targets.filter((target) => !existsSync(path.join(shotsDir, `${target.name}.png`)));
  const taken = missing.length > 0 ? await shootMissing(missing) : 0;
  console.log(`撮影: 全 ${targets.length} 枚のうち ${taken} 枚を新たに撮った(既存は飛ばす)`);

  // 撮影の記録。撮ったとき・一覧が変わったときだけ書く(撮影がどの HEAD で撮られたかの記録を
  // 撮り直し無しの実行で上書きしないため)。
  const manifestFile = path.join(shotsDir, 'manifest.json');
  const previousShots = existsSync(manifestFile)
    ? JSON.parse(readFileSync(manifestFile, 'utf8')).shots ?? []
    : [];
  const shotInfoByName = new Map(previousShots.map((shot) => [shot.name, shot]));
  const shotInfos = targets.map((target) => ({
    name: target.name,
    category: target.category,
    slot: target.slot,
    tierKmPerPx: target.kmPerPx,
    displayTime: target.point.displayTime,
    latitudeDeg: target.point.latitudeDeg,
    longitudeDeg: target.point.longitudeDeg,
    sunCosZenith: sunCosZenithOf(target.point.latitudeDeg),
    centerKmPerPx: target.centerKmPerPx ?? shotInfoByName.get(target.name)?.centerKmPerPx ?? null,
    altitudeM: target.altitudeM ?? shotInfoByName.get(target.name)?.altitudeM ?? null,
  }));
  const listChanged = previousShots.map((shot) => shot.name).join('\n') !== shotInfos.map((shot) => shot.name).join('\n');
  if (taken > 0 || listChanged) writeFileSync(manifestFile, `${JSON.stringify({
    tool: 'cloud-lab-detail-distribution',
    generatedAt: new Date().toISOString(),
    gitHead: gitHead(root),
    shots: shotInfos,
  }, null, 2)}\n`);

  // --- 計測: 実写と撮影の各画像へ同じ物差しを当てる ---
  // 区分 × 段 × 特徴量 id で、実写と生成の値の列を集める。
  const columns = new Map();
  const columnKey = (category, kmPerPx, id) => `${category}|${kmPerPx}|${id}`;
  const addValue = (category, kmPerPx, entry, side, sunCosZenith = null) => {
    const key = columnKey(category, kmPerPx, entry.id);
    if (!columns.has(key)) {
      columns.set(key, {
        category, kmPerPx, id: entry.id, family: entry.family, real: [], gen: [], genCosZenith: [],
      });
    }
    const column = columns.get(key);
    column[side].push(entry.value);
    if (sunCosZenith !== null) column.genCosZenith.push(sunCosZenith);
  };

  // 区分 × 段ごとに計測した画像の数(特徴量が出なかった画像を数えるための分母)。
  const imageCounts = {};
  const countImage = (category, kmPerPx, side) => {
    const key = `${category}|${kmPerPx}`;
    imageCounts[key] ??= { real: 0, gen: 0 };
    imageCounts[key][side]++;
  };

  let realCount = 0;
  let realMissing = 0;
  for (const point of eligible) {
    for (const kmPerPx of TIERS_KM_PER_PX) {
      const file = path.join(teacherDir, `${shotName(point.category, point.slot, kmPerPx)}.png`);
      if (!existsSync(file)) { realMissing++; continue; }
      const { features } = measureDetailImage(readFileSync(file), kmPerPx);
      for (const entry of features) addValue(point.category, kmPerPx, entry, 'real');
      countImage(point.category, kmPerPx, 'real');
      realCount++;
    }
  }
  console.log(`実写 ${realCount} 枚を計測した${realMissing > 0 ? `(欠測 ${realMissing} 枚)` : ''}`);

  let genCount = 0;
  let genMissing = 0;
  for (const target of targets) {
    const file = path.join(shotsDir, `${target.name}.png`);
    if (!existsSync(file)) { genMissing++; continue; }
    const info = shotInfos.find((shot) => shot.name === target.name);
    const sunCosZenith = info?.sunCosZenith ?? sunCosZenithOf(target.point.latitudeDeg);
    // 物差しの段は画像中心の実寸 km/px。値の列は段の目標 km/px で揃える — 扁平のぶんだけ
    // ずれる実寸で列を分けると、同じ段の実写と同じ列に乗らない。
    const { features } = measureDetailImage(
      readFileSync(file), info?.centerKmPerPx ?? target.kmPerPx,
      reflectanceNormalize ? sunCosZenith + SHOT_AMBIENT_FRACTION : 1);
    for (const entry of features) {
      addValue(target.category, target.kmPerPx, entry, 'gen', sunCosZenith);
    }
    countImage(target.category, target.kmPerPx, 'gen');
    genCount++;
  }
  console.log(`撮影 ${genCount} 枚を計測した${genMissing > 0 ? `(欠測 ${genMissing} 枚)` : ''}`);

  // --- 分布の比較: 特徴量ごとの分位点と正規化距離、家族ごとの平均 ---
  const distributions = {};
  const samples = {};
  for (const category of CATEGORY_ORDER) {
    distributions[category] = {};
    samples[category] = {};
    for (const kmPerPx of TIERS_KM_PER_PX) {
      const featureRows = {};
      const sampleRows = {};
      for (const column of columns.values()) {
        if (column.category !== category || column.kmPerPx !== kmPerPx) continue;
        if (column.real.length === 0 || column.gen.length === 0) continue;
        const realQ = quantilesAt(column.real);
        const genQ = quantilesAt(column.gen);
        const { distance, realWidth } = normalizedDistance(realQ, genQ);
        featureRows[column.id] = {
          family: column.family, realQ, genQ, realWidth, distance,
          realCount: column.real.length, genCount: column.gen.length,
        };
        sampleRows[column.id] = { real: column.real, gen: column.gen };
      }
      const families = {};
      for (const family of FAMILIES) {
        const distances = Object.values(featureRows)
          .filter((row) => row.family === family).map((row) => row.distance);
        if (distances.length > 0) {
          families[family] = distances.reduce((sum, d) => sum + d, 0) / distances.length;
        }
      }
      distributions[category][kmPerPx] = {
        families,
        features: featureRows,
        imageCounts: imageCounts[`${category}|${kmPerPx}`] ?? { real: 0, gen: 0 },
      };
      samples[category][kmPerPx] = sampleRows;
    }
  }

  console.log('\n=== 分布の距離(区分 × 段、家族ごとの正規化ワッサースタイン距離の平均) ===');
  console.log(`${'区分'.padEnd(15)} ${'段'.padStart(4)}  ${FAMILIES.map((family) => family.padStart(13)).join(' ')}`);
  for (const category of CATEGORY_ORDER) {
    for (const kmPerPx of TIERS_KM_PER_PX) {
      const cell = distributions[category][kmPerPx];
      console.log(`${category.padEnd(15)} ${`${kmPerPx}km`.padStart(4)}  ${FAMILIES.map((family) => {
        const value = cell?.families[family];
        return (value === undefined ? '-'.padStart(13) : value.toFixed(3).padStart(13));
      }).join(' ')}`);
    }
  }

  console.log('\n=== 重要な特徴量の分位点(実写 / 生成) ===');
  for (const category of CATEGORY_ORDER) {
    for (const kmPerPx of TIERS_KM_PER_PX) {
      const features = distributions[category][kmPerPx]?.features ?? {};
      const rows = KEY_FEATURES.filter((id) => features[id] !== undefined);
      if (rows.length === 0) continue;
      console.log(`\n${category} ${kmPerPx}km`);
      console.log(`${'特徴量'.padEnd(12)} ${'側'.padEnd(4)} ${QUANTILE_FRACTIONS.map((f) => `p${f * 100}`.padStart(9)).join(' ')}`);
      for (const id of rows) {
        const row = features[id];
        console.log(`${id.padEnd(12)} ${'実写'.padEnd(4)} ${row.realQ.map((q) => q.toFixed(3).padStart(9)).join(' ')}`);
        console.log(`${''.padEnd(12)} ${'生成'.padEnd(4)} ${row.genQ.map((q) => q.toFixed(3).padStart(9)).join(' ')}  距離 ${row.distance.toFixed(3)}`);
      }
    }
  }

  // --- 太陽天頂角の監査 ---
  // 生成の撮影の値を、同じ列(区分 × 段)の実写の中央値で割った比を取り、撮影の照明
  // (太陽天頂角の余弦 + 環境光)と並べる。比が照明に比例するなら(両対数の傾きが 1 なら)、
  // 生成の画の暗さは雲の性質ではなく、放射輝度を反射率と読んでいた測り方の不整合である。
  // 「補正後」は比をその点の照明で割ったもの — 反射率へ換算したあとに残る本物の比。
  console.log('\n=== 太陽天頂角の監査(生成の値 / 実写の中央値 と照明) ===');
  console.log(`生成側の換算: ${reflectanceNormalize ? `トーンマップを戻して cosZ+${SHOT_AMBIENT_FRACTION} で割って計測済み` : '素通し'}`);
  for (const id of ZENITH_AUDIT_FEATURES) {
    const pairs = [];
    const rows = [];
    for (const column of columns.values()) {
      if (column.id !== id || column.real.length === 0 || column.genCosZenith.length === 0) continue;
      const realMedian = quantiles(column.real, [0.5])[0];
      if (realMedian <= 0) continue;
      const ratios = column.gen.map((value, i) => {
        const cosZ = column.genCosZenith[i];
        return { ratio: value / realMedian, illumination: cosZ + SHOT_AMBIENT_FRACTION };
      });
      const medRatio = quantiles(ratios.map((r) => r.ratio), [0.5])[0];
      // 反射率へ換算したあとに残る比。換算済みで計測しているときは計測値そのもの。
      const medCorrected = reflectanceNormalize
        ? medRatio
        : quantiles(ratios.map((r) => r.ratio / r.illumination), [0.5])[0];
      rows.push({
        category: column.category,
        kmPerPx: column.kmPerPx,
        medCosZ: quantiles(ratios.map((r) => r.illumination - SHOT_AMBIENT_FRACTION), [0.5])[0],
        medRatio,
        medCorrected,
      });
      for (const r of ratios) {
        if (r.ratio > 0) pairs.push([Math.log(r.illumination), Math.log(r.ratio)]);
      }
    }
    if (rows.length === 0) continue;
    const { slope, intercept } = fitLine(pairs);
    console.log(`\n${id}: 点 ${pairs.length} — log(比) vs log(照明) 傾き ${slope.toFixed(2)}・切片での比 ${Math.exp(intercept).toFixed(2)}`);
    console.log(`${'区分'.padEnd(15)} ${'段'.padStart(4)}  ${'cosZ中央'.padStart(8)} ${'比中央'.padStart(8)} ${'補正後'.padStart(8)}`);
    for (const row of rows) {
      console.log(`${row.category.padEnd(15)} ${`${row.kmPerPx}km`.padStart(4)}  ${row.medCosZ.toFixed(3).padStart(8)} ${row.medRatio.toFixed(3).padStart(8)} ${row.medCorrected.toFixed(3).padStart(8)}`);
    }
  }

  console.log('\n=== 特徴量が出なかった画像の数(区分 × 段。周期の峰 excess・雲の塊 cloudCount) ===');
  for (const category of CATEGORY_ORDER) {
    for (const kmPerPx of TIERS_KM_PER_PX) {
      const images = imageCounts[`${category}|${kmPerPx}`] ?? { real: 0, gen: 0 };
      const unmeasured = (id, side) => images[side] - (columns.get(columnKey(category, kmPerPx, id))?.[side].length ?? 0);
      const parts = ['excess', 'cloudCount'].map((id) => `${id} 実写 ${unmeasured(id, 'real')}/${images.real} 生成 ${unmeasured(id, 'gen')}/${images.gen}`);
      console.log(`${category.padEnd(15)} ${`${kmPerPx}km`.padStart(4)}  ${parts.join('  ')}`);
    }
  }

  // --- レポート ---
  const report = {
    meta: {
      tool: 'cloud-lab-detail-distribution',
      reportVersion: 1,
      generatedAt: new Date().toISOString(),
      gitHead: gitHead(root),
      teacherSeed: teacher.seed ?? null,
      reflectanceNormalize,
      points: genPoints.length,
      realImages: realCount,
      realMissing,
      genImages: genCount,
      genMissing,
      shotTargets: targets.length,
      shotsGitHead: existsSync(manifestFile)
        ? JSON.parse(readFileSync(manifestFile, 'utf8')).gitHead ?? null
        : null,
    },
    sections: { distributions, samples },
  };

  // 前回の同じ道具のレポートを探す。履歴には別の道具(cloud-lab-detail-compare)のレポートも混ざるので、
  // meta.tool で絞る。
  let previousName;
  if (existsSync(historyDir)) {
    for (const name of readdirSync(historyDir).filter((n) => n.endsWith('.json')).sort().reverse()) {
      const report = readReport(historyDir, name);
      if (report?.meta?.tool === 'cloud-lab-detail-distribution') { previousName = name; break; }
    }
  }
  saveReport(historyDir, report);
  console.log('\n=== 前回レポートとの差分 ===');
  if (previousName === undefined) {
    console.log('同じ道具の前回レポートが無い(今回が初回)');
  } else {
    const previous = readReport(historyDir, previousName);
    if (previous?.sections?.distributions === undefined) {
      console.log(`${previousName} が読めないため差分を出せない`);
    } else {
      // 生の値の列(samples)は撮り直しのたびに変わる比較対象ではないので、距離と分位点だけを比べる。
      const diffs = { compared: 0, changed: [] };
      collectNumericDiffs(previous.sections.distributions, report.sections.distributions, '', diffs);
      for (const { path: leaf, before, after } of diffs.changed.slice(0, 50)) {
        const delta = after - before;
        console.log(`${leaf}: ${formatDiffValue(before)} → ${formatDiffValue(after)} (${delta >= 0 ? '+' : ''}${formatDiffValue(delta)})`);
      }
      console.log(diffs.changed.length === 0
        ? `変わった数値なし(比較した数値 ${diffs.compared}、前回: ${previousName})`
        : `変わった数値 ${diffs.changed.length} / ${diffs.compared}(前回: ${previousName})`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
