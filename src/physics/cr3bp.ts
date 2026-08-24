// 無次元の円制限三体問題(CR3BP)そのもの。回転系・重心原点で、主天体を (−μ,0,0)、副天体を
// (1−μ,0,0) に置き、長さの単位を両天体間距離、時間の単位を平均運動の逆数(n=1)に取る。
// 運動方程式・ヤコビ定数・状態遷移行列つき数値積分と、xz 面対称性を使った周期軌道の
// 微分修正(ハロー軌道・DRO)を持つ。
// 天体暦・実単位・座標系の写像は扱わず、質量比 μ だけで閉じた力学として書かれている。

// 回転系の状態 [x, y, z, ẋ, ẏ, ż](いずれも無次元)。
export type Cr3bpState = readonly [number, number, number, number, number, number];

// 無次元の位置 [x, y, z]。
export type Vec3Tuple = readonly [number, number, number];

// 微分修正の解。state は xz 面(y=0)を横切る瞬間の状態で、その半周期後に鏡像の横断へ戻る。
export interface SymmetricOrbit {
  readonly state: Cr3bpState;
  readonly period: number;
  readonly jacobi: number;
}

// 微分修正で残差を 0 とみなす、速度スケールに対する相対の許容。
const CORRECTION_TOLERANCE = 1e-12;

const STATE_SIZE = 6;
const STM_SIZE = 36;

// 配列要素の取り出し。範囲外は数値計算の破綻なので静かに 0 を返さず投げる。
function el(v: readonly number[], i: number): number {
  const x = v[i];
  if (x === undefined) throw new RangeError(`cr3bp: 範囲外の要素参照 ${i}`);
  return x;
}

