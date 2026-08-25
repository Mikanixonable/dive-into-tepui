// 円制限三体問題(CR3BP)のゼロ速度曲線。回転系・重心原点・両天体間距離を1とする無次元系
// (`cr3bp.ts` と同じ流儀。主天体は (−μ,0,0)、副天体は (1−μ,0,0))で、擬ポテンシャル
// Ω(x,y,z) = (x²+y²)/2 + (1−μ)/r₁ + μ/r₂ とヤコビ定数 C = 2Ω − v² を扱う。
// v² = 2Ω − C ≥ 0 が到達可能領域、2Ω − C < 0 が禁止領域なので、ゼロ速度曲線は
// 断面上で f(u,v) = 2Ω − C = 0 となる等高線そのもの。マーチングスクエア法で追う。
import { collinearGamma } from './lagrange';

export type LagrangeLabel = 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
export type SectionPlane = 'xy' | 'xz';

// 両天体の位置ちょうどで 1/r が発散するのを避けるための下限。この桁まで近づけば
// Ω はどのみち C の取りうる範囲(O(1〜10))を遥かに超えるので、クリップしても
// 「発散する側は必ず到達可能」という結論は変わらない。
const MIN_DISTANCE = 1e-6;

// 擬ポテンシャル Ω(x,y,z)。z は遠心力項に現れない(回転軸が z 方向のため)。
export function pseudoPotential(mu: number, x: number, y: number, z: number): number {
  const dx1 = x + mu;
  const dx2 = x - 1 + mu;
  const r1 = Math.max(Math.sqrt(dx1 * dx1 + y * y + z * z), MIN_DISTANCE);
  const r2 = Math.max(Math.sqrt(dx2 * dx2 + y * y + z * z), MIN_DISTANCE);
  return (x * x + y * y) / 2 + (1 - mu) / r1 + mu / r2;
}

// ヤコビ定数 C = 2Ω − v²。
export function jacobiConstant(
  mu: number, x: number, y: number, z: number, vx: number, vy: number, vz: number,
): number {
  return 2 * pseudoPotential(mu, x, y, z) - (vx * vx + vy * vy + vz * vz);
}

// ラグランジュ点でのヤコビ定数。L1〜L3 は共線点の位置(y=z=0)を Ω に代入する。
// L4/L5 は正三角配置(距離1)の閉じた式 3−μ+μ² で、速度0の点なので C=2Ω と一致する。
export function lagrangeJacobi(mu: number, point: LagrangeLabel): number {
  if (point === 'L4' || point === 'L5') return 3 - mu + mu * mu;
  // collinearGamma は主天体を原点とする距離比なので、pseudoPotential が使う重心原点系
  // (主天体は (−μ,0,0))へ −μ だけ平行移動してから代入する。
  const x = point === 'L1' ? 1 - collinearGamma(mu, 'L1') - mu
    : point === 'L2' ? 1 + collinearGamma(mu, 'L2') - mu
    : -collinearGamma(mu, 'L3') - mu;
  return 2 * pseudoPotential(mu, x, 0, 0);
}

// 断面上の格子点の座標を計算する。'xy' は z=0 の面(u=x, v=y)、'xz' は y=0 の面(u=x, v=z)。
function sectionValue(mu: number, plane: SectionPlane, u: number, v: number): number {
  return plane === 'xy' ? pseudoPotential(mu, u, v, 0) : pseudoPotential(mu, u, 0, v);
}

type Point = readonly [number, number];

// 格子上の1辺の識別子。横辺は行(v一定)・縦辺は列(u一定)のインデックスで一意に決まり、
// 隣り合うセルは同じ辺 id を共有するので、これをノードにしてセグメントを繋げられる。
function hEdgeId(i: number, j: number): string {
  return `h:${i},${j}`;
}

// 縦辺の識別子。
function vEdgeId(i: number, j: number): string {
  return `v:${i},${j}`;
}

