// JPL の Three-Body Periodic Orbits API から、CR3BP 周期軌道族の初期条件を取得し、族に沿って
// 等間隔に間引いて assets-src/orbits/<系>.json へキャッシュするツール。
//
// 実行: node tools/fetch-orbit-catalog.mjs
//
// ここで保存する初期条件が、リポジトリにコミットされる唯一の生データになる(数十MBの全件は
// 保存しない)。焼き込み(tools/export-lagrange-orbits.mjs)はこのキャッシュだけを読み、
// API へは接続しない。
//
// 同じ入力(API の応答)からは常に同じ出力を書く。時刻・環境に依存する値は含めない。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(repoRoot, 'assets-src', 'orbits');

const API_BASE = 'https://ssd-api.jpl.nasa.gov/periodic_orbits.api';

// 対象の7系。JPL の sys パラメータと同じ識別子を使う(src/physics/orbit-catalog.ts の
// CatalogSystemId と揃える)。
const SYSTEMS = [
  'earth-moon', 'sun-earth', 'sun-mars',
  'jupiter-europa', 'saturn-titan', 'saturn-enceladus', 'mars-phobos',
];

// ファミリーごとに取りうる libr(ラグランジュ点)・branch の組み合わせ。
// null は「そのパラメータを付けない」ことを表す。2.6 節の実測に基づく。
const FAMILY_SPECS = [
  { family: 'halo', librs: [1, 2, 3], branches: ['N', 'S'] },
  { family: 'vertical', librs: [1, 2, 3, 4, 5], branches: [null] },
  { family: 'axial', librs: [1, 2, 3, 4, 5], branches: [null] },
  { family: 'lyapunov', librs: [1, 2, 3], branches: [null] },
  { family: 'longp', librs: [4, 5], branches: [null] },
  { family: 'short', librs: [4, 5], branches: [null] },
  // butterfly・dragonfly は libr を指定できず、L2 のみに存在する(計画書 4.1)。
  { family: 'butterfly', librs: [null], branches: ['N', 'S'], fixedLibr: 2 },
  { family: 'dragonfly', librs: [null], branches: ['N', 'S'], fixedLibr: 2 },
  { family: 'dro', librs: [null], branches: [null] },
  { family: 'dpo', librs: [null], branches: [null] },
  { family: 'lpo', librs: [null], branches: ['E', 'W'] },
  // 共鳴軌道の branch は比を連結した表記(12 が 1:2 など)。
  { family: 'resonant', librs: [null], branches: ['12', '21', '31', '23', '43', '34'] },
];

// 族あたりに保存するメンバー数の目安。
const MEMBERS_PER_FAMILY = 30;
// 同時に投げるリクエスト数。ドキュメントにレート制限の明記がないため控えめに絞る。
const CONCURRENCY = 4;

// 族に沿って(API が返す順のまま)等間隔に count 件を選ぶ。先頭と末尾は必ず含む。
function thinAlongFamily(rows, count) {
  if (rows.length <= count) return rows;
  const picked = [];
  const seen = new Set();
  for (let i = 0; i < count; i++) {
    const index = Math.round((i * (rows.length - 1)) / (count - 1));
    if (seen.has(index)) continue;
    seen.add(index);
    picked.push(rows[index]);
  }
  return picked;
}

// クエリ文字列を組み立てる。
function buildUrl(sys, family, libr, branch) {
  const params = new URLSearchParams({ sys, family });
  if (libr !== null) params.set('libr', String(libr));
  if (branch !== null) params.set('branch', branch);
  return `${API_BASE}?${params.toString()}`;
}

// 族の識別子。src/physics/orbit-catalog.ts の CatalogFamilyId の規約
// (`<族>` / `<族>-<ラグランジュ点>` / `<族>-<ラグランジュ点>-<枝>`)に揃える。
// butterfly・dragonfly は libr を指定しないが、常に L2 なので明示的に L2 を書く。
function familyKey(family, libr, branch, fixedLibr) {
  const point = fixedLibr ?? libr;
  const parts = [family];
  if (point !== null && point !== undefined) parts.push(`L${point}`);
  if (branch !== null) parts.push(branch);
  return parts.join('-');
}

