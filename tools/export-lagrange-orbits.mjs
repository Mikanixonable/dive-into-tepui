// CR3BP 周期軌道族の焼き込みツール。assets-src/orbits/<系>.json(JPL から取得し間引いた初期条件、
// tools/fetch-orbit-catalog.mjs が生成)を読み、各メンバーをその系の JPL μ で1周期積分して
// src/physics/orbit-catalog.ts の OrbitCatalog 形式へ落とす。API へは接続しない。
//
// 実行: node tools/export-lagrange-orbits.mjs
//
// JPL の μ は本リポジトリのレジストリと僅かに(地球-月で相対 4.2e-4)異なるが、初期条件は
// 「種」として扱い、その μ のまま積分した無次元形状をそのまま焼き込む(微分修正はかけ直さない)。
// 実スケールへの写像・実際の天体位置への配置は実行時(orbit-guide.ts 側)の責務。
//
// 同じ入力(assets-src/orbits/ の内容)からは常に同じ出力を書く。
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPhysicsModules } from './compile-physics.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(repoRoot, 'assets-src', 'orbits');
const assetsDir = join(repoRoot, 'src', 'assets', 'orbits');

// バンドルへ静的 import で埋め込む系(計画書 8.1)。残りは系ごとに別ファイルへ出し、
// 表示時に遅延ロードする前提で分ける。
const BUNDLED_SYSTEMS = ['earth-moon', 'sun-earth'];

// 1メンバーあたりの点数。バンドルがサイズ目標を超えたときだけ FALLBACK へ落とす。
const SAMPLES_DEFAULT = 96;
const SAMPLES_FALLBACK = 64;
// バンドルへ埋める2系合計のサイズ目標(計画書 3.4 / 8.1)。
const BUNDLE_SIZE_TARGET = 4.9 * 1024 * 1024;
// 1周期積分の刻み数。閉合判定と弧長サンプリングの両方に使う。RK4 は刻みを半分にすると
// 誤差が約1/16になるので、4000 では周期の長い族(sun-mars の vertical など)で積分誤差が
// 閉合残差の許容 1e-3 に届かず、実際には周期軌道であるメンバーを誤って除外してしまう。
const PROPAGATE_STEPS = 16000;
// 周期軌道として認める閉合残差(軌道の広がりに対する比)。超えたメンバーは除外する。
const CLOSURE_TOLERANCE = 1e-3;

const physics = loadPhysicsModules(['cr3bp']);
const { cr3bp } = physics;

// 点列の中心から最も離れた点までの距離。閉合残差を測る物差しにする。
function orbitSize(points) {
  const n = points.length;
  const center = [0, 1, 2].map((j) => points.reduce((sum, p) => sum + p[j], 0) / n);
  return Math.max(...points.map((p) => Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2])));
}

// メンバー1件を積分し、弧長等間隔+時刻割合つきの点列と閉合残差を求める。
// 残差が許容を超えたら null(呼び出し側が除外して報告する)。
function bakeMember(mu, raw, samples) {
  const state = raw.state;
  const sampled = cr3bp.sampleOrbitByArcLengthWithTime(mu, state, raw.period, samples, PROPAGATE_STEPS);
  const end = cr3bp.cr3bpPropagate(mu, state, raw.period, PROPAGATE_STEPS);
  const gap = Math.hypot(end[0] - state[0], end[1] - state[1], end[2] - state[2]);
  const size = orbitSize(sampled);
  const residual = size > 0 ? gap / size : Infinity;
  if (!(residual < CLOSURE_TOLERANCE)) return { ok: false, residual };
  return { ok: true, points: sampled, jacobi: raw.jacobi, period: raw.period, stability: raw.stability };
}

// 1系ぶんのキャッシュを焼き込む。excluded に除外したメンバーの報告を積む。
function bakeSystem(cache, samples, excluded) {
  const families = {};
  for (const [familyKey, family] of Object.entries(cache.families)) {
    const records = [];
    const pointChunks = [];
    family.members.forEach((raw, i) => {
      const baked = bakeMember(cache.mu, raw, samples);
      if (!baked.ok) {
        excluded.push(`${cache.system} ${familyKey}[${i}]: 閉合残差 ${baked.residual.toExponential(2)}`);
        return;
      }
      records.push({
        period: baked.period,
        jacobi: baked.jacobi,
        stability: baked.stability,
      });
      const chunk = new Float32Array(samples * 4);
      baked.points.forEach((p, j) => chunk.set(p, j * 4));
      pointChunks.push(chunk);
    });
    if (records.length === 0) {
      excluded.push(`${cache.system} ${familyKey}: 閉合するメンバーが1件も無いため出力しない`);
      continue;
    }
    // s=0 を必ず「小さい側」に揃える。JPL が族を返す向きは族によって違うので、両端の広がりを
    // 比べて必要なら反転する。こうしないと、同じ 0 が族によって小振幅だったり大振幅だったり
    // して、族範囲スライダーの意味が族ごとに変わってしまう。
    if (records.length > 1) {
      const spread = (chunk) => {
        let max = 0;
        for (let i = 0; i < samples; i++) {
          const o = i * 4;
          max = Math.max(max, Math.hypot(chunk[o], chunk[o + 1], chunk[o + 2]));
        }
        return max;
      };
      if (spread(pointChunks[0]) > spread(pointChunks[pointChunks.length - 1])) {
        records.reverse();
        pointChunks.reverse();
      }
    }

    // s は「焼けた族に沿った位置」なので、閉合しないメンバーを落とし終えてから 0..1 へ割り振る。
    // 除外前の添字で振ると、端が落ちた族の s が 0 や 1 から始まらなくなる。
    const kept = records.length;
    records.forEach((record, i) => { record.s = kept > 1 ? i / (kept - 1) : 0; });

    const merged = new Float32Array(records.length * samples * 4);
    pointChunks.forEach((chunk, i) => merged.set(chunk, i * samples * 4));
    families[familyKey] = {
      members: records,
      samples,
      points: Buffer.from(merged.buffer, merged.byteOffset, merged.byteLength).toString('base64'),
    };
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