// 辺の両端の f の符号が異なるとき、線形補間で f=0 となる位置を返す。同符号なら null。
// f=0 ちょうどのケースは片側(>=0)に含めて曖昧さを避ける(測度0なので結果に影響しない)。
function interpolateCrossing(fa: number, fb: number, pa: Point, pb: Point): Point | null {
  const insideA = fa >= 0;
  const insideB = fb >= 0;
  if (insideA === insideB) return null;
  const t = fa / (fa - fb);
  return [pa[0] + t * (pb[0] - pa[0]), pa[1] + t * (pb[1] - pa[1])];
}

// 断面上のゼロ速度曲線を、連結成分(折れ線)ごとに求める。
//
// 実装方針:
// 1. 格子の各セルについて、四辺のうち符号が変わる辺の交点(線形補間)を求める。
// 2. 交点が2つなら、その2点を結ぶ1セグメントを作る。
// 3. 交点が4つ(対角の2隅だけが到達可能/禁止で、残る対角が逆の曖昧セル)は、セル中心の値
//    (四隅の平均で近似)の符号で分ける。中心が到達可能側なら、対角の到達可能な2隅を
//    「繋げる」向き(縦横それぞれの相手隅と組む)を選び、中心が禁止側なら「切り離す」向き
//    (各隅を独立した島として孤立させる向き)を選ぶ。これは正式な漸近判定(双一次補間の
//    鞍点値を使う判定)の簡略版だが、格子を十分細かく取れば同じ結果になる。
// 4. セグメントは辺 id をノードとするグラフになる(1つの辺は高々2つのセル — 両隣 — から
//    参照されるので、次数は高々2)。次数1のノード(格子の縁で切れる開いた成分)から辿って
//    折れ線を作り、残った次数2のみのノードは閉じた輪として辿る。
export function zeroVelocityCurves(
  mu: number, jacobi: number, plane: SectionPlane, half: number, resolution: number,
): readonly (readonly (readonly [number, number])[])[] {
  const n = resolution * 2;
  const step = half / resolution;

  // 格子点の座標と f = 2Ω − C の値を先に埋める。
  const coords: number[] = [];
  for (let i = 0; i <= n; i++) coords.push(-half + i * step);
  const f: number[][] = [];
  for (let i = 0; i <= n; i++) {
    const row: number[] = [];
    const u = coords[i] as number;
    for (let j = 0; j <= n; j++) {
      const v = coords[j] as number;
      row.push(2 * sectionValue(mu, plane, u, v) - jacobi);
    }
    f.push(row);
  }

  // (id, 位置) のペアをグラフのノードとして蓄積し、セグメントを (idA, idB) の対で集める。
  const positions = new Map<string, Point>();
  const segments: [string, string][] = [];

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const u0 = coords[i] as number;
      const u1 = coords[i + 1] as number;
      const v0 = coords[j] as number;
      const v1 = coords[j + 1] as number;
      const f00 = (f[i] as number[])[j] as number;
      const f10 = (f[i + 1] as number[])[j] as number;
      const f11 = (f[i + 1] as number[])[j + 1] as number;
      const f01 = (f[i] as number[])[j + 1] as number;

      // 四辺: 下(bottom)・右(right)・上(top)・左(left)。それぞれの交点(あれば)。
      const bottom = interpolateCrossing(f00, f10, [u0, v0], [u1, v0]);
      const right = interpolateCrossing(f10, f11, [u1, v0], [u1, v1]);
      const top = interpolateCrossing(f01, f11, [u0, v1], [u1, v1]);
      const left = interpolateCrossing(f00, f01, [u0, v0], [u0, v1]);

      const idBottom = hEdgeId(i, j);
      const idTop = hEdgeId(i, j + 1);
      const idLeft = vEdgeId(i, j);
      const idRight = vEdgeId(i + 1, j);

      if (bottom) positions.set(idBottom, bottom);
      if (top) positions.set(idTop, top);
      if (left) positions.set(idLeft, left);
      if (right) positions.set(idRight, right);

      const crossings = [bottom !== null, right !== null, top !== null, left !== null]
        .filter(Boolean).length;

      if (crossings === 2) {
        // 交点をちょうど2つ持つ辺同士を繋ぐ(2つしかないので選択の余地はない)。
        const ids = [
          bottom && idBottom, right && idRight, top && idTop, left && idLeft,
        ].filter((id): id is string => Boolean(id));
        segments.push([ids[0] as string, ids[1] as string]);
      } else if (crossings === 4) {
        // 曖昧セル。対角 (f00,f11) と (f10,f01) が互いに逆符号のときに起こる。
        const center = (f00 + f10 + f11 + f01) / 4;
        const diag00Inside = f00 >= 0;
        // 中心の符号が (f00,f11) の対角と同じなら、その対角側が中心を通って繋がっている。
        // すると曲線は残る2隅(f10 と f01)をそれぞれ切り離す向きに走るので、左辺-上辺と
        // 右辺-下辺の組になる。中心が逆符号なら、繋がる対角が入れ替わって組も入れ替わる。
        if ((center >= 0) === diag00Inside) {
          segments.push([idLeft, idTop]);
          segments.push([idRight, idBottom]);
        } else {
          segments.push([idLeft, idBottom]);
          segments.push([idRight, idTop]);
        }
      }
      // crossings === 0 はこのセルに曲線が通らないので何もしない。
    }
  }

  return traceComponents(segments, positions);
}

