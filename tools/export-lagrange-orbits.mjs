// CR3BP 周期軌道族の焼き込みツール。assets-src/orbits/<系>.json(JPL から取得した族あたり120件の
// 初期条件、tools/fetch-orbit-catalog.mjs が生成)を読み、各メンバーをその系の JPL μ で1周期積分し、
// 閉合しないメンバーと主星・副星に衝突するメンバーを落としたうえで、残ったものから族あたり
// MEMBERS_PER_FAMILY 件を選び直して src/physics/orbit-catalog.ts の OrbitCatalog 形式へ落とす。
// API へは接続しない。
//
// 実行: node tools/export-lagrange-orbits.mjs
//
// JPL の μ は本リポジトリのレジストリと僅かに(地球-月で相対 4.2e-4)異なるが、初期条件は
// 「種」として扱い、その μ のまま積分した無次元形状をそのまま焼き込む(微分修正はかけ直さない)。
// 実スケールへの写像・実際の天体位置への配置は実行時(orbit-guide.ts 側)の責務。
//
// 使えるメンバー(閉合残差が許容内 かつ 主星・副星いずれにも衝突しない)が連続する区間だけを
// 族として出す(DEVELOP/SPEC/MAP.md「ガイド線の正確さ」)。1つの族が複数の区間に分かれたときは
// tools/orbit-family.mjs の segmentFamilyKey で区間ごとに族 id を振り、各区間の中で
// thinByChordLength により弧長等間隔の MEMBERS_PER_FAMILY 件へ選び直す。
//
// 同じ入力(assets-src/orbits/ の内容)からは常に同じ出力を書く。
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPhysicsModules } from './compile-physics.mjs';
import { keepLongEnough, segmentFamilyKey, splitSegmentKey, thinByChordLength } from './orbit-family.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(repoRoot, 'assets-src', 'orbits');
const assetsDir = join(repoRoot, 'src', 'assets', 'orbits');

// バンドルへ静的 import で埋め込む系(計画書 8.1)。残りは系ごとに別ファイルへ出し、
// 表示時に遅延ロードする前提で分ける。
const BUNDLED_SYSTEMS = ['earth-moon', 'sun-earth'];

// 1メンバーあたりの点数。点と点の間は速度を接線とするエルミート補間で埋まるので、位置だけを
// 線形に繋いでいた頃の半分で同じ滑らかさが出る。バンドルがサイズ目標を超えたときだけ
// FALLBACK へ落とす。
const SAMPLES_DEFAULT = 48;
const SAMPLES_FALLBACK = 32;
// 1点あたりの値の数([x, y, z, tFrac, vx, vy, vz]、src/physics/orbit-catalog.ts の
// CATALOG_STRIDE と一致させること)。
const STRIDE = 7;
// バンドルへ埋める2系合計のサイズ目標(計画書 3.4 / 8.1)。
const BUNDLE_SIZE_TARGET = 4.9 * 1024 * 1024;
// 1周期積分の刻み数。閉合判定と弧長サンプリングの両方に使う。RK4 は刻みを半分にすると
// 誤差が約1/16になるので、4000 では周期の長い族(sun-mars の vertical など)で積分誤差が
// 閉合残差の許容 1e-3 に届かず、実際には周期軌道であるメンバーを誤って除外してしまう。
const PROPAGATE_STEPS = 16000;
// 周期軌道として認める閉合残差(軌道の広がりに対する比)。超えたメンバーは除外する。
const CLOSURE_TOLERANCE = 1e-3;
// 区間(使えるメンバーが連続する範囲)ごとに焼き込むメンバー数。取得側は族あたり120件を
// 保存するが、120件すべてを焼き込むとバンドル・遅延ロードファイルのサイズが現状の4倍に
// 膨らむため、弧長等間隔で選び直してサイズを現状のまま保つ。
const MEMBERS_PER_FAMILY = 30;
// 族が複数の区間へ分かれたとき、この件数に満たない区間は断片とみなして出さない。
// 区間が1つしか無い族(分かれなかった族)には効かせない。
const MIN_SEGMENT_LENGTH = 3;