// 1つの (sys, family, libr, branch) の組み合わせを取得する。
// 無効な組み合わせ(400)は静かに null を返す(推測で組み合わせを決めていないことの裏返しとして、
// API 自身に存在可否を判定させる)。それ以外の失敗は例外を投げて呼び出し側で記録させる。
async function fetchCombo(sys, family, libr, branch) {
  const url = buildUrl(sys, family, libr, branch);
  const RETRY_COUNT = 4;
  let response = null;
  for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
    response = await fetch(url);
    if (response.status === 400) return null;
    if (response.ok) break;
    if (attempt === RETRY_COUNT) throw new Error(`HTTP ${response.status} ${url}`);
    // 5xx はサーバ側の一時的な不調であることが多い。間隔を空けて数回だけ再試行する。
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
  }
  const body = await response.json();
  const count = Number(body.count ?? 0);
  if (!Number.isFinite(count) || count <= 0) return null;
  const fieldNames = body.fields;
  const expected = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'jacobi', 'period', 'stability'];
  if (JSON.stringify(fieldNames) !== JSON.stringify(expected)) {
    throw new Error(`想定外の fields: ${JSON.stringify(fieldNames)} (${url})`);
  }
  const rows = body.data.map((row) => row.map(Number));
  return { system: body.system, rows };
}

// タスクを CONCURRENCY 件ずつ並行して処理する。
async function runPool(tasks, worker) {
  const results = new Array(tasks.length);
  let cursor = 0;
  async function runOne() {
    while (cursor < tasks.length) {
      const index = cursor++;
      results[index] = await worker(tasks[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, runOne));
  return results;
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const failures = [];
  const report = [];

  for (const sys of SYSTEMS) {
    const combos = [];
    for (const spec of FAMILY_SPECS) {
      for (const libr of spec.librs) {
        for (const branch of spec.branches) {
          combos.push({ family: spec.family, libr, branch, fixedLibr: spec.fixedLibr ?? null });
        }
      }
    }

    let systemMeta = null;
    const families = {};

    await runPool(combos, async (combo) => {
      const key = familyKey(combo.family, combo.libr, combo.branch, combo.fixedLibr);
      try {
        const result = await fetchCombo(sys, combo.family, combo.libr, combo.branch);
        if (result === null) return; // 無効・空の組み合わせ。この系にこの族は無い。
        systemMeta ??= result.system;
        const thinned = thinAlongFamily(result.rows, MEMBERS_PER_FAMILY);
        families[key] = {
          libr: combo.fixedLibr ?? combo.libr,
          branch: combo.branch,
          totalCount: result.rows.length,
          members: thinned.map(([x, y, z, vx, vy, vz, jacobi, period, stability]) => ({
            state: [x, y, z, vx, vy, vz],
            jacobi, period, stability,
          })),
        };
      } catch (error) {
        failures.push(`${sys} ${key}: ${error.message}`);
      }
    });

    if (systemMeta === null) {
      failures.push(`${sys}: 有効なファミリーが1件も取得できなかった`);
      continue;
    }

    const familyCount = Object.keys(families).length;
    const memberTotal = Object.values(families).reduce((sum, f) => sum + f.members.length, 0);
    report.push(`${sys}: 族 ${familyCount} 件 / メンバー計 ${memberTotal} 件`);
    for (const [key, f] of Object.entries(families).sort(([a], [b]) => a.localeCompare(b))) {
      report.push(`  ${key}: ${f.members.length} 件(元 ${f.totalCount} 件)`);
    }

    const document = {
      system: sys,
      mu: Number(systemMeta.mass_ratio),
      lunit: systemMeta.lunit,
      tunit: systemMeta.tunit,
      secondaryRadius: systemMeta.radius_secondary,
      families,
    };
    // キーの並びを安定させ、差分レビューしやすくする。
    const sortedFamilies = {};
    for (const key of Object.keys(families).sort()) sortedFamilies[key] = families[key];
    document.families = sortedFamilies;

    const outPath = join(outDir, `${sys}.json`);
    writeFileSync(outPath, `${JSON.stringify(document, null, 1)}\n`, 'utf8');
    process.stderr.write(`${outPath} を書き出した\n`);
  }

  process.stderr.write(`\n${report.join('\n')}\n`);
  if (failures.length > 0) {
    process.stderr.write(`\n取得に失敗した組み合わせ:\n${failures.map((f) => `  ${f}`).join('\n')}\n`);
  }
}

main();
