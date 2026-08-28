// void-and-cluster (Ulichney 1993) で blue noise タイルを焼き、
// src/render/blue-noise-tile.generated.ts へ書き出す。
//
// blue noise が欲しいのは「値そのものがランダムなこと」ではなく、**近傍の画素どうしで値が
// 打ち消し合うこと**である。画素ごとの誤差の大きさはどんな 0..1 の列でも変わらず、目に見える
// のは局所平均の誤差だけなので、そこを小さくできる列だけが質を上げる。
//
// タイルは環状(上下左右が繋がる)に作るので、画面へ敷き詰めても継ぎ目が出ない。
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SIZE = 64;
// エネルギー関数のガウス幅 [px]。Ulichney の推奨値。狭いと粒が詰まり、広いと低周波が残る。
const SIGMA = 1.5;
// ガウスを打ち切る半径 [px]。σ の 4 倍あれば裾は無視できる。
const RADIUS = 6;
// 初期パターンに置く点の割合。1/10 前後なら後段の順位付けが安定する。
const SEED_RATIO = 10;

const N = SIZE * SIZE;
const kernel = [];
for (let dy = -RADIUS; dy <= RADIUS; dy++) {
  for (let dx = -RADIUS; dx <= RADIUS; dx++) {
    kernel.push([dx, dy, Math.exp(-(dx * dx + dy * dy) / (2 * SIGMA * SIGMA))]);
  }
}

const wrap = (v) => ((v % SIZE) + SIZE) % SIZE;

// 「1 の側」と「0 の側」のエネルギーを両方持つ。前半は 1 の詰まり、後半は 0 の詰まりを見るので、
// 片方だけでは足りない(ガウスを打ち切っている以上、和は定数にならない)。
const energyOne = new Float64Array(N);
const energyZero = new Float64Array(N);
const set = new Uint8Array(N);

function place(index, occupied) {
  const x = index % SIZE;
  const y = (index / SIZE) | 0;
  const sign = occupied ? 1 : -1;
  for (const [dx, dy, w] of kernel) {
    const at = wrap(y + dy) * SIZE + wrap(x + dx);
    energyOne[at] += sign * w;
    energyZero[at] -= sign * w;
  }
  set[index] = occupied ? 1 : 0;
}

// 最も詰まっている 1(周りに 1 が多い)。
function tightestCluster() {
  let best = -1;
  let bestEnergy = -Infinity;
  for (let i = 0; i < N; i++) if (set[i] && energyOne[i] > bestEnergy) { bestEnergy = energyOne[i]; best = i; }
  return best;
}

// 最も空いている 0(周りに 1 が少ない)。
function largestVoid() {
  let best = -1;
  let bestEnergy = Infinity;
  for (let i = 0; i < N; i++) if (!set[i] && energyOne[i] < bestEnergy) { bestEnergy = energyOne[i]; best = i; }
  return best;
}

// 最も詰まっている 0(周りに 0 が多い)。後半は 0 が少数派になるので、こちらを見る。
function tightestZeroCluster() {
  let best = -1;
  let bestEnergy = -Infinity;
  for (let i = 0; i < N; i++) if (!set[i] && energyZero[i] > bestEnergy) { bestEnergy = energyZero[i]; best = i; }
  return best;
}

// 再現性のために自前の線形合同法を使う。初期パターンの引き方だけに使う。
let seed = 20260828;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };

// すべて 0 の状態から始める。energyZero は全画素が 0 のぶんを最初に積む。
for (let i = 0; i < N; i++) place(i, false);
for (let i = 0; i < N; i++) set[i] = 0;
energyOne.fill(0);
energyZero.fill(0);
for (let i = 0; i < N; i++) {
  const x = i % SIZE;
  const y = (i / SIZE) | 0;
  for (const [dx, dy, w] of kernel) energyZero[wrap(y + dy) * SIZE + wrap(x + dx)] += w;
}

const ones = Math.max(1, Math.round(N / SEED_RATIO));
for (let placed = 0; placed < ones;) {
  const i = (rand() * N) | 0;
  if (set[i]) continue;
  place(i, true);
  placed++;
}

// 初期パターンを「どこも詰まっていない」状態まで揉む。詰まりを抜いた先が同じ場所へ戻ったら、
// それ以上ほぐせない。
for (let guard = 0; guard < 10 * N; guard++) {
  const cluster = tightestCluster();
  place(cluster, false);
  const hole = largestVoid();
  if (hole === cluster) { place(cluster, true); break; }
  place(hole, true);
}

const prototype = set.slice();
const rank = new Int32Array(N).fill(-1);

// 前半: 初期パターンから詰まっている順に抜き、若い順位を与える。
for (let r = ones - 1; r >= 0; r--) {
  const i = tightestCluster();
  rank[i] = r;
  place(i, false);
}

// 初期パターンへ戻す。
for (let i = 0; i < N; i++) if (set[i] !== prototype[i]) place(i, prototype[i] === 1);

// 中盤: 空いている順に埋めて、半分まで順位を進める。
const half = Math.floor(N / 2);
for (let r = ones; r < half; r++) {
  const i = largestVoid();
  rank[i] = r;
  place(i, true);
}

// 後半: 少数派が 0 に入れ替わるので、詰まっている 0 から埋める。
for (let r = half; r < N; r++) {
  const i = tightestZeroCluster();
  rank[i] = r;
  place(i, true);
}

if (rank.some((r) => r < 0)) throw new Error('void-and-cluster left an unranked texel.');

// 順位を 8bit へ均等に写す。タイルの N 段の順位が 256 段へ落ちるが、隣り合う画素の順位は
// 大きく離れているので、局所の打ち消しは保たれる。
const bytes = Buffer.alloc(N);
for (let i = 0; i < N; i++) bytes[i] = Math.min(255, Math.floor(((rank[i] + 0.5) / N) * 256));

const outPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '../src/render/blue-noise-tile.generated.ts',
);

writeFileSync(outPath, `// 生成物。tools/export-blue-noise.mjs が void-and-cluster で焼いた blue noise タイル
// (${SIZE}×${SIZE}、1画素 8bit)。手で編集しない。
//
// 上下左右が繋がる環状のタイルなので、画面へ敷き詰めても継ぎ目が出ない。

export const BLUE_NOISE_TILE_SIZE = ${SIZE};

// タイルの ${N} 画素を、左上から行優先で並べた 8bit 値の base64。
export const BLUE_NOISE_TILE_BASE64 = '${bytes.toString('base64')}';
`);

console.log(`Wrote ${outPath} (${SIZE}x${SIZE}, ${N} texels)`);
