// 無次元の円制限三体問題(CR3BP)そのもの。回転系・重心原点で、主天体を (−μ,0,0)、副天体を
// (1−μ,0,0) に置き、長さの単位を両天体間距離、時間の単位を平均運動の逆数(n=1)に取る。
// 運動方程式・ヤコビ定数つき数値積分を持つ。質量比 μ だけで閉じた力学として書かれている。

// 回転系の状態 [x, y, z, ẋ, ẏ, ż](いずれも無次元)。
export type Cr3bpState = readonly [number, number, number, number, number, number];

// 無次元の位置 [x, y, z]。
export type Vec3Tuple = readonly [number, number, number];

// 配列要素の取り出し。範囲外は数値計算の破綻なので静かに 0 を返さず投げる。
function el(v: readonly number[], i: number): number {
  const x = v[i];
  if (x === undefined) throw new RangeError(`cr3bp: 範囲外の要素参照 ${i}`);
  return x;
}

// 主天体・副天体それぞれからの距離と、その逆三乗・逆五乗。重力項と二階微分の共通因子。
function attraction(mu: number, x: number, y: number, z: number) {
  // 主天体は (-mu,0,0)、副天体は (1-mu,0,0) に固定されている。
  const dx1 = x + mu;
  const dx2 = x - 1 + mu;
  const r1 = Math.sqrt(dx1 * dx1 + y * y + z * z);
  const r2 = Math.sqrt(dx2 * dx2 + y * y + z * z);
  return {
    dx1, dx2, r1, r2,
    a: (1 - mu) / r1 ** 3,
    b: mu / r2 ** 3,
    a5: 3 * (1 - mu) / r1 ** 5,
    b5: 3 * mu / r2 ** 5,
  };
}

// 状態の時間微分。回転系の遠心力項 (x,y) とコリオリ項 (±2ẏ, ∓2ẋ) を含む。
export function cr3bpDerivative(mu: number, s: Cr3bpState): Cr3bpState {
  const [x, y, z, vx, vy, vz] = s;
  const { dx1, dx2, a, b } = attraction(mu, x, y, z);
  return [
    vx, vy, vz,
    2 * vy + x - a * dx1 - b * dx2,
    -2 * vx + y - a * y - b * y,
    -a * z - b * z,
  ];
}

// ヤコビ定数 C = 2Ω − v²。閉軌道に沿って保存するので、積分誤差の目安にも使える。
export function cr3bpJacobi(mu: number, s: Cr3bpState): number {
  const [x, y, z, vx, vy, vz] = s;
  const { r1, r2 } = attraction(mu, x, y, z);
  const omega = (x * x + y * y) / 2 + (1 - mu) / r1 + mu / r2;
  return 2 * omega - (vx * vx + vy * vy + vz * vz);
}

// 6 変数の RK4 一段。
function rk4StateStep(mu: number, s: Cr3bpState, dt: number): Cr3bpState {
  const shift = (base: Cr3bpState, k: Cr3bpState, f: number): Cr3bpState => [
    base[0] + f * k[0], base[1] + f * k[1], base[2] + f * k[2],
    base[3] + f * k[3], base[4] + f * k[4], base[5] + f * k[5],
  ];
  // 4 つの傾きを求め、1:2:2:1 の重みで合成する。
  const k1 = cr3bpDerivative(mu, s);
  const k2 = cr3bpDerivative(mu, shift(s, k1, dt / 2));
  const k3 = cr3bpDerivative(mu, shift(s, k2, dt / 2));
  const k4 = cr3bpDerivative(mu, shift(s, k3, dt));
  const combine = (i: 0 | 1 | 2 | 3 | 4 | 5): number =>
    s[i] + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
  return [combine(0), combine(1), combine(2), combine(3), combine(4), combine(5)];
}

// 折れ線を弧長で等分したときの、各サンプル点が乗る辺と、その辺上の内分比。位置も時刻も
// この同じ割り当てから作れるので、弧長の累積は1度しか計算しない。
interface ResampleSpot {
  readonly edge: number;
  readonly frac: number;
}