const physics = loadPhysicsModules(['cr3bp', 'solar-system']);
const { cr3bp, solarSystem } = physics;

// 系の主天体 id(src/physics/solar-system.ts の SOLAR_SYSTEM キーと対応)。JPL の族データは
// 副天体の半径しか返さないため、主天体への衝突判定にはゲームのレジストリの半径を使う。
const PRIMARY_BODY = {
  'earth-moon': 'earth',
  'sun-earth': 'sun',
  'sun-mars': 'sun',
  'jupiter-europa': 'jupiter',
  'saturn-titan': 'saturn',
  'saturn-enceladus': 'saturn',
  'mars-phobos': 'mars',
};

// 系の主天体の半径 [km]。
function primaryRadiusKm(system) {
  const bodyId = PRIMARY_BODY[system];
  const body = solarSystem.SOLAR_SYSTEM[bodyId];
  return body.radius / 1000;
}

// 点列の中心から最も離れた点までの距離。閉合残差を測る物差しにする。
function orbitSize(points) {
  const n = points.length;
  const center = [0, 1, 2].map((j) => points.reduce((sum, p) => sum + p[j], 0) / n);
  return Math.max(...points.map((p) => Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2])));
}

// centerX(CR3BP 無次元座標での中心天体の x、重心原点)までの最近接距離 [km]。CR3BP は天体を
// 質点として扱うため、周期軌道として成り立つ点列でも実際の天体半径より近づくことがある。
function closestApproachKm(centerX, lunit, points) {
  let min = Infinity;
  for (const p of points) {
    const d = Math.hypot(p[0] - centerX, p[1], p[2]) * lunit;
    if (d < min) min = d;
  }
  return min;
}

// メンバー1件を積分し、弧長等間隔+時刻割合つきの点列・閉合残差・主天体/副天体への最近接距離を
// 求める。残差が許容を超えたら ok:false(呼び出し側が除外して報告する)。
function bakeMember(mu, lunit, raw, samples) {
  const state = raw.state;
  const sampled = cr3bp.sampleOrbitByArcLengthWithTime(mu, state, raw.period, samples, PROPAGATE_STEPS);
  const end = cr3bp.cr3bpPropagate(mu, state, raw.period, PROPAGATE_STEPS);
  const gap = Math.hypot(end[0] - state[0], end[1] - state[1], end[2] - state[2]);
  const size = orbitSize(sampled);
  const residual = size > 0 ? gap / size : Infinity;
  if (!(residual < CLOSURE_TOLERANCE)) return { ok: false, residual };
  return {
    ok: true,
    points: sampled,
    jacobi: raw.jacobi,
    period: raw.period,
    stability: raw.stability,
    periapsis: closestApproachKm(-mu, lunit, sampled),
    perilune: closestApproachKm(1 - mu, lunit, sampled),
  };
}

// 族1本ぶんの点列チャンク(Float32Array, samples*STRIDE)から orbitSize を求める。
// 軌道そのものの大きさで比べる。重心からの距離で測ると、副天体を回る小さな軌道でも
// 重心から遠ければ「大きい」と誤判定してしまう。
function chunkSize(chunk, samples) {
  const points = [];
  for (let i = 0; i < samples; i++) {
    const o = i * STRIDE;
    points.push([chunk[o], chunk[o + 1], chunk[o + 2]]);
  }
  return orbitSize(points);
}