// 42 変数ベクトルの先頭 6 要素を状態として取り出す。
function stateOf(v: readonly number[]): Cr3bpState {
  return [el(v, 0), el(v, 1), el(v, 2), el(v, 3), el(v, 4), el(v, 5)];
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

// 状態 6 変数 + 状態遷移行列 36 変数の合計 42 変数の時間微分。
// STM は行優先で v[6 + 6i + j] = Φ[i][j] に置く。
function variationalDerivative(mu: number, v: readonly number[]): number[] {
  const [x, y, z] = stateOf(v);
  const { dx1, dx2, a, b, a5, b5 } = attraction(mu, x, y, z);
  // 有効ポテンシャルの二階微分(対称行列なので上三角だけ持つ)。
  const uxx = 1 - a - b + a5 * dx1 * dx1 + b5 * dx2 * dx2;
  const uyy = 1 - a - b + a5 * y * y + b5 * y * y;
  const uzz = -a - b + a5 * z * z + b5 * z * z;
  const uxy = a5 * dx1 * y + b5 * dx2 * y;
  const uxz = a5 * dx1 * z + b5 * dx2 * z;
  const uyz = a5 * y * z + b5 * y * z;

  const out = new Array<number>(STATE_SIZE + STM_SIZE);
  const d = cr3bpDerivative(mu, stateOf(v));
  for (let i = 0; i < STATE_SIZE; i++) out[i] = d[i] as number;

  // dΦ/dt = A·Φ。位置行は速度行をそのまま写し、速度行に二階微分とコリオリ項が入る。
  for (let j = 0; j < STATE_SIZE; j++) {
    const px = el(v, 6 + j);
    const py = el(v, 6 + 6 + j);
    const pz = el(v, 6 + 12 + j);
    const qx = el(v, 6 + 18 + j);
    const qy = el(v, 6 + 24 + j);
    const qz = el(v, 6 + 30 + j);
    out[6 + j] = qx;
    out[6 + 6 + j] = qy;
    out[6 + 12 + j] = qz;
    out[6 + 18 + j] = uxx * px + uxy * py + uxz * pz + 2 * qy;
    out[6 + 24 + j] = uxy * px + uyy * py + uyz * pz - 2 * qx;
    out[6 + 30 + j] = uxz * px + uyz * py + uzz * pz;
  }
  return out;
}

// base + scale·delta。
function addScaledVector(base: readonly number[], delta: readonly number[], scale: number): number[] {
  return base.map((value, i) => value + scale * el(delta, i));
}

// 42 変数の RK4 一段。
function rk4Step(mu: number, v: readonly number[], dt: number): number[] {
  const k1 = variationalDerivative(mu, v);
  const k2 = variationalDerivative(mu, addScaledVector(v, k1, dt / 2));
  const k3 = variationalDerivative(mu, addScaledVector(v, k2, dt / 2));
  const k4 = variationalDerivative(mu, addScaledVector(v, k3, dt));
  return v.map((value, i) => value
    + (dt / 6) * (el(k1, i) + 2 * el(k2, i) + 2 * el(k3, i) + el(k4, i)));
}

// 状態 s と単位行列の状態遷移行列を並べた 42 変数ベクトル。
function identityVariational(s: Cr3bpState): number[] {
  const v = new Array<number>(STATE_SIZE + STM_SIZE).fill(0);
  for (let i = 0; i < STATE_SIZE; i++) v[i] = s[i] as number;
  for (let i = 0; i < STATE_SIZE; i++) v[6 + 6 * i + i] = 1;
  return v;
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

// 状態を時間 duration だけ進める。steps は固定刻みの段数。
export function cr3bpPropagate(mu: number, s: Cr3bpState, duration: number, steps: number): Cr3bpState {
  let state = s;
  const dt = duration / steps;
  for (let i = 0; i < steps; i++) state = rk4StateStep(mu, state, dt);
  return state;
}

// y=0 の横断まで進めた結果。stm[i][j] = ∂状態i/∂初期状態j。
interface PlaneCrossing {
  readonly state: Cr3bpState;
  readonly time: number;
  readonly stm: readonly (readonly number[])[];
}

// 出発点 s(y=0 上)から次に y=0 を横切るまで積分する。tMin より手前の横断は出発点自身の
// 数値誤差とみなして読み飛ばし、maxTime までに横切らなければ null。
function crossXzPlane(mu: number, s: Cr3bpState, tMin: number, maxTime: number, steps: number): PlaneCrossing | null {
  let v = identityVariational(s);
  const dt = maxTime / steps;
  let t = 0;
  for (let i = 0; i < steps; i++) {
    const next = rk4Step(mu, v, dt);
    const yNext = el(next, 1);
    if (t + dt > tMin && el(v, 1) * yNext <= 0 && t > 0) {
      // 横断の直前まで戻り、ẏ を使った Newton 法で刻みを詰めて y=0 の瞬間に載せる。
      let refined = v;
      let tRefined = t;
      for (let k = 0; k < 6; k++) {
        const step = -el(refined, 1) / el(refined, 4);
        if (!Number.isFinite(step)) return null;
        refined = rk4Step(mu, refined, step);
        tRefined += step;
        if (Math.abs(el(refined, 1)) < 1e-14) break;
      }
      const stm: number[][] = [];
      for (let r = 0; r < STATE_SIZE; r++) {
        const row: number[] = [];
        for (let c = 0; c < STATE_SIZE; c++) row.push(el(refined, 6 + 6 * r + c));
        stm.push(row);
      }
      return { state: stateOf(refined), time: tRefined, stm };
    }
    v = next;
    t += dt;
  }
  return null;
}

// 状態遷移行列の1要素。
function stmAt(stm: readonly (readonly number[])[], row: number, col: number): number {
  const r = stm[row];
  if (r === undefined) throw new RangeError(`cr3bp: STM の行 ${row} が無い`);
  return el(r, col);
}

// xz 面対称な三次元周期軌道(ハロー軌道)への微分修正。種 seed は y=0 上の
// [x,0,z,0,ẏ,0] 型の状態で、fixed で固定する成分('x' なら z と ẏ を、'z' なら x と ẏ を動かす)
// を選ぶ。半周期後の ẋ・ż を同時に 0 へ落として閉じる。収束しなければ null。
// steps は横断を探す間の積分の刻み数で、副天体へ深く落ちる軌道ほど多く要る。
export function correctHaloOrbit(
  mu: number, seed: Cr3bpState, fixed: 'x' | 'z', halfPeriodGuess: number, steps = 3000,
): SymmetricOrbit | null {
  // 動かす1つ目の成分の添字(fixed='z' なら x、fixed='x' なら z)。
  const freeIndex = fixed === 'z' ? 0 : 2;
  let current: Cr3bpState = [seed[0], 0, seed[2], 0, seed[4], 0];
  for (let iter = 0; iter < 40; iter++) {
    const crossing = crossXzPlane(mu, current, halfPeriodGuess * 0.4, halfPeriodGuess * 3, steps);
    if (crossing === null) return null;
    const [, , , vxEnd, vyEnd] = crossing.state;
    // 残差の許容は速度の桁に合わせる。系によって速度のスケールが桁で違うため、絶対値では
    // 小さい系で収束を取りこぼす。
    const tolerance = CORRECTION_TOLERANCE * Math.abs(vyEnd);
    const solved = { state: current, period: 2 * crossing.time, jacobi: cr3bpJacobi(mu, current) };
    if (Math.abs(vxEnd) < tolerance && Math.abs(crossing.state[5]) < tolerance) return solved;
    // 終端時刻が自由なので、目標量の変分から ẏ 方向の時刻ずれぶんを差し引く。
    const acc = cr3bpDerivative(mu, crossing.state);
    const ax = acc[3];
    const az = acc[5];
    const correctionMatrix = [0, 1].map((k) => {
      const col = k === 0 ? freeIndex : 4;
      const dy = stmAt(crossing.stm, 1, col);
      return [
        stmAt(crossing.stm, 3, col) - (ax / vyEnd) * dy,
        stmAt(crossing.stm, 5, col) - (az / vyEnd) * dy,
      ];
    });
    const m00 = correctionMatrix[0]?.[0] ?? 0;
    const m10 = correctionMatrix[0]?.[1] ?? 0;
    const m01 = correctionMatrix[1]?.[0] ?? 0;
    const m11 = correctionMatrix[1]?.[1] ?? 0;
    const det = m00 * m11 - m01 * m10;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-14) return null;
    const rx = -vxEnd;
    const rz = -crossing.state[5];
    const d0 = (rx * m11 - rz * m01) / det;
    const d1 = (m00 * rz - m10 * rx) / det;
    const next = [...current] as [number, number, number, number, number, number];
    next[freeIndex] += d0;
    next[4] += d1;
    if (!next.every((value) => Number.isFinite(value))) return null;
    // 修正が進まなくなったら、それ以上詰まらない。残差が許容の桁に届いていれば解として返す。
    if (iter > 4 && Math.abs(d0) + Math.abs(d1) < 1e-15) {
      return Math.abs(vxEnd) < 1e3 * tolerance && Math.abs(crossing.state[5]) < 1e3 * tolerance ? solved : null;
    }
    current = next;
  }
  return null;
}

// 面内で x 軸対称な周期軌道(DRO)への微分修正。x0 を固定し、半周期後の ẋ が 0 になる
// ẏ を Newton 法で求める。steps は横断を探す間の積分の刻み数。収束しなければ null。
export function correctPlanarOrbit(
  mu: number, x0: number, vy0: number, halfPeriodGuess: number, steps = 3000,
): SymmetricOrbit | null {
  let vy = vy0;
  // 半周期後の ẋ を ẏ の関数とみなし、状態遷移行列から傾きを取って Newton 法で詰める。
  for (let iter = 0; iter < 40; iter++) {
    const state: Cr3bpState = [x0, 0, 0, 0, vy, 0];
    const crossing = crossXzPlane(mu, state, halfPeriodGuess * 0.4, halfPeriodGuess * 3, steps);
    if (crossing === null) return null;
    const vxEnd = crossing.state[3];
    const tolerance = CORRECTION_TOLERANCE * Math.abs(crossing.state[4]);
    const solved = { state, period: 2 * crossing.time, jacobi: cr3bpJacobi(mu, state) };
    if (Math.abs(vxEnd) < tolerance) return solved;
    const ax = cr3bpDerivative(mu, crossing.state)[3];
    const slope = stmAt(crossing.stm, 3, 4) - (ax / crossing.state[4]) * stmAt(crossing.stm, 1, 4);
    if (!Number.isFinite(slope) || Math.abs(slope) < 1e-14) return null;
    const step = -vxEnd / slope;
    if (iter > 4 && Math.abs(step) < 1e-16) return Math.abs(vxEnd) < 1e3 * tolerance ? solved : null;
    vy += step;
  }
  return null;
}

// 周期軌道を弧長等間隔の点列にする。近点で速度が上がる NRHO でも折れ線の粗密が偏らない。
// 返す点列は閉曲線を一巡し、終点は始点と重ならない。steps は1周を追う積分の刻み数。
export function sampleOrbitByArcLength(
  mu: number, s: Cr3bpState, period: number, samples: number, steps = 4000,
): Vec3Tuple[] {
  // まず細かい刻みで1周を追い、各点までの累積弧長を作る。
  const dt = period / steps;
  let state = s;
  const path: Vec3Tuple[] = [[s[0], s[1], s[2]]];
  const cumulative: number[] = [0];
  for (let i = 0; i < steps; i++) {
    state = rk4StateStep(mu, state, dt);
    const point: Vec3Tuple = [state[0], state[1], state[2]];
    const prev = path[path.length - 1] as Vec3Tuple;
    const seg = Math.hypot(point[0] - prev[0], point[1] - prev[1], point[2] - prev[2]);
    cumulative.push(el(cumulative, cumulative.length - 1) + seg);
    path.push(point);
  }

  // 累積弧長を等分する位置を、折れ線上の内分点として拾い直す。
  const total = el(cumulative, cumulative.length - 1);
  const out: Vec3Tuple[] = [];
  let cursor = 0;
  for (let i = 0; i < samples; i++) {
    const target = (total * i) / samples;
    while (cursor < cumulative.length - 2 && el(cumulative, cursor + 1) < target) cursor++;
    const s0 = el(cumulative, cursor);
    const s1 = el(cumulative, cursor + 1);
    const f = s1 > s0 ? (target - s0) / (s1 - s0) : 0;
    const p0 = path[cursor] as Vec3Tuple;
    const p1 = path[cursor + 1] as Vec3Tuple;
    out.push([
      p0[0] + f * (p1[0] - p0[0]),
      p0[1] + f * (p1[1] - p0[1]),
      p0[2] + f * (p1[2] - p0[2]),
    ]);
  }
  return out;
}