// 折れ線を弧長等間隔の samples 点へ割り当てる。closeLoop なら末尾から先頭へ戻る辺も曲線の
// 一部とみなす。返す点は始点から等間隔で、終点は始点と重ならない。
function resampleSpots(path: readonly Vec3Tuple[], samples: number, closeLoop: boolean): ResampleSpot[] {
  const edges = closeLoop ? path.length : path.length - 1;
  // 各頂点までの累積弧長。閉じる場合は戻る辺のぶんだけ末尾が1つ伸びる。
  const cumulative: number[] = [0];
  for (let i = 1; i <= edges; i++) {
    const a = pointAt(path, i - 1);
    const b = pointAt(path, i % path.length);
    cumulative.push(el(cumulative, i - 1) + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }

  const total = el(cumulative, edges);
  const out: ResampleSpot[] = [];
  let cursor = 0;
  for (let i = 0; i < samples; i++) {
    const target = (total * i) / samples;
    while (cursor < edges - 1 && el(cumulative, cursor + 1) < target) cursor++;
    const s0 = el(cumulative, cursor);
    const s1 = el(cumulative, cursor + 1);
    out.push({ edge: cursor, frac: s1 > s0 ? (target - s0) / (s1 - s0) : 0 });
  }
  return out;
}

// 折れ線の頂点の取り出し。範囲外は呼び出し側の索引計算の破綻なので投げる。
function pointAt(path: readonly Vec3Tuple[], i: number): Vec3Tuple {
  const p = path[i];
  if (p === undefined) throw new RangeError(`cr3bp: 範囲外の頂点参照 ${i}`);
  return p;
}

// 周期軌道を弧長等間隔の点列にする。近点で速度が上がる NRHO でも折れ線の粗密が偏らない。
// 返す点列は閉曲線を一巡し、終点は始点と重ならない。steps は1周を追う積分の刻み数。
export function sampleOrbitByArcLength(
  mu: number, s: Cr3bpState, period: number, samples: number, steps = 4000,
): Vec3Tuple[] {
  return sampleOrbitByArcLengthWithTime(mu, s, period, samples, steps)
    .map(([x, y, z]) => [x, y, z]);
}

// 位置 [x, y, z] と、その点までの経過時刻を周期で割った割合 [0, 1) を並べた4要素。
export type Vec3TimeTuple = readonly [number, number, number, number];

// sampleOrbitByArcLength と同じく弧長等間隔の点列を作るが、各点に「その点までの経過時刻 ÷ 周期」
// (0..1)を併記する。進行方向マーカーを実際の軌道速度に比例して動かすために使う — 弧長等間隔の
// 点は近点付近で間引かれるため、点の添字を時刻の代わりに使うと近点で速く・遠点で遅く動く表現が
// できない。steps は1周を追う積分の刻み数。
export function sampleOrbitByArcLengthWithTime(
  mu: number, s: Cr3bpState, period: number, samples: number, steps = 4000,
): Vec3TimeTuple[] {
  // 細かい刻みで1周を追う。終端は始点へ戻ってくるので、閉じる辺を足さずに等分する。
  const dt = period / steps;
  let state = s;
  const path: Vec3Tuple[] = [[s[0], s[1], s[2]]];
  for (let i = 0; i < steps; i++) {
    state = rk4StateStep(mu, state, dt);
    path.push([state[0], state[1], state[2]]);
  }

  // 位置と時刻は同じ弧長の割り当てから作る。i 番目の頂点の時刻は i*dt なので、辺と内分比が
  // 決まれば時刻もそのまま内分できる。
  return resampleSpots(path, samples, false).map(({ edge, frac }) => {
    const p0 = pointAt(path, edge);
    const p1 = pointAt(path, edge + 1);
    return [
      p0[0] + frac * (p1[0] - p0[0]),
      p0[1] + frac * (p1[1] - p0[1]),
      p0[2] + frac * (p1[2] - p0[2]),
      ((edge + frac) * dt) / period,
    ] as Vec3TimeTuple;
  });
}