// 使えるメンバー(閉合し、主星・副星いずれにも衝突しない)が連続する区間1本を、族の1エントリ
// (OrbitCatalog の1族ぶん)へ焼く。区間内から弧長等間隔で MEMBERS_PER_FAMILY 件を選び直す。
function bakeSegment(baked, samples) {
  // thinByChordLength は行の先頭6要素(状態ベクトル)しか見ないので、状態を先頭に置き、
  // 選ばれた行から元の baked エントリを引けるよう自身への参照を末尾に添える。
  const rows = baked.map((entry) => [...entry.raw.state, entry]);
  const picked = thinByChordLength(rows, MEMBERS_PER_FAMILY).map((row) => row[row.length - 1]);

  let records = picked.map((entry) => ({
    period: entry.period,
    jacobi: entry.jacobi,
    stability: entry.stability,
  }));
  let pointChunks = picked.map((entry) => {
    const chunk = new Float32Array(samples * STRIDE);
    entry.points.forEach((p, j) => chunk.set(p, j * STRIDE));
    return chunk;
  });

  // s=0 を必ず「小さい側」に揃える。JPL が族を返す向きは族によって違うので、区間の両端の
  // 広がりを比べて必要なら反転する。こうしないと、同じ 0 が族によって小振幅だったり
  // 大振幅だったりして、族範囲スライダーの意味が族ごとに変わってしまう。
  if (records.length > 1 && chunkSize(pointChunks[0], samples) > chunkSize(pointChunks[pointChunks.length - 1], samples)) {
    records.reverse();
    pointChunks.reverse();
  }

  // s は「区間に沿った位置」として区間ごとに 0..1 へ割り振る。
  const kept = records.length;
  records.forEach((record, i) => { record.s = kept > 1 ? i / (kept - 1) : 0; });

  const merged = new Float32Array(records.length * samples * STRIDE);
  pointChunks.forEach((chunk, i) => merged.set(chunk, i * samples * STRIDE));
  return {
    members: records,
    samples,
    points: Buffer.from(merged.buffer, merged.byteOffset, merged.byteLength).toString('base64'),
  };
}

// 1系ぶんのキャッシュを焼き込む。excluded に除外したメンバー・区間の報告を積む。
function bakeSystem(cache, samples, excluded) {
  const primaryRadius = primaryRadiusKm(cache.system);
  // 区間を除いた族 id ごとに、使えるメンバーの区間を集める。取得側が既に区間へ分けた族を
  // ここでさらに分けることがあるため、番号は最後に基底の族ごとへ通しで振り直す — 番号を
  // 入れ子にすると(`axial-L1#1#2`)id を解釈できなくなる。
  const byBaseKey = new Map();
  for (const [familyKey, family] of Object.entries(cache.families)) {
    const { baseKey, segment: cacheSegment } = splitSegmentKey(familyKey);
    // 各メンバーについて「使えるか」(閉合残差が許容内 かつ 主星・副星いずれにも衝突しない)を
    // 求める。閉合しないメンバーは baked を null にし、この時点で報告する。
    const baked = family.members.map((raw, i) => {
      const result = bakeMember(cache.mu, cache.lunit, raw, samples);
      if (!result.ok) {
        excluded.push(`${cache.system} ${familyKey}[${i}]: 閉合残差 ${result.residual.toExponential(2)}`);
        return null;
      }
      const collides = result.perilune < cache.secondaryRadius || result.periapsis < primaryRadius;
      return { raw, ...result, collides };
    });

    // 使えるメンバーが連続する区間へ分ける。族の途中で使えないメンバーが挟まっていても、
    // その前後は別々の区間として残す(族の途中に穴を開けない)。
    const segments = [];
    let segStart = -1;
    for (let i = 0; i <= baked.length; i++) {
      const usable = i < baked.length && baked[i] !== null && !baked[i].collides;
      if (usable && segStart < 0) segStart = i;
      if (!usable && segStart >= 0) {
        segments.push(baked.slice(segStart, i));
        segStart = -1;
      }
    }

    const validSegments = keepLongEnough(segments, MIN_SEGMENT_LENGTH);
    for (const segment of segments) {
      if (!validSegments.includes(segment)) {
        excluded.push(`${cache.system} ${familyKey}: 使えるメンバーが ${segment.length} 件しか連続しない区間を除外`);
      }
    }

    if (validSegments.length === 0) {
      excluded.push(`${cache.system} ${familyKey}: 閉合し主星・副星に衝突しないメンバーが1件も無いため出力しない`);
      continue;
    }

    if (!byBaseKey.has(baseKey)) byBaseKey.set(baseKey, []);
    for (const segment of validSegments) byBaseKey.get(baseKey).push({ cacheSegment, segment });
  }

  const families = {};
  for (const [baseKey, entries] of byBaseKey) {
    entries.sort((a, b) => a.cacheSegment - b.cacheSegment);
    entries.forEach(({ segment }, index) => {
      families[segmentFamilyKey(baseKey, index, entries.length)] = bakeSegment(segment, samples);
    });
  }
  return {
    mu: cache.mu,
    lunit: cache.lunit,
    tunit: cache.tunit,
    secondaryRadius: cache.secondaryRadius,
    families,
  };
}

