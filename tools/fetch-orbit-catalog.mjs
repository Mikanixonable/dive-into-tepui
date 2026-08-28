// JPL の Three-Body Periodic Orbits API から、CR3BP 周期軌道族の初期条件を取得し、族に沿って
// 等間隔に間引いて assets-src/orbits/<系>.json へキャッシュするツール。
//
// API はメンバーをヤコビ定数の昇順で返す。これは族に沿った連続順ではない — ヤコビ定数が
// 折り返す族(地球-月 L1 ハローなど)では、族の離れた区間どうしが交互に並ぶ。そのままでは
// 軌道ガイドが族に沿って連続に変化しなくなるので、初期状態ベクトルの連続性から族の順序を
// 復元してから間引く。
//
// 復元した並びが繋がらない(互いに独立な枝が混じっている)ことがあるため、断絶で区切った
// 連続区間ごとに別の族として保存する(tools/orbit-family.mjs の splitAtBreaks)。区間の族 id
// には segmentFamilyKey で `#1` `#2` … を付ける。
//
// 区間ごとの保存件数(MEMBERS_PER_FAMILY)は、実際に表示へ使う件数より多く持たせてある。
// 焼き込み(tools/export-lagrange-orbits.mjs)が主星・副星へ衝突するメンバーをこの中から
// 落としたうえで表示件数へ選び直すため、選び直す余地を残す必要がある。
//
// 実行: node tools/fetch-orbit-catalog.mjs
//
// ここで保存する初期条件が、リポジトリにコミットされる唯一の生データになる(数十MBの全件は
// 保存しない)。焼き込みはこのキャッシュだけを読み、API へは接続しない。
//
// 同じ入力(API の応答)からは常に同じ出力を書く。時刻・環境に依存する値は含めない。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { segmentFamilyKey, splitAtBreaks, squaredStateDistance, thinByChordLength } from './orbit-family.mjs';

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

// 区間あたりに保存するメンバー数の目安。表示に使う件数(30 件)より多く持たせてあるのは、
// 焼き込み側が主星・副星へ衝突するメンバーをここから落としたあとで、表示件数へ選び直す
// 余地を残すため。
const MEMBERS_PER_FAMILY = 120;
// 断絶で区切った区間がこれ未満の行数(生データ、間引き前)なら、族として意味をなさないので
// 落とす。
const MIN_SEGMENT_LENGTH = 20;
// 同時に投げるリクエスト数。ドキュメントにレート制限の明記がないため控えめに絞る。
const CONCURRENCY = 4;

// 未使用の中で from にいちばん近い行の添字と、その2乗距離。
function nearestUnused(rows, used, from) {
  let bestIndex = -1;
  let bestDistance = Infinity;
  for (let j = 0; j < rows.length; j++) {
    if (used[j]) continue;
    const distance = squaredStateDistance(rows, from, j);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = j;
    }
  }
  return { index: bestIndex, distance: bestDistance };
}

// startIndex を起点に、未使用の最近傍を順に辿って1本の鎖(添字の並び)を作る。
// 伸ばす向きは鎖の両端から近いほうを毎回選ぶ。片方向にしか伸ばさないと、起点が族の途中に
// あったときに一方の端で行き止まり、そこから反対側へ跳んで並びが壊れる。
function buildNearestNeighborChain(rows, startIndex) {
  const n = rows.length;
  const used = new Uint8Array(n);
  // 前へ伸ばした側は逆順に積み、最後に反転して繋ぐ(先頭への挿入を繰り返さないため)。
  const headSide = [];
  const tailSide = [startIndex];
  used[startIndex] = 1;
  let head = startIndex;
  let tail = startIndex;
  for (let step = 1; step < n; step++) {
    const atHead = nearestUnused(rows, used, head);
    const atTail = head === tail ? atHead : nearestUnused(rows, used, tail);
    if (atTail.distance < atHead.distance) {
      tailSide.push(atTail.index);
      used[atTail.index] = 1;
      tail = atTail.index;
    } else {
      headSide.push(atHead.index);
      used[atHead.index] = 1;
      head = atHead.index;
    }
  }
  return headSide.reverse().concat(tailSide);
}

// 鎖の隣接ステップ距離を、並びの順に返す。
function chainSteps(rows, order) {
  const steps = [];
  for (let i = 1; i < order.length; i++) {
    steps.push(Math.sqrt(squaredStateDistance(rows, order[i - 1], order[i])));
  }
  return steps;
}

// 並びに沿った総弦長。並べ替えが元の順より良くなっていることの確認に使う。
function totalChainLength(rows, order) {
  return chainSteps(rows, order).reduce((sum, step) => sum + step, 0);
}

// API が返す C 昇順の rows を、6次元状態ベクトルの連続性で族に沿った順へ並べ替えたうえで、
// 断絶で区切った連続区間の配列(rows の配列)へ分ける。
// 貪欲最近傍で鎖を組み、総弦長が元の C 順より短くなっていれば採る(短くならないのは、族が
// もともと C について単調で並べ替えるまでもない場合か、データに構造が無い場合)。
// MIN_SEGMENT_LENGTH に満たない区間は splitAtBreaks が落とすので、ここでは返さない
// (呼び出し側が落ちた行数を警告する)。
function orderFamilyByContinuity(rows) {
  if (rows.length < 3) return splitAtBreaks(rows, MIN_SEGMENT_LENGTH);

  const identity = rows.map((_, index) => index);
  const chain = buildNearestNeighborChain(rows, 0);
  const ordered = totalChainLength(rows, chain) > totalChainLength(rows, identity)
    ? rows
    : chain.map((index) => rows[index]);
  return splitAtBreaks(ordered, MIN_SEGMENT_LENGTH);
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
  const warnings = [];
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
        const segments = orderFamilyByContinuity(result.rows);
        const droppedCount = result.rows.length - segments.reduce((sum, segment) => sum + segment.length, 0);
        if (droppedCount > 0) {
          warnings.push(`${sys} ${key}: MIN_SEGMENT_LENGTH 未満の区間・断絶の孤立行として ${droppedCount} 件を除外`);
        }
        if (segments.length === 0) {
          warnings.push(`${sys} ${key}: 連続する区間が1つも残らなかったため除外`);
          return;
        }
        if (segments.length > 1) {
          const lengths = segments.map((segment) => `${segment.length} 件`).join('、');
          warnings.push(`${sys} ${key}: 族が繋がらないため ${segments.length} 区間へ分けた(${lengths})`);
        }
        segments.forEach((segment, index) => {
          const segmentKey = segmentFamilyKey(key, index, segments.length);
          const thinned = thinByChordLength(segment, MEMBERS_PER_FAMILY);
          families[segmentKey] = {
            libr: combo.fixedLibr ?? combo.libr,
            branch: combo.branch,
            totalCount: segment.length,
            members: thinned.map(([x, y, z, vx, vy, vz, jacobi, period, stability]) => ({
              state: [x, y, z, vx, vy, vz],
              jacobi, period, stability,
            })),
          };
        });
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
  if (warnings.length > 0) {
    process.stderr.write(`\n1本の連続した列にならなかった族:\n${warnings.map((w) => `  ${w}`).join('\n')}\n`);
  }
}

main();