// セグメントのグラフを辿って連結成分ごとの折れ線にする。
function traceComponents(
  segments: readonly [string, string][], positions: ReadonlyMap<string, Point>,
): (readonly Point[])[] {
  const adjacency = new Map<string, { neighbor: string; segIndex: number }[]>();
  for (let i = 0; i < segments.length; i++) {
    const [a, b] = segments[i] as [string, string];
    if (!adjacency.has(a)) adjacency.set(a, []);
    if (!adjacency.has(b)) adjacency.set(b, []);
    (adjacency.get(a) as { neighbor: string; segIndex: number }[]).push({ neighbor: b, segIndex: i });
    (adjacency.get(b) as { neighbor: string; segIndex: number }[]).push({ neighbor: a, segIndex: i });
  }

  const usedSegments = new Set<number>();
  const components: Point[][] = [];

  // 未使用の辺のうち次数1のもの(次のセグメントが1本しかない)から出発し、
  // 開いた成分(格子の縁で切れる折れ線)を先に確定させる。
  const nodes = [...adjacency.keys()];
  for (const start of nodes) {
    const startEdges = adjacency.get(start) as { neighbor: string; segIndex: number }[];
    const unusedFromStart = startEdges.filter((e) => !usedSegments.has(e.segIndex));
    if (unusedFromStart.length !== 1) continue;
    const path = walkChain(start, adjacency, usedSegments);
    if (path.length >= 2) components.push(path.map((id) => positions.get(id) as Point));
  }

  // 残りは次数2のみの閉じた輪。未使用のセグメントを見つけるたびに一周分を辿る。
  for (let i = 0; i < segments.length; i++) {
    if (usedSegments.has(i)) continue;
    const [start] = segments[i] as [string, string];
    const path = walkChain(start, adjacency, usedSegments);
    if (path.length >= 2) components.push(path.map((id) => positions.get(id) as Point));
  }

  return components;
}

// start から、未使用のセグメントがある限り隣接ノードへ進み続けて経路(ノード id の列)を返す。
// 開いた成分は次数1のノードで自然に止まり、閉じた輪は start へ戻ってきた時点で打ち切る。
function walkChain(
  start: string,
  adjacency: ReadonlyMap<string, { neighbor: string; segIndex: number }[]>,
  usedSegments: Set<number>,
): string[] {
  const path = [start];
  let current = start;
  for (;;) {
    // 現在のノードから未使用のセグメントを1本選んで進む。無ければそこで経路は終わり。
    const edges = adjacency.get(current) as { neighbor: string; segIndex: number }[];
    const next = edges.find((e) => !usedSegments.has(e.segIndex));
    if (!next) break;
    usedSegments.add(next.segIndex);
    current = next.neighbor;
    path.push(current);
    if (current === start) break; // 輪が閉じた。
  }
  return path;
}