function loadCache(system) {
  return JSON.parse(readFileSync(join(cacheDir, `${system}.json`), 'utf8'));
}

const cacheFiles = readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
const systemKeys = cacheFiles.map((f) => f.replace(/\.json$/, ''));

mkdirSync(assetsDir, { recursive: true });
const excluded = [];

// バンドル2系はサイズ目標を満たすまで点数を落として焼き直す。
let bundleSamples = SAMPLES_DEFAULT;
let bundleBytes = Infinity;
let bundleDocument = null;
for (const samples of [SAMPLES_DEFAULT, SAMPLES_FALLBACK]) {
  const perAttemptExcluded = [];
  const systems = {};
  for (const key of BUNDLED_SYSTEMS) {
    if (!systemKeys.includes(key)) continue;
    systems[key] = bakeSystem(loadCache(key), samples, perAttemptExcluded);
  }
  const document = { systems };
  const bytes = Buffer.byteLength(JSON.stringify(document), 'utf8');
  bundleSamples = samples;
  bundleBytes = bytes;
  bundleDocument = document;
  excluded.length = 0;
  excluded.push(...perAttemptExcluded);
  if (bytes <= BUNDLE_SIZE_TARGET) break;
  process.stderr.write(`バンドル2系が ${(bytes / 1024 / 1024).toFixed(2)}MB で目標超過。点数を落として焼き直す\n`);
}

// 残る系は遅延ロード用に系ごと1ファイルへ分ける。点数はバンドルと独立にデフォルトを使う。
const lazyKeys = systemKeys.filter((key) => !BUNDLED_SYSTEMS.includes(key));
const lazyReport = [];
const familyIndex = {};
for (const [key, system] of Object.entries(bundleDocument.systems)) {
  familyIndex[key] = Object.keys(system.families);
}
for (const key of lazyKeys) {
  const baked = bakeSystem(loadCache(key), SAMPLES_DEFAULT, excluded);
  const systemDoc = { systems: { [key]: baked } };
  const outPath = join(assetsDir, `lagrange-orbits-${key}.json`);
  const bytes = Buffer.byteLength(JSON.stringify(systemDoc), 'utf8');
  writeFileSync(outPath, `${JSON.stringify(systemDoc)}\n`, 'utf8');
  lazyReport.push(`${outPath}: ${(bytes / 1024 / 1024).toFixed(2)}MB`);
  familyIndex[key] = Object.keys(baked.families);
}

// 遅延ロードする系の族一覧もバンドルへ索引として入れる。UI は起動時に全系の選択肢を組める。
const bundlePath = join(assetsDir, 'lagrange-orbits.json');
const bundleWithIndex = { ...bundleDocument, familyIndex };
const bundleFinalBytes = Buffer.byteLength(JSON.stringify(bundleWithIndex), 'utf8');
writeFileSync(bundlePath, `${JSON.stringify(bundleWithIndex)}\n`, 'utf8');
process.stderr.write(
  `${bundlePath} を書き出した(1メンバー ${bundleSamples} 点、${(bundleFinalBytes / 1024 / 1024).toFixed(2)}MB)\n`,
);

physics.dispose();

process.stderr.write(`\n${lazyReport.join('\n')}\n`);
if (excluded.length > 0) {
  process.stderr.write(`\n閉合残差が許容を超えて除外したメンバー:\n${excluded.map((e) => `  ${e}`).join('\n')}\n`);
}
